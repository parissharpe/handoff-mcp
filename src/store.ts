/**
 * store.ts — ChromaDB adapter for handoff-mcp.
 *
 * CONNECTION MODE: server (HTTP), NOT embedded.
 * ----------------------------------------------------------------------------
 * The `chromadb` npm client (v3.x) does NOT embed a persistent store in-process
 * the way Python's `PersistentClient` does. It only exposes `ChromaClient` /
 * `CloudClient`, both of which talk to a Chroma server over HTTP. There is no
 * exported `PersistentClient` / `EmbeddedClient` class.
 *
 * Persistence therefore lives in the *server*, which is started with
 * `chroma run --path <HANDOFF_STORE_PATH>`. That server reads/writes the on-disk
 * database under HANDOFF_STORE_PATH, which is the same directory the Python
 * watcher persists into — so both processes share one store on disk.
 *
 * On Windows x64 the chromadb 3.4.3 bundled CLI has a packaging bug: its arch
 * guard only accepts win32-arm64 and throws for x64, even though it ships a
 * working `chromadb-js-bindings-win32-x64-msvc` native addon. `startLocalServer`
 * below loads that native binding directly (bypassing the broken guard) so a
 * local server can still be spawned on Windows x64. On other platforms it falls
 * back to the standard `chroma` CLI binary.
 *
 * EMBEDDINGS: fully local, no API key. The default embedding function
 * (`@chroma-core/default-embed`, an ONNX all-MiniLM-L6-v2 model) runs in this
 * Node process. No OpenAI/Anthropic key is required. That package is installed
 * as a dependency.
 *
 * RUNTIME PREREQUISITE: a reachable Chroma server. Use `ensureServer()` to get
 * one with no fuss — it connects to an already-running server if it can find one
 * and otherwise starts a single shared server backed by HANDOFF_STORE_PATH.
 *
 * SERVER COORDINATION (server.json): so the MCP server and the Python watchers
 * all talk to ONE server (rather than each starting their own and colliding on a
 * port), the process that starts a server writes a small endpoint file at
 * <HANDOFF_STORE_PATH>/server.json: { host, port, pid, startedAt }. Other
 * processes read it to discover where to connect. The file is advisory — every
 * consumer heartbeat-checks the endpoint before trusting it, so a stale file
 * left by a crash is harmless (the next start overwrites it). Explicit
 * CHROMA_HOST / CHROMA_PORT env vars always win over the file.
 *
 * SHUTDOWN: stopping a server we started is graceful-first (request close, wait
 * for the port to be released) and force-kills only as a fallback, so the next
 * start doesn't race a half-dead predecessor.
 *
 * METADATA CONTRACT (shared with the Python watcher):
 *   - Every document's metadata carries `created_at`: an ISO-8601 string.
 *   - `listRecent` sorts by `created_at` descending.
 *   - ChromaDB metadata values must be primitives (string/number/bool), so
 *     array-valued `tags` are stored as a comma-joined STRING under the `tags`
 *     key (e.g. ["a","b"] -> "a,b"). Consumers should split on "," to recover
 *     the list. Empty tag lists are stored as "".
 */

import { ChromaClient, type Metadata } from "chromadb";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** The three known collections the handoff system uses. */
export const KNOWN_COLLECTIONS = [
  "cowork_sessions",
  "code_sessions",
  "strategist_memory",
] as const;

/** A single result row returned by `query` / `listRecent`. */
export interface StoreRecord {
  id: string;
  document: string | null;
  metadata: Record<string, unknown> | null;
  /** Similarity distance (lower = closer). Present for `query`, omitted for `listRecent`. */
  distance?: number | null;
}

/**
 * Resolve the on-disk store path from HANDOFF_STORE_PATH, defaulting to
 * ~/.handoff/db. Expands a leading "~" to the OS home dir and ensures the
 * directory exists. Returned for callers that spawn a server against it.
 */
