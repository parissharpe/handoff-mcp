"""
handoff-mcp :: watchers/code.py

Watches a Claude Code project (CODE_PROJECT_PATH) and indexes its memory/context
files into the `code_sessions` Chroma collection so the strategist can see what
Code has been doing. Built on the shared _indexer engine.

What it indexes (a curated set, NOT the whole source tree):
  - CLAUDE.md / CLAUDE.local.md anywhere in the project
  - Files under a `transcripts/` or `.claude/` directory
  - *.jsonl transcript files

Noise directories (node_modules, .git, dist, build, .venv, ...) are pruned.
Each document gets a `repo` metadata field (the project dir name) so
get_recent_code_context(repo=...) can filter.

Usage:
    set CODE_PROJECT_PATH=C:\\path\\to\\your\\project
    python watchers\\code.py
    python watchers\\code.py --folder C:\\some\\project
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
)

COLLECTION_NAME = "code_sessions"

CODE_FILENAMES = {"claude.md", "claude.local.md"}
CODE_CONTEXT_DIRS = {"transcripts", ".claude"}
PRUNE_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "__pycache__",
    ".venv", "venv", ".next", ".turbo", ".cache", "coverage",
}


def code_relevant(path: Path) -> bool:
    """True only for Code memory/context files (not the whole source tree)."""
    if path.name.lower() in CODE_FILENAMES:
        return True
    lower_parts = {part.lower() for part in path.parts}
    if lower_parts & CODE_CONTEXT_DIRS:
        return True
    if path.suffix.lower() == ".jsonl":
        return True
    return False


def _repo_name() -> str:
    root = os.environ.get("CODE_PROJECT_PATH")
    if root:
        return Path(os.path.expanduser(root)).name
    return ""


def code_metadata(path: Path) -> dict:
    repo = _repo_name() or path.parent.name
    return {"repo": repo}


_indexer = Indexer(
    collection=COLLECTION_NAME,
    source="code",
    relevant=code_relevant,
    extra_metadata=code_metadata,
    prune_dirs=PRUNE_DIRS,
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
    "stable_id",
    "reset_collection_cache",
    "reset_debounce_state",
    "get_chroma_endpoint",
    "get_store_path",
    "COLLECTION_NAME",
]


def resolve_folder(cli_folder: Optional[str]) -> Path:
    raw = cli_folder or os.environ.get("CODE_PROJECT_PATH")
    if not raw:
        raise SystemExit(
            "[code] No project to watch. Set CODE_PROJECT_PATH or pass --folder <path>."
        )
    return Path(os.path.expanduser(raw))


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
