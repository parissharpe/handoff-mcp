# Changelog

## v0.4.0

Two runtime defects fixed. If you are on Windows, the first one almost
certainly affected you.

This is the first release after v0.3.0. An earlier v0.4.0 was prepared as an
uncommitted manifest-and-package operation on top of v0.3.0 source and was never
released, so that version number is reused here.

### Fixed: server failed to start outside the repo directory (Windows x64)

The Chroma native binding was resolved relative to the process working
directory. If handoff was launched from anywhere other than the repo root,
which is what happens with any normal MCP host registration, the Chroma
server never became ready and every store-backed tool returned a connection
error after a 30 second timeout.

macOS was unaffected. The non-Windows code path already resolved correctly
relative to the module URL, and the Windows x64 branch now does the same: the
binding is resolved in the parent process and passed to the spawned server as an
absolute path.

If you registered handoff and saw "Chroma server did not become ready", this
was the cause. Re-register and it should work from any directory.

Empty-string environment variables are now treated as unset. Previously
setting `CHROMA_HOST=""` produced an endpoint of "http://:8000" instead of
falling back to localhost. Values are also trimmed, and a non-numeric
`CHROMA_PORT` now falls back instead of producing `NaN`.

### Fixed: attached client stayed broken after the server owner exited

handoff supports multiple MCP hosts sharing one Chroma store. The first
process to start becomes the owner, others attach to it. If the owner exited,
attached processes kept a cached dead client and failed every subsequent call
until they were restarted themselves.

In practice: closing Claude Desktop would silently break a running Claude Code
session, or the reverse.

Attached clients now detect connection-level failure, invalidate the cached
client, and re-resolve once, either finding a live server or starting a new
one. Ownership semantics are unchanged. A process that attached to someone
else's server still cannot shut it down.

`get_cross_product_brief` previously swallowed every per-collection query
failure, so a dead endpoint surfaced as a brief with three empty buckets rather
than an error. It now distinguishes the two: an unreadable collection still
degrades to an empty bucket, but a connection failure propagates so the retry
above can run.

### Changed: tool descriptions now match behavior

Two descriptions promised more than the code delivers.

`get_cross_product_brief` said it generated a synthesized brief. It runs three
independent similarity queries and returns the raw hits in three labeled
buckets with distances. No summarization happens. The description now says so.

`get_recent_code_context` said it returned commits, edits, and reviews. Nothing
reads git history. The watcher indexes CLAUDE.md, CLAUDE.local.md, transcripts/,
.claude/ directories, and .jsonl files, and the tool returns that indexed text.

`get_cross_product_brief` also accepted an undocumented `limit` parameter that
was missing from its input schema, so clients could not discover it. Now
declared, default 3.

Removed a stale source comment claiming the tools were stubs. They have not
been stubs since v0.3.0.

### Known issues

Bundle size. node_modules is roughly 529 MB, of which roughly 458 MB is the
subtree reachable only through `@chroma-core/default-embed` — its ONNX and
transformers dependencies. Embedding runs in-process on the Node side, so this
is a real runtime requirement, not dead weight. Peak memory is roughly 863 MB
and the first embedding call costs about 2.5 seconds cold. Read-only tools that
do not embed respond in under 20 ms. (These figures were measured on v0.3.0 and
have not been re-measured; the code paths they cover are unchanged in v0.4.0.)

`onnxruntime-web`, roughly 90 MB of that tree, is never loaded at runtime on
Node. Excluding it from packaged builds is planned but not yet done.

.mcpb packaging on the Microsoft Store build of Claude Desktop can exceed the
Windows 260 character path limit during extraction, because the MSIX data
redirect adds about 52 characters to the install prefix. Enabling
LongPathsEnabled does not resolve this on its own.

Python watchers require an interpreter with chromadb installed. Verify with:
`python -c 'import chromadb'`.

Tool annotations (`readOnlyHint`, `destructiveHint`, `title`) are still not
declared on any of the five tools.

### Verification

Adds three regression tests covering cwd independence, owner-exit recovery, and
empty-string environment variables. All existing suites still pass, including
the cross-process integration test that confirms the Python watcher and the
Node server share one store correctly.

---

## v0.3.0

- MCP server with all five tools wired to a real ChromaDB store
- Local vector store with `cowork_sessions`, `code_sessions`, and
  `strategist_memory` collections
- Cowork watcher and Code watcher (Windows-first), both writing into the shared
  store over HTTP
- Single shared Chroma server coordinated via a `server.json` endpoint file,
  with graceful shutdown and a startup readiness gate
- Local embeddings, no API key required