export function resolveStorePath(): string {
  const raw = process.env.HANDOFF_STORE_PATH;
  let resolved: string;
  if (raw && raw.trim().length > 0) {
    resolved =
      raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
        ? path.join(os.homedir(), raw.slice(1))
        : raw;
  } else {
    resolved = path.join(os.homedir(), ".handoff", "db");
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Describes where a Chroma server is reachable. */
export interface Endpoint {
  host: string;
  port: number;
  pid?: number;
  startedAt?: string;
}

const DEFAULT_PORT = 8000;

/** Path to the advisory endpoint file inside the store directory. */
export function endpointFilePath(storePath = resolveStorePath()): string {
  return path.join(storePath, "server.json");
}

/** Read the endpoint file, or null if missing/unparseable. */
export function readEndpoint(storePath = resolveStorePath()): Endpoint | null {
  try {
    const raw = fs.readFileSync(endpointFilePath(storePath), "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj.port === "number") {
      return {
        host: typeof obj.host === "string" ? obj.host : "localhost",
        port: obj.port,
        pid: typeof obj.pid === "number" ? obj.pid : undefined,
        startedAt: typeof obj.startedAt === "string" ? obj.startedAt : undefined,
      };
    }
  } catch {
    // missing or malformed -> treat as absent
  }
  return null;
}

function writeEndpoint(storePath: string, ep: Endpoint): void {
  try {
    fs.writeFileSync(endpointFilePath(storePath), JSON.stringify(ep, null, 2));
  } catch {
    // best-effort; coordination still works via heartbeat probing
  }
}

function removeEndpoint(storePath: string): void {
  try {
    fs.rmSync(endpointFilePath(storePath), { force: true });
  } catch {
    // ignore
  }
}

/** True if a Chroma server answers its heartbeat at host:port. */
export async function heartbeatOk(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://${host}:${port}/api/v2/heartbeat`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/** True if nothing is currently listening on the TCP port (i.e. it's free). */
function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** Ask the OS for an available ephemeral port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors that indicate the server is up but not yet ready / momentarily flaky. */
function isTransient(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return /ChromaConnection|Failed to connect|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|503|502/i.test(
    msg,
  );
}

/** Retry `fn` on transient connection errors with linear backoff. */
async function retry<T>(fn: () => Promise<T>, attempts = 6, baseMs = 300): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      await sleep(baseMs * (i + 1));
    }
  }
  throw lastErr;
}

function serializeTags(tags: string[]): string {
  return tags.join(",");
}

/** Convert a Chroma metadata object back into a plain record. */
function normalizeMetadata(
  meta: Metadata | null | undefined,
): Record<string, unknown> | null {
  if (!meta) return null;
  return { ...meta } as Record<string, unknown>;
}

/**
 * ChromaDB-backed document store. Lazily connects to the configured Chroma
 * server and get-or-creates collections on demand.
 */
export class Store {
  private readonly client: ChromaClient;
  private readonly collections = new Map<
    string,
    Promise<Awaited<ReturnType<ChromaClient["getOrCreateCollection"]>>>
  >();

  constructor(args?: { host?: string; port?: number; ssl?: boolean }) {
    const host = args?.host ?? process.env.CHROMA_HOST ?? "localhost";
    const port =
      args?.port ??
      (process.env.CHROMA_PORT ? Number(process.env.CHROMA_PORT) : 8000);
    const ssl = args?.ssl ?? false;
    this.client = new ChromaClient({ host, port, ssl });
  }

