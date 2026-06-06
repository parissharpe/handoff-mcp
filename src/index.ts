#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Store, ensureServer } from "./store.js";

/**
 * handoff-mcp
 *
 * An MCP server that surfaces cross-product "handoff" context: recent cowork
 * activity, recent code activity, and a persistent strategist memory. Every
 * tool below is currently a stub that echoes its arguments — the real data
 * sources (ChromaDB, file watchers, etc.) will be wired in later.
 */

const TOOLS: Tool[] = [
  {
    name: "get_recent_cowork_context",
    description:
      "Return recent cowork (collaboration) activity to bring a session up to speed.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of recent items to return.",
        },
        since: {
          type: "string",
          description: "ISO-8601 timestamp; only return activity after this.",
        },
      },
    },
  },
  {
    name: "get_recent_code_context",
    description:
      "Return recent code-related activity (commits, edits, reviews) for a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository or workspace identifier to scope results.",
        },
        limit: {
          type: "number",
          description: "Maximum number of recent items to return.",
        },
      },
    },
  },
  {
    name: "query_strategist_memory",
    description:
      "Search the persistent strategist memory for findings relevant to a query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query to search the memory.",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching findings to return.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "write_strategist_finding",
    description:
      "Persist a new strategist finding to memory for later retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        finding: {
          type: "string",
          description: "The finding text to store.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags to categorize the finding.",
        },
      },
      required: ["finding"],
    },
  },
  {
    name: "get_cross_product_brief",
    description:
      "Generate a brief that synthesizes context across products for a given topic.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The topic or area to brief on.",
        },
      },
      required: ["topic"],
    },
  },
];

