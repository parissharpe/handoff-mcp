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
 *   - `listRecent` sorts by best-available CONTENT time: `turn_timestamp`,
 *     then `modified_at`, then `created_at`, descending. See `recencyKey`.
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

/**
 * Read an environment variable, treating empty/whitespace-only as unset.
 *
 * MCP hosts commonly materialize optional config as `""` rather than omitting
 * the key. Plain `??` only guards `undefined`, so `CHROMA_HOST=""` used to slip
 * through and produce an endpoint like "http://:8000".
 */
export function envVar(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Numeric form of `envVar`; returns undefined when unset or not a finite number. */
export function envNum(name: string): number | undefined {
  const raw = envVar(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * True when `error` looks like the Chroma endpoint being unreachable, rather
 * than a bad request. Used to decide whether a cached client is worth
 * discarding and re-resolving — see `getStore` in index.ts.
 *
 * The owner of a shared server tears it down when it exits, so an attached
 * process can hold a client whose endpoint has since gone away.
 */
export function isConnectionError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  const code = (error as { code?: unknown } | null)?.code;
  const codeStr = typeof code === "string" ? code : "";
  return (
    /failed to connect to chromadb/i.test(message) ||
    /fetch failed/i.test(message) ||
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|UND_ERR/i.test(
      `${message} ${codeStr}`,
    )
  );
}

/**
 * Patterns for tokens that look like SYMBOLS rather than prose.
 *
 * The embedding model (all-MiniLM-L6-v2) reliably fails on these: an exact
 * identifier present in 35 documents still loses to a topical summary, because
 * a 384-dim general-purpose sentence vector has nowhere to put "this exact rare
 * string appears here". A substring pre-filter is the cheap complement.
 *
 *  1. snake_case / SCREAMING_SNAKE, INCLUDING a trailing underscore, so a
 *     query mentioning `VITE_` matches every `VITE_*` variable by prefix.
 *  2. camelCase / PascalCase runs.
 *  3. dotted identifiers and filenames (`store.ts`, `package.json`, `a.b.c`).
 */
const RARE_TOKEN_PATTERNS: RegExp[] = [
  /[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]*)+/g,
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g,
  /\b[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+\b/g,
];

/** Shortest token worth filtering on; below this the match is mostly noise. */
const MIN_RARE_TOKEN = 5;

/** Most tokens to filter on, longest (most specific) first. */
const MAX_RARE_TOKENS = 3;

/** Prose abbreviations that the dotted pattern would otherwise catch. */
const RARE_TOKEN_STOPLIST = new Set(["e.g.", "i.e.", "etc.", "vs.", "a.k.a."]);

/**
 * Extract symbol-like tokens from a query, longest first.
 *
 * Returns an empty array for ordinary prose, which is what keeps the
 * no-rare-token path byte-identical to pure vector search.
 */
export function rareTokens(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of RARE_TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0];
      if (token.length < MIN_RARE_TOKEN) continue;
      if (RARE_TOKEN_STOPLIST.has(token.toLowerCase())) continue;
      found.add(token);
    }
  }
  return [...found]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_RARE_TOKENS);
}

/** Chroma `where_document` clause matching any of `tokens`, or undefined. */
function containsAny(tokens: string[]): Record<string, unknown> | undefined {
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1) return { $contains: tokens[0] };
  // validateWhereDocument requires $or to hold at least two expressions.
  return { $or: tokens.map((t) => ({ $contains: t })) };
}

/**
 * Reciprocal Rank Fusion over ranked lists.
 *
 * Chosen over "keyword hits first" because both input lists are already ranked
 * by vector distance — the keyword list is simply the same ranking restricted
 * to documents containing the identifier. Concatenating would let a weak
 * keyword match outrank a strong semantic one; RRF instead promotes documents
 * that BOTH contain the token and sit close in embedding space, which is
 * exactly the "I know this symbol appears in the answer" case. It also needs no
 * arbitrary keyword score to compare against an L2 distance, and collapses to
 * the vector ordering when the keyword list is empty.
 */
const RRF_K = 60;

/**
 * Candidate depth per list before fusion.
 *
 * Fusion can only reorder what it is given: fetching just `n` per list means a
 * document ranked n+1 in the keyword list can never be promoted, which defeats
 * the point. Both lists are drawn deeper, fused, then truncated to `n`.
 */
function candidatePool(n: number): number {
  return Math.max(n * 4, 20);
}

