"""
handoff-mcp :: watchers/cowork.py

A Windows-first file watcher that indexes files produced in a "cowork" output
folder into a local ChromaDB collection (`cowork_sessions`). The same ChromaDB
store is served by the TypeScript MCP server, so the metadata contract below
MUST be honored exactly.

CONNECTION MODE: HTTP client (NOT embedded).
    The chromadb npm client used on the TypeScript side is server-based: the MCP
    server owns a single Chroma server process that holds the on-disk store at
    HANDOFF_STORE_PATH. To avoid a SQLite lock conflict (an embedded
    PersistentClient and a server cannot hold the same directory at once), this
    watcher connects to that SAME server over HTTP via chromadb.HttpClient,
    pointed at CHROMA_HOST / CHROMA_PORT (default localhost:8000). The server is
    the single writer to disk; the watcher is just another HTTP client.

Usage:
    # Required env var (or use --folder for testing):
    set COWORK_OUTPUT_FOLDER=C:\\path\\to\\cowork\\output
    # The Chroma server endpoint (must match the MCP server's). Defaults to
    # localhost:8000.
    set CHROMA_HOST=localhost
    set CHROMA_PORT=8000

    python watchers\\cowork.py
    python watchers\\cowork.py --folder C:\\some\\folder

NOTE: a Chroma server must be reachable at CHROMA_HOST:CHROMA_PORT. The MCP
server starts one automatically; you can also run one with
`chroma run --path <HANDOFF_STORE_PATH>`.

The indexing logic (`index_file`) is intentionally decoupled from the watchdog
event loop so it can be unit-tested directly and reused for an initial scan of
pre-existing files on startup.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

COLLECTION_NAME = "cowork_sessions"
DEFAULT_STORE_PATH = Path.home() / ".handoff" / "db"
DEFAULT_CHROMA_HOST = "localhost"
DEFAULT_CHROMA_PORT = 8000

# Text-ish extensions we always treat as readable UTF-8 text.
TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".markdown",
    ".rst",
    ".json",
    ".yaml",
    ".yml",
    ".csv",
    ".tsv",
    ".log",
    ".html",
    ".htm",
    ".xml",
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".css",
    ".ini",
    ".cfg",
    ".toml",
    ".env",
    ".sh",
    ".bat",
    ".ps1",
    ".sql",
}

# Extensions / patterns we know are binary or transient and should be skipped.
SKIP_EXTENSIONS = {
    ".tmp",
    ".temp",
    ".swp",
    ".swo",
    ".swx",
    ".lock",
    ".bak",
    ".part",
    ".crdownload",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".pyc",
    ".class",
    ".o",
    ".obj",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".wav",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
}

# Max bytes to read from any single file (avoid pulling huge files into memory).
MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB


# ---------------------------------------------------------------------------
# Store / collection access (lazily created, cached on the module)
# ---------------------------------------------------------------------------

_collection_cache = {}


def get_store_path() -> Path:
    """Resolve the ChromaDB store path from HANDOFF_STORE_PATH (expanding ~).

    Informational only: in HTTP mode the *server* owns this directory. We still
    resolve/create it so logs and standalone-server commands have a valid path.
    """
    raw = os.environ.get("HANDOFF_STORE_PATH")
    if raw:
        path = Path(os.path.expanduser(raw))
    else:
        path = DEFAULT_STORE_PATH
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_chroma_endpoint() -> tuple[str, int]:
    """Resolve the Chroma server endpoint from CHROMA_HOST / CHROMA_PORT."""
    host = os.environ.get("CHROMA_HOST", DEFAULT_CHROMA_HOST)
    try:
        port = int(os.environ.get("CHROMA_PORT", str(DEFAULT_CHROMA_PORT)))
    except ValueError:
        port = DEFAULT_CHROMA_PORT
    return host, port


def get_collection():
    """Return the shared `cowork_sessions` collection, creating it if needed.

    Connects to the Chroma SERVER over HTTP (the MCP server owns the on-disk
    store). Cached per host:port endpoint so repeated index_file calls reuse one
    client.
    """
    host, port = get_chroma_endpoint()
    cache_key = f"{host}:{port}"
    cached = _collection_cache.get(cache_key)
    if cached is not None:
        return cached

    # Imported lazily so that importing this module (e.g. for tests that only
    # touch helper functions) does not require chromadb up front.
    import chromadb

    client = chromadb.HttpClient(host=host, port=port)
    # Use Chroma's DEFAULT embedding function (local all-MiniLM-L6-v2 style) by
    # NOT passing an embedding_function argument. No API key required.
    collection = client.get_or_create_collection(COLLECTION_NAME)
    _collection_cache[cache_key] = collection
    return collection


def reset_collection_cache() -> None:
    """Clear the cached client/collection (useful between tests)."""
    _collection_cache.clear()


# ---------------------------------------------------------------------------
# File filtering / text extraction
# ---------------------------------------------------------------------------

def stable_id(abs_path: str) -> str:
    """Stable sha1 hex id derived from the absolute file path.

    Using a hash of the path means re-indexing a modified file UPSERTS over the
    same id rather than creating duplicates.
    """
    return hashlib.sha1(abs_path.encode("utf-8")).hexdigest()


def should_skip(path: Path) -> bool:
    """Return True if this path is a temp/lock/binary file we should ignore."""
    name = path.name

    # Office lock files and common editor temp prefixes.
    if name.startswith("~$") or name.startswith(".~") or name.startswith("~"):
        return True
    # Vim swap files like .file.txt.swp are caught by extension, but also
    # files that are purely a swap with no real ext.
    if name.startswith(".") and name.endswith(".swp"):
        return True
    # Hidden temp dotfiles often used as atomic-write staging.
    if name.endswith("~"):
        return True

    ext = path.suffix.lower()
    if ext in SKIP_EXTENSIONS:
        return True

    return False


def is_probably_text(path: Path) -> bool:
    """Heuristic: known text ext, OR no/unknown ext with no NUL bytes in head."""
    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS:
        return True
    if ext in SKIP_EXTENSIONS:
        return False

    # Unknown extension (or none): sniff the first chunk for NUL bytes, which
    # strongly indicate a binary file.
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(4096)
    except OSError:
        return False
    if b"\x00" in chunk:
        return False
    return True


def extract_text(path: Path) -> Optional[str]:
    """Read text content from a file, or return None if it should be skipped.

    Reads as UTF-8 with errors="replace" so malformed bytes never crash us.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return None

    if size == 0:
        # Empty file: index as empty string so it still gets a record.
        return ""

    if size > MAX_FILE_BYTES:
        # Read only the leading portion of very large files.
        read_bytes = MAX_FILE_BYTES
    else:
        read_bytes = size

    try:
        with open(path, "rb") as fh:
            raw = fh.read(read_bytes)
    except OSError:
        return None

    # Binary sniff for unknown types (text ext already trusted above).
    if path.suffix.lower() not in TEXT_EXTENSIONS and b"\x00" in raw[:4096]:
        return None

    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Debounce bookkeeping
