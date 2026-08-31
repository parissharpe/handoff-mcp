# Changelog

## v0.5.0

The code watcher was indexing the wrong directory. Claude Code writes session
transcripts to `~/.claude/projects/<encoded>/*.jsonl`, not into project source
trees, so `get_recent_code_context` had never returned a transcript. Pointed at
this repo it matched exactly one file, a permissions config.

This release repoints it, makes the indexed content searchable, and fixes two
retrieval defects that only became visible once there was real data to search.

### Fixed: transcripts were never being indexed

The watch root now defaults to `~/.claude/projects`. Precedence is
`--folder` > `CODE_PROJECT_PATH` > default, and the chosen root and the reason
are logged at startup, because picking the wrong one fails silently: an empty
collection is indistinguishable from "hasn't indexed yet".

Transcripts are parsed rather than read whole. Measured across 126 MB of
transcripts on the development machine, about 2.6% of the bytes are
conversation; the rest is tool-call plumbing, echoed tool output, and opaque
base64 `thinking` signatures (89% of all thinking-block bytes). With the
embedding model's 512-token context, one 40 MB file indexed as a single
document would have been represented by roughly its first page.
`watchers/_transcripts.py` streams each file line by line and keeps only
user/assistant text blocks.

Chunk boundaries follow meaning. Turns are atomic — a chunk closes before a turn
that will not fit rather than splitting it — an oversized turn splits on
paragraph then sentence boundaries, and adjacent chunks share a trailing
sentence or two so an answer straddling a boundary is reachable from either
side. Chunk ids are `sha1("<abs_path>:<index>")`, so a re-run upserts in place
and prunes any shortened tail; two consecutive backfills of the same project
produced identical document counts.

The whole-file 5 MB cap does not apply on this path, because nothing is read
whole. Under the old cap, 5 of 43 files exceeded it and 55% of the corpus would
have been silently truncated.

### Fixed: every document was tagged with the same project

`_repo_name()` read `CODE_PROJECT_PATH` regardless of which folder was being
walked, so running the watcher against several projects tagged them all
identically.

Documents are now tagged from the `cwd` recorded inside each transcript. The
encoded directory name is deliberately not decoded: the encoding maps `:`,
backslash and space all to `-`, so it cannot be reversed, and on the development
machine it mislabels two real projects — one encoded as
`...-USPTO-Search-Key` is really `...\USPTO Search Key`, and one directory is
keyed on a session's launch directory rather than the project it worked on. A
project whose `cwd` cannot be resolved is tagged `unknown` rather than guessed.

### Fixed: "recent" returned an arbitrary slice

`listRecent` sorted on `created_at`, which is index time. A bulk backfill stamps
every row within seconds of every other, so ordering was meaningless. It now
sorts on the best available *content* time: `turn_timestamp` for transcript
chunks, then `modified_at` for watcher-indexed files, then `created_at` for
strategist findings, where write time is content time.

The `modified_at` rung is load-bearing. Falling straight through to `created_at`
let documents indexed today outrank conversations from last week purely because
they were written later — the original bug in a new place.

### Fixed: the project filter was applied after truncation

`get_recent_code_context` fetched the newest `limit + 25` rows across all
projects and filtered in JavaScript afterwards, so a project outside that global
window returned nothing however much history it had. The filter is now a Chroma
`where` clause. `listRecent` and `store.query` both accept one, and
`get_cross_product_brief` gains an optional `repo` that scopes the code bucket
only — cowork and strategist documents carry no project tag, so filtering them
would empty rather than narrow.

`listRecent` still ranks client-side, because Chroma exposes no order-by on
metadata, but it now runs two passes: metadata only to rank, then documents for
the winners.

### Added: hybrid keyword and vector retrieval

The embedding model will not rank an exact rare identifier above a topical
summary. Measured on the real store, `get_building_demand` appeared in 35 of 688
documents and still lost to a memory index that merely listed it in a backlog.