const server = new Server(
  {
    name: "handoff-mcp",
    version: "0.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ---------------------------------------------------------------------------
// Collections (must match the Python watchers and store.ts)
// ---------------------------------------------------------------------------
const COWORK_COLLECTION = "cowork_sessions";
const CODE_COLLECTION = "code_sessions";
const STRATEGIST_COLLECTION = "strategist_memory";

// ---------------------------------------------------------------------------
// Chroma lifecycle
//
// The chromadb JS client is server-based: it talks to a Chroma server over
// HTTP. We lazily ensure a server is reachable on the first tool call via
// ensureServer(), which connects to an already-running shared server (found via
// CHROMA_HOST/PORT or the server.json endpoint file) or starts one backed by
// HANDOFF_STORE_PATH and owns its lifecycle. This keeps tools/list working
// without Chroma and defers the model load until it's actually needed.
// ---------------------------------------------------------------------------
let storePromise: Promise<Store> | null = null;
let stopOwnedServer: (() => Promise<void>) | null = null;

/** Lazily resolve a connected Store, starting a shared Chroma server if needed. */
function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = (async () => {
      const { endpoint, started, stop } = await ensureServer();
      if (started) {
        stopOwnedServer = stop;
        console.error(
          `handoff-mcp: started shared Chroma server at ${endpoint.host}:${endpoint.port}`,
        );
      } else {
        console.error(
          `handoff-mcp: connected to Chroma server at ${endpoint.host}:${endpoint.port}`,
        );
      }
      return new Store({ host: endpoint.host, port: endpoint.port });
    })();
    // If startup fails, allow a later retry instead of caching the rejection.
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asText(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const MAX_LIMIT = 100;

/** Coerce a limit-like value into [1, MAX_LIMIT], falling back when invalid. */
function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Validate an optional ISO-8601 `since` filter; throws on a malformed value. */
function parseSince(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(
      "`since` must be an ISO-8601 timestamp string (e.g. 2026-06-06T00:00:00Z)",
    );
  }
  return value;
}

/** Split the comma-joined `tags` string back into an array for output. */
function decodeTags(meta: Record<string, unknown> | null): string[] {
  const raw = meta?.tags;
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw.split(",");
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  if (!TOOLS.some((tool) => tool.name === name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    const store = await getStore();

    switch (name) {
      case "get_recent_cowork_context": {
        const limit = num(args.limit, 5);
        const since = parseSince(args.since);
        let items = await store.listRecent(COWORK_COLLECTION, limit + 25);
        if (since) {
          items = items.filter(
            (r) => String(r.metadata?.created_at ?? "") >= since,
          );
        }
        items = items.slice(0, limit);
        return asText({
          collection: COWORK_COLLECTION,
          count: items.length,
          items: items.map((r) => ({
            id: r.id,
            content: r.document,
            metadata: r.metadata,
          })),
        });
      }

      case "get_recent_code_context": {
        const limit = num(args.limit, 5);
        const repo = typeof args.repo === "string" ? args.repo : undefined;
        let items = await store.listRecent(CODE_COLLECTION, limit + 25);
        if (repo) {
          items = items.filter((r) => {
            const m = r.metadata ?? {};
            return m.repo === repo || m.path === repo || m.project === repo;
          });
        }
        items = items.slice(0, limit);
        return asText({
          collection: CODE_COLLECTION,
          repo: repo ?? null,
          count: items.length,
          items: items.map((r) => ({
            id: r.id,
            content: r.document,
            metadata: r.metadata,
          })),
        });
      }

      case "query_strategist_memory": {
        const query = typeof args.query === "string" ? args.query : "";
        if (!query) throw new Error("`query` is required");
        const limit = num(args.limit, 5);
        const results = await store.query(STRATEGIST_COLLECTION, query, limit);
        return asText({
          collection: STRATEGIST_COLLECTION,
          query,
          count: results.length,
          results: results.map((r) => ({
            id: r.id,
            content: r.document,
            tags: decodeTags(r.metadata),
            distance: r.distance ?? null,
            metadata: r.metadata,
          })),
        });
      }

      case "write_strategist_finding": {
        const finding =
          typeof args.finding === "string" ? args.finding : "";
        if (!finding) throw new Error("`finding` is required");
        const tags = Array.isArray(args.tags)
          ? args.tags.map((t) => String(t))
          : [];
        const id = await store.write(STRATEGIST_COLLECTION, finding, tags);
        return asText({
          status: "written",
          id,
          collection: STRATEGIST_COLLECTION,
          tags,
        });
      }

      case "get_cross_product_brief": {
        const topic = typeof args.topic === "string" ? args.topic : "";
        if (!topic) throw new Error("`topic` is required");
        const perSource = num(args.limit, 3);
        const [cowork, code, memory] = await Promise.all([
          store.query(COWORK_COLLECTION, topic, perSource).catch(() => []),
          store.query(CODE_COLLECTION, topic, perSource).catch(() => []),
          store
            .query(STRATEGIST_COLLECTION, topic, perSource)
            .catch(() => []),
        ]);
        const shape = (r: {
          id: string;
          document: string | null;
          metadata: Record<string, unknown> | null;
          distance?: number | null;
        }) => ({ id: r.id, content: r.document, distance: r.distance ?? null });
        return asText({
          topic,
          sources: {
            cowork_sessions: cowork.map(shape),
            code_sessions: code.map(shape),
            strategist_memory: memory.map(shape),
          },
          totals: {
            cowork: cowork.length,
            code: code.length,
            memory: memory.length,
          },
        });
      }

      default:
        throw new Error(`Unhandled tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: message, tool: name }, null, 2),
        },
      ],
    };
  }
});

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const stop = stopOwnedServer;
  stopOwnedServer = null;
  if (stop) {
    try {
      await stop(); // graceful-first: flush + release the port before exit
    } catch {
      // best-effort
    }
  }
  process.exit(code);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr so we don't corrupt the stdio JSON-RPC stream.
  console.error("handoff-mcp v0.3.0 server running on stdio");
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
// MCP hosts (especially on Windows) typically stop a stdio server by closing
// its stdin rather than sending a signal. Treat transport close / stdin EOF as
// a shutdown trigger so we still stop the Chroma server gracefully.
server.onclose = () => void shutdown(0);
process.stdin.on("close", () => void shutdown(0));

main().catch((error) => {
  console.error("Fatal error starting handoff-mcp:", error);
  void shutdown(1);
});