# ---------------------------------------------------------------------------

# Maps absolute path -> (mtime, size) last seen. If a modified event arrives
# but mtime+size are unchanged, we skip re-indexing.
_last_seen: dict[str, tuple[float, int]] = {}


def _changed_since_last(abs_path: str, mtime: float, size: int) -> bool:
    prev = _last_seen.get(abs_path)
    if prev is not None and prev == (mtime, size):
        return False
    _last_seen[abs_path] = (mtime, size)
    return True


def reset_debounce_state() -> None:
    """Clear the per-path debounce cache (useful between tests)."""
    _last_seen.clear()


# ---------------------------------------------------------------------------
# Core indexing function (testable, independent of watchdog)
# ---------------------------------------------------------------------------

def index_file(path, *, force: bool = False) -> bool:
    """Index a single file into the cowork_sessions collection.

    Returns True if the file was indexed (upserted), False if it was skipped
    (directory, binary, temp file, unchanged debounce, or read failure).

    The metadata shape written here is the SHARED CONTRACT with the TypeScript
    adapter -- do not change field names without updating that side.
    """
    p = Path(path)

    # Skip directories outright.
    if p.is_dir():
        return False

    if not p.exists():
        return False

    if should_skip(p):
        return False

    abs_path = str(p.resolve())

    # Debounce on (mtime, size) unless forced.
    try:
        st = p.stat()
    except OSError:
        return False
    mtime = st.st_mtime
    size = st.st_size

    if not force and not _changed_since_last(abs_path, mtime, size):
        return False

    if not is_probably_text(p):
        return False

    text = extract_text(p)
    if text is None:
        return False

    modified_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
    created_at = datetime.now(timezone.utc).isoformat()

    metadata = {
        "source": "cowork",
        "type": "cowork",
        "path": abs_path,
        "filename": p.name,
        "created_at": created_at,
        "modified_at": modified_at,
    }

    collection = get_collection()
    doc_id = stable_id(abs_path)

    # Prefer upsert so re-indexing a modified file replaces rather than dupes.
    upsert = getattr(collection, "upsert", None)
    if callable(upsert):
        upsert(documents=[text], ids=[doc_id], metadatas=[metadata])
    else:  # pragma: no cover - older chromadb fallback
        collection.add(documents=[text], ids=[doc_id], metadatas=[metadata])

    return True


