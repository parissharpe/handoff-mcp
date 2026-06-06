#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

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
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!TOOLS.some((tool) => tool.name === name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // Stub implementation: echo the call so the wiring can be verified.
  return {
    content: [
      {
        type: "text",
        text: `[stub] ${name} called with: ${JSON.stringify(args ?? {})}`,
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr so we don't corrupt the stdio JSON-RPC stream.
  console.error("handoff-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting handoff-mcp:", error);
  process.exit(1);
});
