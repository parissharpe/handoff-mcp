"""
handoff-mcp :: watchers/code.py

Indexes Claude Code's session history into the `code_sessions` Chroma collection
so the strategist can see what Code has been doing. Built on the shared
_indexer engine.

WATCH ROOT — defaults to ~/.claude/projects
-------------------------------------------
Claude Code writes session transcripts to ~/.claude/projects/<encoded>/*.jsonl,
NOT into the project source tree. Before v0.5.0 this watcher pointed at
CODE_PROJECT_PATH (a source directory) and therefore never saw a single
transcript. The default root is now the transcripts tree. Precedence:

    --folder  >  CODE_PROJECT_PATH  >  ~/.claude/projects

The chosen root and WHY is logged at startup, because picking the wrong one
fails silently: an empty collection is indistinguishable from "nothing indexed
yet".

What it indexes:
  - *.jsonl session transcripts, parsed and split into per-turn windows
    (see _transcripts.py). A whole transcript is NOT one document: only ~2.6%
    of transcript bytes are conversation, and the embedder's context is 512
    tokens, so one 40 MB document would be represented by its first page.
  - CLAUDE.md / CLAUDE.local.md, and files under `transcripts/` or `.claude/`.
    This is the original predicate, kept deliberately: it also matches the
    high-signal memory/*.md files that live inside the transcripts tree.

Pruned: build/vendor noise, plus `tool-results/` (raw tool output dumps) and
`*.meta.json` sidecars.

Each document is tagged with the project it actually came from, derived from
the `cwd` recorded inside the transcript — never by decoding the encoded
directory name, which is lossy (":", "\\" and " " all become "-") and on this
machine mislabels at least two real projects.

Usage:
    python watchers\\code.py                       # ~/.claude/projects
    python watchers\\code.py --folder C:\\a\\project  # legacy source-tree mode
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _indexer import (  # noqa: E402
    Indexer,
    get_chroma_endpoint,
    get_store_path,
    reset_collection_cache,
    reset_debounce_state,
    stable_id,
    chunk_id,
)
from _transcripts import (  # noqa: E402
    is_transcript,
    parse_transcript,
    project_for_path,
    reset_project_cache,
)

COLLECTION_NAME = "code_sessions"

#: Where Claude Code actually stores session transcripts.
DEFAULT_TRANSCRIPTS_ROOT = Path.home() / ".claude" / "projects"

CODE_FILENAMES = {"claude.md", "claude.local.md"}
CODE_CONTEXT_DIRS = {"transcripts", ".claude"}
PRUNE_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "__pycache__",
    ".venv", "venv", ".next", ".turbo", ".cache", "coverage",
    # Raw tool-output dumps inside the transcripts tree: exactly the echoed
    # plumbing the transcript parser strips, so indexing it would undo the work.
    "tool-results",
}

#: Resolved at startup by resolve_folder(); used to tag non-transcript files
#: when they sit outside a transcripts tree.
WATCH_ROOT: Optional[Path] = None


#: Machine artifacts inside the transcripts tree that carry no conversation.
#: journal.jsonl holds workflow started/result records — it parses cleanly and
#: yields zero text, which would otherwise trip the schema-drift warning on
#: every scan and train the reader to ignore it.
NON_CONVERSATIONAL = {"journal.jsonl"}

#: Inside the transcripts tree, only these extensions carry meaning: .jsonl
#: sessions and .md memory notes. Excluded by omission: wf_*.json workflow
#: definitions (tens of KB of orchestration config) and generated .js scripts.
TRANSCRIPT_TREE_SUFFIXES = {".jsonl", ".md"}


def code_relevant(path: Path) -> bool:
    """True for Code memory/context files and session transcripts.

    Inside ~/.claude/projects the tree is machine-written, so we allow only
    session transcripts and memory notes. Outside it, the original
    source-tree predicate is preserved unchanged.
    """
    name = path.name.lower()
    if name.endswith(".meta.json"):          # subagent sidecars, not content
        return False
    if name in NON_CONVERSATIONAL:
        return False

    if _transcripts_root_for(path) is not None:
        return path.suffix.lower() in TRANSCRIPT_TREE_SUFFIXES

    # --- legacy source-tree behaviour, unchanged ---
    if name in CODE_FILENAMES:
        return True
    lower_parts = {part.lower() for part in path.parts}
    if lower_parts & CODE_CONTEXT_DIRS:
        return True
    if path.suffix.lower() == ".jsonl":
        return True
    return False


def _transcripts_root_for(path: Path) -> Optional[Path]:
    """The ~/.claude/projects ancestor of `path`, if it has one."""
    candidates = [DEFAULT_TRANSCRIPTS_ROOT]
    if WATCH_ROOT is not None:
        candidates.append(WATCH_ROOT)
    for root in candidates:
        try:
            path.resolve().relative_to(root.resolve())
            return root
        except (ValueError, OSError):
            continue
    return None


def code_metadata(path: Path) -> dict:
    """Tag a document with the project it actually came from.

    Derived from the `cwd` recorded inside the transcripts (see
    _transcripts.project_for_path), never from the encoded directory name.
    Files outside a transcripts tree fall back to the watch root's name, and
    anything unresolvable is tagged "unknown" rather than guessed.
    """
    root = _transcripts_root_for(path)
    if root is not None:
        repo, project_path = project_for_path(path, root)
        meta = {"repo": repo}
        if project_path:
            meta["project_path"] = project_path
        return meta

    # Legacy source-tree mode: unchanged from before this branch.
    env_root = os.environ.get("CODE_PROJECT_PATH")
    if env_root:
        base = Path(os.path.expanduser(env_root))
        return {"repo": base.name, "project_path": str(base)}
    if WATCH_ROOT is not None:
        return {"repo": WATCH_ROOT.name, "project_path": str(WATCH_ROOT)}
    return {"repo": path.parent.name or "unknown"}


class _TranscriptChunker:
    """Adapter handing transcript parsing to the shared Indexer."""

    @staticmethod
    def handles(path: Path) -> bool:
        """Only claim .jsonl files that live in a Claude Code transcripts tree.

        A .jsonl in an ordinary source tree is not this format, so it keeps the
        original whole-file behaviour. Scoping the claim this narrowly is also
        what keeps the zero-chunk schema-drift warning meaningful: it can only
        fire on files we genuinely expected to be transcripts.
        """
        return is_transcript(path) and _transcripts_root_for(path) is not None

    @staticmethod
    def parse(path: Path):
        return parse_transcript(path)

    @staticmethod
    def metadata(path: Path, stats) -> dict:
        """Per-file metadata carried onto every chunk of that file."""
        meta: dict = {}
        if stats.session_id:
            meta["session_id"] = stats.session_id
        if stats.git_branch:
            meta["git_branch"] = stats.git_branch
        # Carried so a future format shift is queryable after the fact.
        meta["transcript_version"] = stats.version or "unknown"
        if stats.cwd:
            meta["project_path"] = stats.cwd
            meta["repo"] = Path(stats.cwd).name or "unknown"
        return meta


_indexer = Indexer(
    collection=COLLECTION_NAME,
    source="code",
    relevant=code_relevant,
    extra_metadata=code_metadata,
    prune_dirs=PRUNE_DIRS,
    chunker=_TranscriptChunker(),
)


def index_file(path, *, force: bool = False) -> bool:
    """Index a single Code context file into code_sessions."""
    return _indexer.index_file(path, force=force)


def initial_scan(folder) -> int:
    return _indexer.initial_scan(folder)


def watch(folder) -> None:
    _indexer.watch(folder)


__all__ = [
    "index_file",
    "initial_scan",
    "watch",
    "code_relevant",
    "code_metadata",
    "stable_id",
    "chunk_id",
    "reset_collection_cache",
    "reset_debounce_state",
    "reset_project_cache",
    "get_chroma_endpoint",
    "get_store_path",
    "COLLECTION_NAME",
    "DEFAULT_TRANSCRIPTS_ROOT",
]


def resolve_folder(cli_folder: Optional[str]) -> Path:
    """Resolve the watch root: --folder > CODE_PROJECT_PATH > ~/.claude/projects.

    Logs which source won. Choosing the wrong root fails silently otherwise —
    an empty collection looks identical to "hasn't indexed yet".
    """
    global WATCH_ROOT
    env = os.environ.get("CODE_PROJECT_PATH")
    if cli_folder:
        root, why = Path(os.path.expanduser(cli_folder)), "--folder"
    elif env:
        root, why = Path(os.path.expanduser(env)), "CODE_PROJECT_PATH"
    else:
        root, why = DEFAULT_TRANSCRIPTS_ROOT, "default (Claude Code transcripts)"

    print(f"[code] watch root: {root}  (from {why})")
    if why == "CODE_PROJECT_PATH" and root.resolve() != DEFAULT_TRANSCRIPTS_ROOT.resolve():
        print(
            f"[code] NOTE: CODE_PROJECT_PATH points at a source tree. Claude Code "
            f"writes transcripts to {DEFAULT_TRANSCRIPTS_ROOT}; unset it to index those.",
            file=sys.stderr,
        )
    WATCH_ROOT = root
    return root


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Watch a Claude Code project and index context into ChromaDB."
    )
    parser.add_argument("--folder", default=None, help="Project root (overrides CODE_PROJECT_PATH).")
    args = parser.parse_args(argv)
    watch(resolve_folder(args.folder))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
