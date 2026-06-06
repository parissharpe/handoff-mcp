# Handoff

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/python-%E2%89%A53.11-3776AB?logo=python&logoColor=white)

**A local-first MCP server that gives any Claude instance (Claude.ai, Code, Cowork) a shared working memory it can read from and write to, so you stop re-explaining your context every time you switch tools.**

*Handoff* is an aviation term for passing communication between controllers as an aircraft moves through airspace. That's exactly what this does: it passes your strategic context between the specialized Claude products you already run in parallel.

---

## Why this exists

You use multiple Claude products for different parts of the same workflow. Claude.ai for strategy and interpretation. Claude Code for technical execution. Cowork for document and file work. Each one performs within its own context window. **None of them know what the others are doing.**

The current solution is manual: copy output from one window, paste it into another, re-explain the background, repeat. It works — and it costs cognitive overhead every time you switch modes, and it leaks context when you're moving fast.

Existing cross-platform memory tools (Mem0, Onoma, Jenova) bridge multiple LLM *brands* (ChatGPT, Claude, Gemini) for conversational memory. They don't address cross-*product* memory within one brand's specialized tools. Nobody has specifically solved the Cowork-to-Code context gap. That's the gap Handoff fills.

> Not another Claude orchestrator. The first bridge specifically built for users who run Cowork and Code in parallel, with a local-first architecture that keeps your strategic context under your own roof.

---

## Data sovereignty

This tool is a data sovereignty artifact, not just a productivity tool.

Every Claude product currently manages its own context. Your memory lives in Anthropic's infrastructure, scoped to one product at a time. Cowork's memory doesn't follow you to Code. Claude.ai's memory doesn't follow you to Cowork. The architecture creates context lock-in the same way proprietary platforms create data lock-in.

The inverse: **your strategic context lives on your machine, in a format you own, portable across every Claude product and every future AI tool that speaks MCP.** You don't move toward the tools. The tools come to you.

Where the dominant pattern is "your data lives in our infrastructure," the inverse is "your data lives in your substrate and tools access it with your permission." Nothing is transmitted to any external server. Embeddings are computed locally. No Anthropic API key is required for storage or retrieval. You are the ultimate guardian of what goes in and comes out.

---

## How it works

```
Cowork session → output folder → watcher ─┐
                                          ├─→ local vector store (ChromaDB)
Code session   → CLAUDE.md / transcript ──┘            ↓
                                    MCP server (exposes tools to any Claude instance)
                                                       ↓
                        Claude.ai / Code / Cowork reads context on demand
                                                       ↓
                              Strategist writes synthesis back to store
```

Three components:

1. **MCP server (the doorway)** — TypeScript. Exposes tools any Claude instance can call.
2. **Local vector store (the substance)** — ChromaDB on your machine. No cloud, no API key for storage. Three collections: `cowork_sessions`, `code_sessions`, `strategist_memory`. Embeddings computed locally with an `all-MiniLM-L6-v2`-class model.
3. **Session watchers (the inputs)** — lightweight Python file watchers that feed the store incrementally as you work.

There is no separate "strategist model." The strategist is any Claude instance with this MCP server configured — the perch it needs to synthesize across both do-ers.

### Tools

| Tool | What it does |
|---|---|
| `get_recent_cowork_context(limit, since)` | Returns the most recent Cowork session outputs |
| `get_recent_code_context(repo, limit)` | Returns the most recent Code session outputs |
| `query_strategist_memory(query, limit)` | Semantic search across the local store |
| `write_strategist_finding(finding, tags)` | Writes a synthesis note to the store |
| `get_cross_product_brief(topic)` | Generates a summary across both products |

---

## Install

```bash
npm install -g handoff-mcp
```

Then add a block to your `claude_desktop_config.json` (a ready-to-edit copy lives in [`mcp.json.example`](mcp.json.example)):

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["handoff-mcp"],
      "env": {
        "COWORK_OUTPUT_FOLDER": "C:\\Users\\you\\Documents\\Cowork",
        "CODE_PROJECT_PATH": "C:\\Users\\you\\projects\\my-project",
        "HANDOFF_STORE_PATH": "C:\\Users\\you\\.handoff\\db"
      }
    }
  }
}
```

### Run the watchers

The MCP server reads and writes the store; the **watchers** feed it. Run them as
background processes (they discover the running server via `server.json`, so no
extra config is needed):

```bash
python watchers/cowork.py    # indexes COWORK_OUTPUT_FOLDER -> cowork_sessions
python watchers/code.py      # indexes CODE_PROJECT_PATH    -> code_sessions
```

### See it work

```bash
npm run build && npm run demo
```

The demo seeds three mock Cowork outputs and three mock Code outputs, then calls
the real tools — ending with `get_cross_product_brief` surfacing both products'
context for one topic.

### Prerequisites

- Node.js v20+
- Python 3.11+ (for the watchers)
- Claude Code installed
- Cowork access (Max plan)

---

## Configuration

The entire configuration surface is a handful of environment variables.

| Variable | Required | Description |
|---|---|---|
| `COWORK_OUTPUT_FOLDER` | Yes | Path to Cowork's output folder. The Cowork watcher monitors this directory and indexes new/modified files into `cowork_sessions`. |
| `CODE_PROJECT_PATH` | Yes | Root of the Claude Code project to monitor. The Code watcher indexes its curated context (CLAUDE.md / CLAUDE.local.md, `transcripts/` & `.claude/` dirs, `*.jsonl`) into `code_sessions`. |
| `HANDOFF_STORE_PATH` | No | Where the local ChromaDB store lives. Defaults to `~/.handoff/db`. |
| `CHROMA_HOST` | No | Host of the Chroma server the components talk to. Defaults to `localhost`. |
| `CHROMA_PORT` | No | Port of the Chroma server. Defaults to `8000`. |

No Anthropic API key is required. All computation is local.

### Running the Chroma server

Handoff's components talk to a single local ChromaDB **server** over HTTP — the server is the one process that owns the on-disk store, which lets the MCP server and the Python watchers share it without lock conflicts. The MCP server starts a server automatically when it needs one. If you want to run the watchers standalone (without the MCP server up), start a server yourself:

```bash
chroma run --path ~/.handoff/db
```

Point `CHROMA_HOST` / `CHROMA_PORT` at it if you use a non-default endpoint.

---

## Status

**v0.3.0** — current release:

- ✅ MCP server with all five tools wired to a real ChromaDB store
- ✅ Local vector store with `cowork_sessions`, `code_sessions`, and `strategist_memory` collections
- ✅ Cowork watcher **and** Code watcher (Windows-first), both writing into the shared store over HTTP
- ✅ Single shared Chroma server coordinated via a `server.json` endpoint file, with graceful shutdown and a startup readiness gate (no empty-read races on restart)
- ✅ Local embeddings, no API key required

**Ideas for later (build only if the community asks):** Obsidian export, multi-project support, custom embedding-model selection, a web UI for browsing the local store.

---

## Attribution

The three-layer architecture is inspired by the **Chronicle pattern** (Briar Harvey, 2026), applied here to live cross-product synthesis rather than historical conversation import. Local embeddings use the same `all-MiniLM-L6-v2` model family Chronicle uses.

---

## Built by

Built by [Oreb.AI](https://oreb.ai).

Source: [github.com/parissharpe/handoff-mcp](https://github.com/parissharpe/handoff-mcp)
