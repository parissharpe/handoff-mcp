"""
Plain-script test for watchers/cowork.py (no pytest required).

Run with:
    python watchers\\test_cowork.py

Exits 0 on success, non-zero on any failure.

The test exercises index_file directly (not the full watchdog observer loop),
which is the most reliable approach on Windows. Because the watcher now talks to
a Chroma SERVER over HTTP (not an embedded PersistentClient), the test spins up
a local Chroma server on a temp store + dedicated port, points the watcher's
CHROMA_HOST/CHROMA_PORT at it, then verifies that a known .md file is added to
the cowork_sessions collection with the correct stable id and that the shared
metadata contract (notably created_at) is honored.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

CHROMA_HOST = "localhost"
CHROMA_PORT = 8976  # unusual port to avoid clashing with a real server


def _find_chroma_exe() -> str | None:
    """Locate the chroma server CLI (a native binary in chromadb >= 1.x)."""
    found = shutil.which("chroma")
    if found:
        return found
    exe = "chroma.exe" if os.name == "nt" else "chroma"
    interp_dir = Path(sys.executable).parent
    for cand in (interp_dir / exe, interp_dir / "Scripts" / exe, interp_dir / "bin" / exe):
        if cand.exists():
            return str(cand)
    return None


def _wait_for_server(base_url: str, timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/api/v2/heartbeat", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _start_server(store_dir: Path):
    """Start a local Chroma server subprocess backed by store_dir."""
    chroma = _find_chroma_exe()
    if not chroma:
        return None
    proc = subprocess.Popen(
        [
            chroma, "run",
            "--path", str(store_dir),
            "--host", CHROMA_HOST,
            "--port", str(CHROMA_PORT),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


def main() -> int:
    # Two separate temp dirs: one for the watched folder, one for the store.
    cowork_dir = Path(tempfile.mkdtemp(prefix="cowork_out_"))
    store_dir = Path(tempfile.mkdtemp(prefix="handoff_store_"))

    # Point the watcher's env vars at the temp dirs / server BEFORE importing
    # cowork so any module-level resolution picks them up; cowork resolves lazily.
    os.environ["COWORK_OUTPUT_FOLDER"] = str(cowork_dir)
    os.environ["HANDOFF_STORE_PATH"] = str(store_dir)
    os.environ["CHROMA_HOST"] = CHROMA_HOST
    os.environ["CHROMA_PORT"] = str(CHROMA_PORT)

    # Make sure we can import the sibling module regardless of CWD.
    sys.path.insert(0, str(Path(__file__).resolve().parent))

    base_url = f"http://{CHROMA_HOST}:{CHROMA_PORT}"
    failures = []
    server = None
    try:
        server = _start_server(store_dir)
        if server is None:
            print("TEST FAILED: could not locate the `chroma` server executable")
            return 1
        if not _wait_for_server(base_url):
            print(f"TEST FAILED: Chroma server did not start on {base_url}")
            return 1

        import cowork

        # Fresh state in case of repeated runs in the same process.
        cowork.reset_collection_cache()
        cowork.reset_debounce_state()

        # 1. Write a known .md file into the watched folder.
        known_content = (
            "# Cowork Test Note\n\n"
            "This is a known body of text used to verify indexing.\n"
            "It contains some unicode: café — ☃.\n"
        )
        md_path = cowork_dir / "session-notes.md"
        md_path.write_text(known_content, encoding="utf-8")

        abs_md = str(md_path.resolve())
        expected_id = cowork.stable_id(abs_md)

        # 2. Index it directly.
        result = cowork.index_file(md_path)
        if result is not True:
            failures.append(f"index_file returned {result!r}, expected True")

        # 2b. Re-indexing unchanged file should be debounced (return False).
        again = cowork.index_file(md_path)
        if again is not False:
            failures.append(
                f"second index_file returned {again!r}, expected False (debounce)"
            )

        # 2c. A temp/lock-style file should be skipped.
        lock_path = cowork_dir / "~$session-notes.md"
        lock_path.write_text("garbage", encoding="utf-8")
        if cowork.index_file(lock_path) is not False:
            failures.append("temp/lock file (~$...) was not skipped")

        # 2d. A directory should be skipped.
        sub = cowork_dir / "subdir"
        sub.mkdir()
        if cowork.index_file(sub) is not False:
            failures.append("directory was not skipped")

        # 3. Open the same collection via a fresh HttpClient and verify.
        import chromadb

        client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
        collection = client.get_or_create_collection("cowork_sessions")

        got = collection.get(ids=[expected_id], include=["documents", "metadatas"])

        ids = got.get("ids") or []
        if expected_id not in ids:
            failures.append(
                f"expected id {expected_id} not found in collection; got ids={ids}"
            )
        else:
            idx = ids.index(expected_id)
            docs = got.get("documents") or []
            metas = got.get("metadatas") or []

            doc = docs[idx] if idx < len(docs) else None
            meta = metas[idx] if idx < len(metas) else None

            if doc is None or "known body of text" not in doc:
                failures.append(
                    f"document text mismatch: {doc!r}"
                )

            if not isinstance(meta, dict):
                failures.append(f"metadata is not a dict: {meta!r}")
            else:
                # Required contract fields.
                for field, expected in (
                    ("source", "cowork"),
                    ("type", "cowork"),
                    ("path", abs_md),
                    ("filename", "session-notes.md"),
                ):
                    if meta.get(field) != expected:
                        failures.append(
                            f"metadata[{field!r}] = {meta.get(field)!r}, "
                            f"expected {expected!r}"
                        )

                # created_at and modified_at must be present, non-empty strings.
                for field in ("created_at", "modified_at"):
                    val = meta.get(field)
                    if not isinstance(val, str) or not val:
                        failures.append(
                            f"metadata[{field!r}] missing/invalid: {val!r}"
                        )

                # All metadata values must be primitives (Chroma constraint).
                for k, v in meta.items():
                    if not isinstance(v, (str, int, float, bool)):
                        failures.append(
                            f"metadata[{k!r}] is non-primitive: {type(v).__name__}"
                        )

    except Exception as exc:  # pragma: no cover - surfaces unexpected errors
        import traceback

        traceback.print_exc()
        failures.append(f"unexpected exception: {exc}")
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except Exception:
                server.kill()
        shutil.rmtree(cowork_dir, ignore_errors=True)
        shutil.rmtree(store_dir, ignore_errors=True)

    if failures:
        print("TEST FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("TEST PASSED: cowork index_file wrote the expected doc + metadata.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