  /** Lazily get-or-create a collection by name (cached per instance).
   *  Rejected promises are NOT cached, so a transient failure (e.g. the server
   *  not yet ready) doesn't poison the cache for the lifetime of the Store. */
  private getCollection(name: string) {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = this.client.getOrCreateCollection({ name });
      existing.catch(() => this.collections.delete(name));
      this.collections.set(name, existing);
    }
    return existing;
  }

  /**
   * Add a document to `collection`, returning the id used. A `created_at`
   * ISO-8601 timestamp is merged into the metadata if not already present.
   */
  async addDocument(
    collection: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    const id = randomUUID();
    const meta: Metadata = {
      ...(metadata as Metadata),
      created_at:
        (metadata.created_at as string | undefined) ?? new Date().toISOString(),
    };
    return retry(async () => {
      const col = await this.getCollection(collection);
      await col.add({ ids: [id], documents: [content], metadatas: [meta] });
      return id;
    });
  }

  /**
   * Semantic/text query against `collection`. Returns up to `n` results,
   * each with its document, metadata, id, and similarity distance.
   */
  async query(
    collection: string,
    queryText: string,
    n: number,
  ): Promise<StoreRecord[]> {
    return retry(async () => {
      const col = await this.getCollection(collection);
      const res = await col.query({ queryTexts: [queryText], nResults: n });
      const ids = res.ids[0] ?? [];
      const documents = res.documents[0] ?? [];
      const metadatas = res.metadatas[0] ?? [];
      const distances = res.distances[0] ?? [];
      return ids.map((id, i) => ({
        id,
        document: documents[i] ?? null,
        metadata: normalizeMetadata(metadatas[i]),
        distance: distances[i] ?? null,
      }));
    });
  }

  /**
   * Return the `n` most recently added documents in `collection`, sorted by
   * the `created_at` metadata field descending. Fetches all documents then
   * sorts client-side (Chroma has no native order-by on metadata).
   */
  async listRecent(collection: string, n: number): Promise<StoreRecord[]> {
    return retry(async () => {
      const col = await this.getCollection(collection);
      const res = await col.get({ include: ["documents", "metadatas"] as never });
      const records: StoreRecord[] = res.ids.map((id, i) => ({
        id,
        document: res.documents[i] ?? null,
        metadata: normalizeMetadata(res.metadatas[i]),
      }));
      records.sort((a, b) => {
        const aT = String(a.metadata?.created_at ?? "");
        const bT = String(b.metadata?.created_at ?? "");
        return bT.localeCompare(aT);
      });
      return records.slice(0, n);
    });
  }

  /**
   * Convenience writer for strategist findings. Stores `content` with metadata
   * { tags: "<comma-joined>", created_at: <ISO-8601>, type: "finding" } and
   * returns the generated id.
   */
  async write(
    collection: string,
    content: string,
    tags: string[],
  ): Promise<string> {
    return this.addDocument(collection, content, {
      tags: serializeTags(tags),
      created_at: new Date().toISOString(),
      type: "finding",
    });
  }
}

/** Stop a server process by pid: graceful-first, force fallback, then wait for
 *  the port to actually free so a subsequent start can't race a half-dead one. */
async function stopServer(
  proc: ChildProcess,
  port: number,
  storePath: string,
): Promise<void> {
  removeEndpoint(storePath);
  const pid = proc.pid;
  if (pid === undefined) return;

  const waitForPortFree = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await isPortFree(port)) return true;
      await sleep(150);
    }
    return false;
  };

  // 1) Graceful request.
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T"], { stdio: "ignore" });
  } else {
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  }
  if (await waitForPortFree(5000)) return;

  // 2) Force fallback.
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
  await waitForPortFree(3000);
}

/**
 * Spawn a local Chroma server backed by HANDOFF_STORE_PATH.
 *
 * On Windows x64 the bundled `chroma` CLI is broken (arch guard rejects x64),
 * so we load the native binding directly in a tiny child process. On other
 * platforms we shell out to the `chroma` binary.
 *
 * Port selection: explicit opts.port > CHROMA_PORT env > 8000 (if free) > a
 * free ephemeral port. After the server answers its heartbeat we also wait for
 * the API to be READY (listCollections succeeds) so callers never read against a
 * half-initialized server, then write the advisory server.json endpoint file.
 * The returned `stop` is graceful-first.
 */