function fuse(lists: StoreRecord[][], n: number): StoreRecord[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, StoreRecord>();
  for (const list of lists) {
    list.forEach((record, rank) => {
      scores.set(record.id, (scores.get(record.id) ?? 0) + 1 / (RRF_K + rank));
      const existing = byId.get(record.id);
      if (!existing || existing.distance == null) byId.set(record.id, record);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const da = byId.get(a[0])?.distance ?? Number.POSITIVE_INFINITY;
      const db = byId.get(b[0])?.distance ?? Number.POSITIVE_INFINITY;
      return da - db;
    })
    .slice(0, n)
    .map(([id]) => byId.get(id)!);
}

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
 * Sort key for "most recent": the best available estimate of when a document's
 * CONTENT happened. ISO-8601 sorts lexicographically, so plain compare works.
 *
 *   turn_timestamp  transcript chunks — when the conversation happened
 *   modified_at     watcher-indexed files — the file's own mtime
 *   created_at      strategist findings — written at the moment they were made
 *
 * `created_at` is last on purpose: for watcher-indexed documents it is index
 * time, not content time. After a bulk backfill every such row shares a
 * timestamp within seconds, which makes "recent" arbitrary — and worse, mixing
 * index time with conversation time in one comparison lets a document indexed
 * today outrank a conversation from last week purely because it was indexed
 * later. Only fall through to it when nothing better exists.
 */
function recencyKey(meta: Record<string, unknown> | null): string {
  const turn = meta?.turn_timestamp;
  if (typeof turn === "string" && turn.length > 0) return turn;
  const modified = meta?.modified_at;
  if (typeof modified === "string" && modified.length > 0) return modified;
  const created = meta?.created_at;
  return typeof created === "string" ? created : "";
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
    const host = args?.host ?? envVar("CHROMA_HOST") ?? "localhost";
    const port = args?.port ?? envNum("CHROMA_PORT") ?? DEFAULT_PORT;
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
   * Semantic query against `collection`, with a keyword pre-filter when the
   * query mentions a symbol-like token. Returns up to `n` results.
   *
   * HYBRID RETRIEVAL. all-MiniLM-L6-v2 will not rank an exact rare identifier
   * above a topical summary — measured here, `get_building_demand` appears in
   * 35 documents and still lost to a memory index. When `rareTokens` finds a
   * symbol, a second pass runs the same vector query restricted to documents
   * that literally contain it (Chroma `where_document` `$contains`, verified
   * case-SENSITIVE against chromadb 3.4.3), and the two ranked lists are fused
   * by Reciprocal Rank Fusion.
   *
   * For ordinary prose no token is found and this is exactly one vector query,
   * identical to the pre-hybrid behaviour. Pass `hybrid: false` to force that.
   */
  async query(
    collection: string,
    queryText: string,
    n: number,
    opts?: { where?: Record<string, unknown>; hybrid?: boolean },
  ): Promise<StoreRecord[]> {
    return retry(async () => {
      const col = await this.getCollection(collection);
      const where = opts?.where ? { where: opts.where as never } : {};

      const runQuery = async (
        whereDocument?: Record<string, unknown>,
        depth: number = n,
      ): Promise<StoreRecord[]> => {
        const res = await col.query({
          queryTexts: [queryText],
          nResults: depth,
          ...where,
          ...(whereDocument ? { whereDocument: whereDocument as never } : {}),
        });
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
      };

      // Pure prose, or hybrid explicitly disabled: unchanged single-query path,
      // fetched at exactly `n` so the results are byte-identical to before.
      const tokens = opts?.hybrid === false ? [] : rareTokens(queryText);
      const clause = containsAny(tokens);
      if (!clause) return runQuery();

      const pool = candidatePool(n);
      const vectorHits = await runQuery(undefined, pool);

      // Keyword pass: the same vector ranking, restricted to documents that
      // literally contain the identifier. Chroma returns an empty list (not an
      // error) when nothing matches, so an absent token degrades to
      // vector-only.
      let keywordHits: StoreRecord[] = [];
      try {
        keywordHits = await runQuery(clause, pool);
      } catch {
        return vectorHits.slice(0, n); // a bad clause must never break search
      }
      if (keywordHits.length === 0) return vectorHits.slice(0, n);

      return fuse([vectorHits, keywordHits], n);
    });
  }

  /**
   * Return the `n` most recent documents in `collection`.
   *
   * "Recent" means `turn_timestamp` when the document has one and `created_at`
   * otherwise (see `recencyKey`). Optional `where` is pushed to Chroma so a
   * filtered call narrows the candidate set server-side instead of fetching
   * everything and filtering afterwards.
   *
   * Chroma exposes no order-by on metadata, so ranking still happens here; the
   * two-pass fetch keeps that cost to metadata rather than full documents.
   */
  async listRecent(
    collection: string,
    n: number,
    opts?: { where?: Record<string, unknown> },
  ): Promise<StoreRecord[]> {
    return retry(async () => {
      const col = await this.getCollection(collection);
      const where = opts?.where ? { where: opts.where as never } : {};

      // Pass 1: metadata only. Chroma has no order-by, so the candidate set
      // still has to be ranked here — but skipping `documents` keeps the
      // transferred payload to the timestamps we actually sort on. A `where`
      // narrows the candidate set server-side before any of that.
      const index = await col.get({
        include: ["metadatas"] as never,
        ...where,
      });
      const ranked = index.ids
        .map((id, i) => ({ id, metadata: normalizeMetadata(index.metadatas[i]) }))
        .sort((a, b) => recencyKey(b.metadata).localeCompare(recencyKey(a.metadata)))
        .slice(0, n);
      if (ranked.length === 0) return [];

      // Pass 2: fetch documents for the winners only.
      const page = await col.get({
        ids: ranked.map((r) => r.id),
        include: ["documents", "metadatas"] as never,
      });
      const byId = new Map<string, { document: string | null; metadata: Record<string, unknown> | null }>();
      page.ids.forEach((id, i) => {
        byId.set(id, {
          document: page.documents[i] ?? null,
          metadata: normalizeMetadata(page.metadatas[i]),
        });
      });

      // Chroma does not promise id order, so re-apply the ranking.
      return ranked.map((r) => ({
        id: r.id,
        document: byId.get(r.id)?.document ?? null,
        metadata: byId.get(r.id)?.metadata ?? r.metadata,
      }));
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

  const hasExited = () => proc.exitCode !== null || proc.signalCode !== null;
  // Resolve when the child process actually exits (releasing its file handles
  // on the store dir), or after `ms`. Waiting on exit — not just the port — is
  // what lets callers safely delete the store directory afterward.
  const waitForExit = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (hasExited()) return resolve(true);
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve(hasExited());
        }
      };
      proc.once("exit", finish);
      setTimeout(finish, ms);
    });

  const waitForPortFree = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await isPortFree(port)) return;
      await sleep(150);
    }
  };

  // 1) Graceful request.
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T"], { stdio: "ignore" });
  } else {
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  }
  if (await waitForExit(4000)) {
    await waitForPortFree(2000);
    return;
  }

  // 2) Force fallback — ensure the process is truly gone, then the port.
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
  await waitForExit(4000);
  await waitForPortFree(2000);
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
  const host = opts?.host ?? envVar("CHROMA_HOST") ?? "localhost";
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  const envPort = envNum("CHROMA_PORT");
  let port: number;
  if (opts?.port !== undefined) {
    port = opts.port;
  } else if (envPort !== undefined) {
    port = envPort;
  } else {
    port = (await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : await getFreePort();
  }

  let proc: ChildProcess;
  if (process.platform === "win32" && process.arch === "x64") {
    // Bypass the broken CLI arch guard by loading the native binding directly.
    //
    // Resolve the binding HERE, relative to this module, and hand the child an
    // absolute path. Resolving in the child against process.cwd() broke every
    // launch from outside the repo root — which is what any normal MCP host
    // registration does. See regression test scripts/test-cwd.mjs.
    const require = createRequire(import.meta.url);
    const bindingPath = require.resolve("chromadb-js-bindings-win32-x64-msvc");
    const bootstrap = [
      "const b = require(process.env.HANDOFF_BINDING_PATH);",
      "b.cli(['chroma','run','--path',process.env.HANDOFF_CHROMA_PATH,",
      "'--host',process.env.HANDOFF_CHROMA_HOST,'--port',process.env.HANDOFF_CHROMA_PORT]);",
    ].join("");
    proc = spawn(process.execPath, ["-e", bootstrap], {
      env: {
        ...process.env,
        HANDOFF_BINDING_PATH: bindingPath,
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
  const envHost = envVar("CHROMA_HOST");
  const envPort = envNum("CHROMA_PORT");

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
