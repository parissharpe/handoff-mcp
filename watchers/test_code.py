"""
Plain-script test for watchers/code.py (no pytest required).

Run with:
    python watchers\\test_code.py

Spins up a local Chroma server on a temp store + dedicated port, builds a small
fake project, runs code.initial_scan, and asserts that ONLY the curated Code
context files were indexed into code_sessions (CLAUDE.md + transcripts), that
noise dirs were pruned, and that the shared metadata contract (+ repo) holds.
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
CHROMA_PORT = 8978  # distinct from the cowork test's port


def _find_chroma_exe():
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
    chroma = _find_chroma_exe()
    if not chroma:
        return None
    return subprocess.Popen(
        [chroma, "run", "--path", str(store_dir), "--host", CHROMA_HOST, "--port", str(CHROMA_PORT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> int:
    project_dir = Path(tempfile.mkdtemp(prefix="code_proj_"))
    store_dir = Path(tempfile.mkdtemp(prefix="handoff_store_"))

    os.environ["CODE_PROJECT_PATH"] = str(project_dir)
    os.environ["HANDOFF_STORE_PATH"] = str(store_dir)
    os.environ["CHROMA_HOST"] = CHROMA_HOST
    os.environ["CHROMA_PORT"] = str(CHROMA_PORT)

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

        import code as code_watcher

        code_watcher.reset_collection_cache()
        code_watcher.reset_debounce_state()

        # Build a fake project: 2 relevant files, 2 that must be ignored.
        (project_dir / "CLAUDE.md").write_text(
            "# Project memory\n\nBuild notes for the strategist.\n", encoding="utf-8"
        )
        (project_dir / "transcripts").mkdir()
        (project_dir / "transcripts" / "session-1.jsonl").write_text(
            '{"role":"user","content":"implement the store"}\n', encoding="utf-8"
        )
        (project_dir / "src").mkdir()
        (project_dir / "src" / "main.py").write_text("print('hello')\n", encoding="utf-8")  # not relevant
        (project_dir / "node_modules" / "pkg").mkdir(parents=True)
        (project_dir / "node_modules" / "pkg" / "CLAUDE.md").write_text(
            "should be pruned", encoding="utf-8"
        )

        # Predicate sanity checks.
        if not code_watcher.code_relevant(project_dir / "CLAUDE.md"):
            failures.append("code_relevant should accept CLAUDE.md")
        if code_watcher.code_relevant(project_dir / "src" / "main.py"):
            failures.append("code_relevant should reject a plain .py source file")

        indexed = code_watcher.initial_scan(project_dir)
        if indexed != 2:
            failures.append(f"initial_scan indexed {indexed}, expected 2 (CLAUDE.md + jsonl)")

        # Verify contents via a fresh HttpClient.
        import chromadb

        client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
        col = client.get_or_create_collection("code_sessions")
        got = col.get(include=["metadatas"])
        ids = got.get("ids") or []
        metas = got.get("metadatas") or []

        expected_repo = project_dir.name
        claude_id = code_watcher.stable_id(str((project_dir / "CLAUDE.md").resolve()))
        jsonl_id = code_watcher.stable_id(str((project_dir / "transcripts" / "session-1.jsonl").resolve()))
        pruned_id = code_watcher.stable_id(str((project_dir / "node_modules" / "pkg" / "CLAUDE.md").resolve()))
        main_id = code_watcher.stable_id(str((project_dir / "src" / "main.py").resolve()))

        if claude_id not in ids:
            failures.append("CLAUDE.md was not indexed")
        if jsonl_id not in ids:
            failures.append("transcripts/*.jsonl was not indexed")
        if pruned_id in ids:
            failures.append("node_modules/**/CLAUDE.md was indexed (prune failed)")
        if main_id in ids:
            failures.append("src/main.py was indexed (relevance filter failed)")

        for i, _id in enumerate(ids):
            meta = metas[i] if i < len(metas) else None
            if not isinstance(meta, dict):
                failures.append(f"metadata for {_id} is not a dict")
                continue
            if meta.get("source") != "code" or meta.get("type") != "code":
                failures.append(f"metadata source/type wrong: {meta}")
            if meta.get("repo") != expected_repo:
                failures.append(f"metadata repo = {meta.get('repo')!r}, expected {expected_repo!r}")
            if not isinstance(meta.get("created_at"), str) or not meta.get("created_at"):
                failures.append("metadata missing created_at")
            for k, v in meta.items():
                if not isinstance(v, (str, int, float, bool)):
                    failures.append(f"metadata[{k!r}] non-primitive: {type(v).__name__}")

    except Exception as exc:
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
        shutil.rmtree(project_dir, ignore_errors=True)
        shutil.rmtree(store_dir, ignore_errors=True)

    if failures:
        print("TEST FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("TEST PASSED: code watcher indexed only the curated Code context files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