export async function startLocalServer(opts?: {
  storePath?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<{
  proc: ChildProcess;
  host: string;
  port: number;
  stop: () => Promise<void>;
}> {
  const storePath = opts?.storePath ?? resolveStorePath();
  const host = opts?.host ?? process.env.CHROMA_HOST ?? "localhost";
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  let port: number;
  if (opts?.port !== undefined) {
    port = opts.port;
  } else if (process.env.CHROMA_PORT) {
    port = Number(process.env.CHROMA_PORT);
  } else {
    port = (await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : await getFreePort();
  }

  let proc: ChildProcess;
  if (process.platform === "win32" && process.arch === "x64") {
    // Bypass the broken CLI arch guard by loading the native binding directly.
    const bootstrap = [
      "const { createRequire } = require('node:module');",
      "const require2 = createRequire(process.env.HANDOFF_REQUIRE_BASE);",
      "const b = require('chromadb-js-bindings-win32-x64-msvc');",
      "b.cli(['chroma','run','--path',process.env.HANDOFF_CHROMA_PATH,",
      "'--host',process.env.HANDOFF_CHROMA_HOST,'--port',process.env.HANDOFF_CHROMA_PORT]);",
    ].join("");
    proc = spawn(process.execPath, ["-e", bootstrap], {
      env: {
        ...process.env,
        // createRequire needs a base inside this project to resolve the binding.
        HANDOFF_REQUIRE_BASE: path.join(process.cwd(), "package.json"),
        HANDOFF_CHROMA_PATH: storePath,
        HANDOFF_CHROMA_HOST: host,
        HANDOFF_CHROMA_PORT: String(port),
      },
      stdio: "ignore",
    });
  } else {
    const require = createRequire(import.meta.url);
    const cliPath = require.resolve("chromadb/dist/cli.mjs");
    proc = spawn(
      process.execPath,
      [cliPath, "run", "--path", storePath, "--host", host, "--port", String(port)],
      { stdio: "ignore" },
    );
  }

  const deadline = Date.now() + timeoutMs;
  // Poll heartbeat until the server is up.
  while (!(await heartbeatOk(host, port))) {
    if (Date.now() > deadline) {
      await stopServer(proc, port, storePath);
      throw new Error(
        `Chroma server did not become ready on http://${host}:${port} within ${timeoutMs}ms`,
      );
    }
    await sleep(250);
  }

  // Readiness gate: heartbeat can answer before the API/tenant is fully serving.
  // Confirm a real API call succeeds before declaring the server usable.
  const probe = new ChromaClient({ host, port, ssl: false });
  try {
    await retry(() => probe.listCollections(), 12, 250);
  } catch (err) {
    await stopServer(proc, port, storePath);
    throw new Error(
      `Chroma server on http://${host}:${port} never became ready: ${String(
        (err as { message?: string })?.message ?? err,
      )}`,
    );
  }

  writeEndpoint(storePath, {
    host,
    port,
    pid: proc.pid,
    startedAt: new Date().toISOString(),
  });

  return {
    proc,
    host,
    port,
    stop: () => stopServer(proc, port, storePath),
  };
}

/**
 * Get a usable Chroma endpoint with minimal fuss.
 *
 * Resolution order:
 *   1. An explicit CHROMA_HOST/CHROMA_PORT endpoint, if it answers a heartbeat.
 *   2. The server.json endpoint file, if it answers a heartbeat.
 *   3. Otherwise start a new shared server (which writes server.json).
 *
 * Returns the endpoint, whether we started it, and a `stop` that is a no-op when
 * we connected to a server someone else owns (so callers can always call stop).
 */
export async function ensureServer(opts?: { storePath?: string }): Promise<{
  endpoint: Endpoint;
  started: boolean;
  stop: () => Promise<void>;
}> {
  const storePath = opts?.storePath ?? resolveStorePath();
  const envHost = process.env.CHROMA_HOST;
  const envPort = process.env.CHROMA_PORT
    ? Number(process.env.CHROMA_PORT)
    : undefined;

  const candidates: Endpoint[] = [];
  if (envHost || envPort) {
    candidates.push({ host: envHost ?? "localhost", port: envPort ?? DEFAULT_PORT });
  }
  const fileEp = readEndpoint(storePath);
  if (fileEp) candidates.push(fileEp);

  for (const ep of candidates) {
    if (await heartbeatOk(ep.host, ep.port)) {
      return { endpoint: ep, started: false, stop: async () => {} };
    }
  }

  const handle = await startLocalServer({
    storePath,
    host: envHost ?? "localhost",
    port: envPort, // undefined => startLocalServer picks 8000-or-free
  });
  return {
    endpoint: { host: handle.host, port: handle.port },
    started: true,
    stop: handle.stop,
  };
}