`store.query` now detects symbol-like tokens — snake_case and SCREAMING_SNAKE
including a trailing underscore, so `VITE_` matches every `VITE_*` variable by
prefix; camelCase; and dotted identifiers or filenames — and runs a second
vector pass restricted to documents that literally contain one, using Chroma's
`where_document` `$contains`. The two ranked lists are merged by Reciprocal Rank
Fusion, deduplicated by id, and truncated to the caller's limit.

Ordinary prose produces no token and takes exactly the old single-query path. A
token that appears in no document falls back to vector-only rather than
returning empty.

Applies to `query_strategist_memory` and `get_cross_product_brief`.
`get_recent_code_context` is untouched: it is a recency tool, not a search tool.

### Changed: default page size is now 8

`get_recent_code_context`, `query_strategist_memory` and
`get_cross_product_brief` default to 8 results. They previously differed — the
brief used 3, the other two used 5, and only the brief declared a default at
all. The declared default is now interpolated from the same constant used as the
handler fallback, so the two cannot drift apart.

Retrieval here is better at putting a relevant document in the page than at
putting it first: a known-good chunk for a loosely-worded query sat at rank 6.

### Measured

Backfilled all 13 project directories on the development machine: **2,381
documents from 72 files, no drift warnings, and no project yielding zero
documents.** Per-project recency returned zero cross-project rows for the three
projects spot-checked. For a token confined to a single project, hybrid returned
8 of 8 matching documents against 4 of 8 for vector-only, with no
foreign-project rows.

Query latency at 2,381 documents: `listRecent` unfiltered 178 ms median,
filtered to a 688-document project 40 ms, filtered to a 36-document project
6 ms. A prose query is 250 ms; a hybrid query, which runs two passes, is 520 ms.

### Known issues

**Exact-identifier recall is improved, not solved.** Hybrid retrieval fixed the
case it was built for, but a second known-good document still lands at rank 6
rather than the top 3 for a loosely-worded query. It is genuinely the 6th
closest of the 24 documents containing that token; reranking that respects
similarity cannot lift it further. A stronger embedding model would, at the cost
of re-embedding everything and enlarging a dependency tree we want to shrink.

**The watchers are not persistent across reboots.** They run until the terminal
closes or the machine restarts. Nothing in the repo starts them at logon, and
the README still says only "run them as background processes". Task Scheduler, a
startup shortcut, or a service wrapper are all workable; none is implemented.

**The transcript parser is coupled to an undocumented format.** The schema-drift
guard makes a hard break loud — per-file counts are logged, and a file that
parses but yields zero text chunks is reported with its record-type histogram —
but a silent narrowing, such as a new block type carrying conversation, would
quietly reduce recall without tripping it.

**Project identity is resolved once per directory.** `_first_cwd_in_dir` reads
the first transcript it finds and applies that project to the whole directory.
Where sessions in one directory ran against different working directories, the
first one read wins; on the development machine this tags 71 documents `paris`
rather than the project those sessions worked on.

**Bundle size is unchanged.** `node_modules` is roughly 529 MB, of which roughly
458 MB is the subtree reachable only through `@chroma-core/default-embed`.
Embedding runs in-process on the Node side, so this is a real runtime
requirement. `onnxruntime-web`, roughly 90 MB of that tree, is never loaded at
runtime on Node; excluding it from packaged builds is planned but not yet done.

**`.mcpb` packaging still exceeds the Windows path limit** on the Microsoft
Store build of Claude Desktop, because the MSIX data redirect adds about 52
characters to the install prefix. Enabling `LongPathsEnabled` does not resolve
this on its own. No `.mcpb` artifact is published with this release.

**Python watchers require an interpreter with chromadb installed.** Verify with:
`python -c 'import chromadb'`.

### Verification

Adds `scripts/test-hybrid.mjs` (25 checks) and `scripts/test-recency.mjs` (12
checks), both wired into `npm test`, and `watchers/test_transcripts.py` (22
checks). The hybrid test builds a corpus where vector-only search provably
misses the identifier document and asserts hybrid returns it first. The recency
test writes documents in one batch with timestamps reversed against insertion
order, and asserts that filtering happens before truncation rather than after.

All 9 Node suites pass, including the cross-process integration test, as do
`watchers/test_code.py` and `watchers/test_cowork.py`.

---

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
