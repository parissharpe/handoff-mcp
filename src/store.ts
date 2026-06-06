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
 * RUNTIME PREREQUISITE: a reachable Chroma server. By default this adapter
 * connects to http://localhost:8000 (override with CHROMA_HOST / CHROMA_PORT).
 * Callers/tests can use `startLocalServer()` to spawn one backed by
 * HANDOFF_STORE_PATH, or run `chroma run --path <HANDOFF_STORE_PATH>` separately.
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
import { spawn, type ChildProcess } from "node:child_process";
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

  /** Lazily get-or-create a collection by name (cached per instance). */
  private getCollection(name: string) {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = this.client.getOrCreateCollection({ name });
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
    const col = await this.getCollection(collection);
    await col.add({ ids: [id], documents: [content], metadatas: [meta] });
    return id;
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
  }

  /**
   * Return the `n` most recently added documents in `collection`, sorted by
   * the `created_at` metadata field descending. Fetches all documents then
   * sorts client-side (Chroma has no native order-by on metadata).
   */
  async listRecent(collection: string, n: number): Promise<StoreRecord[]> {
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

/**
 * Spawn a local Chroma server backed by HANDOFF_STORE_PATH.
 *
 * On Windows x64 the bundled `chroma` CLI is broken (arch guard rejects x64),
 * so we load the native binding directly in a tiny child process. On other
 * platforms we shell out to the `chroma` binary. Returns the child process and
 * a `ready` promise that resolves once the server answers its heartbeat.
 */
export async function startLocalServer(opts?: {
  storePath?: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<{ proc: ChildProcess; host: string; port: number; stop: () => void }> {
  const storePath = opts?.storePath ?? resolveStorePath();
  const host = opts?.host ?? process.env.CHROMA_HOST ?? "localhost";
  const port =
    opts?.port ??
    (process.env.CHROMA_PORT ? Number(process.env.CHROMA_PORT) : 8000);
  const timeoutMs = opts?.timeoutMs ?? 30_000;

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

  const base = `http://${host}:${port}`;
  const deadline = Date.now() + timeoutMs;
  // Poll heartbeat until the server is up.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await fetch(`${base}/api/v2/heartbeat`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(
        `Chroma server did not become ready on ${base} within ${timeoutMs}ms`,
      );
    }
    await new Promise((res) => setTimeout(res, 250));
  }

  return { proc, host, port, stop: () => proc.kill() };
}
