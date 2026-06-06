"""
handoff-mcp :: watchers/_indexer.py

Shared indexing engine for the Cowork and Code watchers. Holds everything that
is identical between them — Chroma endpoint discovery (server.json), text
extraction, skip/binary heuristics, debounce, and the watchdog event loop — so
each concrete watcher (cowork.py, code.py) only declares WHAT to index.

CONNECTION MODE: HTTP client. The MCP server owns one Chroma server (it writes
<HANDOFF_STORE_PATH>/server.json); watchers connect to it via chromadb.HttpClient
so there is a single on-disk writer and no SQLite lock conflict.

Metadata contract written for every document (primitives only — Chroma rule):
    source       : the watcher's source label (e.g. "cowork", "code")
    type         : same as source
    path         : absolute file path
    filename     : file name
    created_at   : ISO-8601 UTC index time (what the TS side sorts "recent" on)
    modified_at  : file mtime as ISO-8601 UTC
    ...plus any per-watcher extras (e.g. code adds "repo")
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_STORE_PATH = Path.home() / ".handoff" / "db"
DEFAULT_CHROMA_HOST = "localhost"
DEFAULT_CHROMA_PORT = 8000

TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".rst", ".json", ".jsonl", ".yaml", ".yml",
    ".csv", ".tsv", ".log", ".html", ".htm", ".xml", ".py", ".js", ".ts",
    ".tsx", ".jsx", ".css", ".ini", ".cfg", ".toml", ".env", ".sh", ".bat",
    ".ps1", ".sql",
}

SKIP_EXTENSIONS = {
    ".tmp", ".temp", ".swp", ".swo", ".swx", ".lock", ".bak", ".part",
    ".crdownload", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".pdf",
    ".zip", ".gz", ".tar", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib",
    ".bin", ".pyc", ".class", ".o", ".obj", ".mp3", ".mp4", ".mov", ".avi",
    ".wav", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
}

MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB


# ---------------------------------------------------------------------------
# Store / endpoint discovery
# ---------------------------------------------------------------------------

_collection_cache: dict = {}


def get_store_path() -> Path:
    """Resolve the store path from HANDOFF_STORE_PATH (expanding ~).

    Informational in HTTP mode (the server owns the dir); still resolved/created
    so logs and the server.json lookup have a valid location.
    """
    raw = os.environ.get("HANDOFF_STORE_PATH")
    path = Path(os.path.expanduser(raw)) if raw else DEFAULT_STORE_PATH
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_endpoint_file() -> Optional[dict]:
    """Read <HANDOFF_STORE_PATH>/server.json written by the MCP server, if any."""
    f = get_store_path() / "server.json"
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "port" in data:
            return {
                "host": str(data.get("host", DEFAULT_CHROMA_HOST)),
                "port": int(data["port"]),
            }
    except Exception:
        pass
    return None


def get_chroma_endpoint() -> tuple[str, int]:
    """Resolve the Chroma endpoint: env per-field > server.json > defaults."""
    env_host = os.environ.get("CHROMA_HOST")
    env_port = os.environ.get("CHROMA_PORT")
    ep = read_endpoint_file() if (not env_host or not env_port) else None

    host = env_host or (ep["host"] if ep else DEFAULT_CHROMA_HOST)
    if env_port:
        try:
            port = int(env_port)
        except ValueError:
            port = DEFAULT_CHROMA_PORT
    elif ep:
        port = ep["port"]
    else:
        port = DEFAULT_CHROMA_PORT
    return host, port


def get_collection(name: str):
    """Return a collection from the shared Chroma server (cached per host:port:name)."""
    host, port = get_chroma_endpoint()
    cache_key = f"{host}:{port}:{name}"
    cached = _collection_cache.get(cache_key)
    if cached is not None:
        return cached

    import chromadb

    client = chromadb.HttpClient(host=host, port=port)
    collection = client.get_or_create_collection(name)
    _collection_cache[cache_key] = collection
    return collection


def reset_collection_cache() -> None:
    """Clear cached clients/collections (useful between tests)."""
    _collection_cache.clear()


# ---------------------------------------------------------------------------
# File filtering / text extraction
# ---------------------------------------------------------------------------

def stable_id(abs_path: str) -> str:
    """Stable sha1 hex id from the absolute path (so re-index UPSERTS)."""
    return hashlib.sha1(abs_path.encode("utf-8")).hexdigest()


def should_skip(path: Path) -> bool:
    """True for temp/lock/binary files we should ignore."""
    name = path.name
    if name.startswith("~$") or name.startswith(".~") or name.startswith("~"):
        return True
    if name.startswith(".") and name.endswith(".swp"):
        return True
    if name.endswith("~"):
        return True
    if path.suffix.lower() in SKIP_EXTENSIONS:
        return True
    return False


def is_probably_text(path: Path) -> bool:
    """Heuristic: known text ext, or unknown ext with no NUL bytes in head."""
    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS:
        return True
    if ext in SKIP_EXTENSIONS:
        return False
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(4096)
    except OSError:
        return False
    return b"\x00" not in chunk


def extract_text(path: Path) -> Optional[str]:
    """Read UTF-8 text (errors='replace'); None if it should be skipped."""
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size == 0:
        return ""
    read_bytes = MAX_FILE_BYTES if size > MAX_FILE_BYTES else size
    try:
        with open(path, "rb") as fh:
            raw = fh.read(read_bytes)
    except OSError:
        return None
    if path.suffix.lower() not in TEXT_EXTENSIONS and b"\x00" in raw[:4096]:
        return None
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Debounce
# ---------------------------------------------------------------------------

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
# Indexer
# ---------------------------------------------------------------------------

class Indexer:
    """Indexes files into one Chroma collection with a shared metadata contract.

    Parameters let each watcher declare WHAT to index:
      collection      : Chroma collection name (e.g. "cowork_sessions")
      source          : metadata source/type label (e.g. "cowork")
      relevant        : optional predicate(Path)->bool; default indexes any text file
      extra_metadata  : optional callable(Path)->dict of extra primitive fields
      prune_dirs      : directory names to skip entirely (e.g. node_modules)
    """

    def __init__(
        self,
        *,
        collection: str,
        source: str,
        relevant: Optional[Callable[[Path], bool]] = None,
        extra_metadata: Optional[Callable[[Path], dict]] = None,
        prune_dirs: Optional[Iterable[str]] = None,
    ) -> None:
        self.collection = collection
        self.source = source
        self.relevant = relevant or (lambda _p: True)
        self.extra_metadata = extra_metadata or (lambda _p: {})
        self.prune_dirs = {d.lower() for d in (prune_dirs or [])}

    def _is_pruned(self, path: Path) -> bool:
        if not self.prune_dirs:
            return False
        return any(part.lower() in self.prune_dirs for part in path.parts)

    def index_file(self, path, *, force: bool = False) -> bool:
        """Index one file. Returns True if indexed, False if skipped."""
        p = Path(path)
        if p.is_dir() or not p.exists():
            return False
        if should_skip(p) or self._is_pruned(p):
            return False
        if not self.relevant(p):
            return False

        abs_path = str(p.resolve())
        try:
            st = p.stat()
        except OSError:
            return False
        mtime, size = st.st_mtime, st.st_size

        if not force and not _changed_since_last(abs_path, mtime, size):
            return False
        if not is_probably_text(p):
            return False

        text = extract_text(p)
        if text is None:
            return False

        metadata = {
            "source": self.source,
            "type": self.source,
            "path": abs_path,
            "filename": p.name,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "modified_at": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
        }
        # Per-watcher extras (must be primitives).
        for k, v in (self.extra_metadata(p) or {}).items():
            metadata[k] = v

        collection = get_collection(self.collection)
        doc_id = stable_id(abs_path)
        upsert = getattr(collection, "upsert", None)
        if callable(upsert):
            upsert(documents=[text], ids=[doc_id], metadatas=[metadata])
        else:  # pragma: no cover - older chromadb fallback
            collection.add(documents=[text], ids=[doc_id], metadatas=[metadata])
        return True

    def initial_scan(self, folder) -> int:
        """Index all existing relevant files under `folder`. Returns count."""
        folder = Path(folder)
        if not folder.exists():
            return 0
        count = 0
        for entry in folder.rglob("*"):
            if entry.is_file():
                try:
                    if self.index_file(entry):
                        count += 1
                except Exception as exc:
                    print(f"[{self.source}] failed to index {entry}: {exc}", file=sys.stderr)
        return count

    def _make_event_handler(self):
        from watchdog.events import FileSystemEventHandler

        indexer = self

        class _Handler(FileSystemEventHandler):
            def _handle(self, src):
                if not src:
                    return
                try:
                    if indexer.index_file(src):
                        print(f"[{indexer.source}] indexed {src}")
                except Exception as exc:
                    print(f"[{indexer.source}] error indexing {src}: {exc}", file=sys.stderr)

            def on_created(self, event):
                if not event.is_directory:
                    self._handle(getattr(event, "src_path", None))

            def on_modified(self, event):
                if not event.is_directory:
                    self._handle(getattr(event, "src_path", None))

            def on_moved(self, event):
                if not event.is_directory:
                    self._handle(getattr(event, "dest_path", None))

        return _Handler()

    def watch(self, folder) -> None:
        """Run the blocking watchdog observer loop on `folder`."""
        from watchdog.observers import Observer

        folder_path = Path(folder)
        if not folder_path.exists():
            raise SystemExit(f"[{self.source}] watch folder does not exist: {folder_path}")

        host, port = get_chroma_endpoint()
        print(f"[{self.source}] chroma endpoint: http://{host}:{port}")
        print(f"[{self.source}] store path (server-owned): {get_store_path()}")
        print(f"[{self.source}] initial scan of: {folder_path}")
        indexed = self.initial_scan(folder_path)
        print(f"[{self.source}] initial scan indexed {indexed} file(s)")

        observer = Observer()
        observer.schedule(self._make_event_handler(), str(folder_path), recursive=True)
        observer.start()
        print(f"[{self.source}] watching {folder_path} (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print(f"[{self.source}] stopping...")
        finally:
            observer.stop()
            observer.join()