def initial_scan(folder) -> int:
    """Index all existing files in `folder` (recursively). Returns count indexed."""
    folder = Path(folder)
    count = 0
    if not folder.exists():
        return 0
    for entry in folder.rglob("*"):
        if entry.is_file():
            try:
                if index_file(entry):
                    count += 1
            except Exception as exc:  # never let one bad file kill the scan
                print(f"[cowork] failed to index {entry}: {exc}", file=sys.stderr)
    return count


# ---------------------------------------------------------------------------
# Watchdog wiring
# ---------------------------------------------------------------------------

def _make_event_handler():
    from watchdog.events import FileSystemEventHandler

    class CoworkEventHandler(FileSystemEventHandler):
        def _handle(self, event):
            if event.is_directory:
                return
            src = getattr(event, "src_path", None)
            if not src:
                return
            try:
                if index_file(src):
                    print(f"[cowork] indexed {src}")
            except Exception as exc:
                print(f"[cowork] error indexing {src}: {exc}", file=sys.stderr)

        def on_created(self, event):
            self._handle(event)

        def on_modified(self, event):
            self._handle(event)

        def on_moved(self, event):
            # Treat the destination of a move/rename as a new/changed file.
            dest = getattr(event, "dest_path", None)
            if dest and not event.is_directory:
                try:
                    if index_file(dest):
                        print(f"[cowork] indexed {dest}")
                except Exception as exc:
                    print(f"[cowork] error indexing {dest}: {exc}", file=sys.stderr)

    return CoworkEventHandler()


def watch(folder) -> None:
    """Run the blocking watchdog observer loop on `folder`."""
    from watchdog.observers import Observer

    folder_path = Path(folder)
    if not folder_path.exists():
        raise SystemExit(
            f"[cowork] watch folder does not exist: {folder_path}"
        )

    host, port = get_chroma_endpoint()
    print(f"[cowork] chroma endpoint: http://{host}:{port}")
    print(f"[cowork] store path (server-owned): {get_store_path()}")
    print(f"[cowork] initial scan of: {folder_path}")
    indexed = initial_scan(folder_path)
    print(f"[cowork] initial scan indexed {indexed} file(s)")

    handler = _make_event_handler()
    observer = Observer()
    observer.schedule(handler, str(folder_path), recursive=True)
    observer.start()
    print(f"[cowork] watching {folder_path} (Ctrl+C to stop)")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("[cowork] stopping...")
    finally:
        observer.stop()
        observer.join()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def resolve_folder(cli_folder: Optional[str]) -> Path:
    """Resolve the folder to watch from --folder or COWORK_OUTPUT_FOLDER."""
    raw = cli_folder or os.environ.get("COWORK_OUTPUT_FOLDER")
    if not raw:
        raise SystemExit(
            "[cowork] No folder to watch. Set the COWORK_OUTPUT_FOLDER "
            "environment variable or pass --folder <path>."
        )
    return Path(os.path.expanduser(raw))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Watch a cowork output folder and index files into ChromaDB."
    )
    parser.add_argument(
        "--folder",
        help="Folder to watch (overrides COWORK_OUTPUT_FOLDER).",
        default=None,
    )
    args = parser.parse_args(argv)

    folder = resolve_folder(args.folder)
    watch(folder)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
