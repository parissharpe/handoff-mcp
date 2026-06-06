"""
handoff-mcp :: watchers/cowork.py

Watches the Cowork output folder (COWORK_OUTPUT_FOLDER) and indexes new/modified
files into the `cowork_sessions` Chroma collection. All the heavy lifting lives
in _indexer.py; this module only declares the cowork-specific configuration and
the CLI.

Usage:
    set COWORK_OUTPUT_FOLDER=C:\\path\\to\\cowork\\output
    # Endpoint discovered from CHROMA_HOST/PORT or <HANDOFF_STORE_PATH>/server.json
    python watchers\\cowork.py
    python watchers\\cowork.py --folder C:\\some\\folder

A Chroma server must be reachable (the MCP server starts one; or run
`chroma run --path <HANDOFF_STORE_PATH>` yourself).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Optional

# Allow running both as `python watchers/cowork.py` and via import in tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _indexer import (  # noqa: E402
    Indexer,
    get_chroma_endpoint,
    get_store_path,
    reset_collection_cache,
    reset_debounce_state,
    stable_id,
)

COLLECTION_NAME = "cowork_sessions"

# Cowork indexes any text file written to the output folder.
_indexer = Indexer(collection=COLLECTION_NAME, source="cowork")


def index_file(path, *, force: bool = False) -> bool:
    """Index a single file into cowork_sessions (see _indexer.Indexer.index_file)."""
    return _indexer.index_file(path, force=force)


def initial_scan(folder) -> int:
    return _indexer.initial_scan(folder)


def watch(folder) -> None:
    _indexer.watch(folder)


# Re-exported for tests / external callers.
__all__ = [
    "index_file",
    "initial_scan",
    "watch",
    "stable_id",
    "reset_collection_cache",
    "reset_debounce_state",
    "get_chroma_endpoint",
    "get_store_path",
    "COLLECTION_NAME",
]


def resolve_folder(cli_folder: Optional[str]) -> Path:
    raw = cli_folder or os.environ.get("COWORK_OUTPUT_FOLDER")
    if not raw:
        raise SystemExit(
            "[cowork] No folder to watch. Set COWORK_OUTPUT_FOLDER or pass --folder <path>."
        )
    return Path(os.path.expanduser(raw))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Watch a Cowork output folder and index files into ChromaDB."
    )
    parser.add_argument("--folder", default=None, help="Folder to watch (overrides COWORK_OUTPUT_FOLDER).")
    args = parser.parse_args(argv)
    watch(resolve_folder(args.folder))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
