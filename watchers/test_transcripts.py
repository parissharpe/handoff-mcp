"""
Plain-script test for watchers/_transcripts.py + code.py tagging (no pytest).

Covers the defect this branch exists to fix: two transcripts under DIFFERENT
encoded project directories must receive DIFFERENT `repo` tags, derived from the
`cwd` recorded inside each transcript rather than from the encoded directory
name (which is lossy and, on at least one real machine, wrong).

Also covers the schema-drift guard: a file that parses but carries no
conversation must yield zero chunks rather than silently producing junk.

Run:  python watchers/test_transcripts.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import code as codewatcher  # noqa: E402
from _transcripts import parse_transcript, project_for_path, reset_project_cache  # noqa: E402

FAILURES: list[str] = []


def check(cond: bool, label: str, detail: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}" + (f"  ::  {detail}" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _record(**kw) -> str:
    return json.dumps(kw)


def _session(path: Path, cwd: str, session_id: str, version: str, branch: str,
             turns: list[tuple[str, str]]) -> None:
    """Write a minimal but realistic transcript."""
    lines = []
    for i, (role, text) in enumerate(turns):
        lines.append(_record(
            type=role, sessionId=session_id, uuid=f"u{i}", cwd=cwd,
            version=version, gitBranch=branch,
            timestamp=f"2026-08-3{i % 9}T00:00:0{i % 9}Z",
            message={"role": role, "content": [{"type": "text", "text": text}]},
        ))
        # Plumbing that must be excluded from the indexed text.
        lines.append(_record(
            type="assistant", sessionId=session_id, uuid=f"t{i}", cwd=cwd,
            message={"role": "assistant", "content": [
                {"type": "tool_use", "id": "x", "name": "Bash", "input": {"command": "ls"}},
                {"type": "thinking", "thinking": "", "signature": "B" * 400},
            ]},
        ))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="handoff-transcripts-test-"))
    try:
        projects = tmp / "projects"
        # Two encoded dirs whose names would decode WRONG; cwd is authoritative.
        alpha_dir = projects / "C--Users-someone-Desktop-Alpha-Project"
        beta_dir = projects / "C--Users-someone-Desktop-beta-tool"
        alpha_dir.mkdir(parents=True)
        beta_dir.mkdir(parents=True)

        # Alpha's real path has a SPACE where the encoding shows a dash.
        alpha_cwd = r"C:\Users\someone\Desktop\Alpha Project"
        beta_cwd = r"C:\Users\someone\Desktop\beta-tool"

        _session(alpha_dir / "aaaaaaaa-0000-0000-0000-000000000001.jsonl",
                 alpha_cwd, "aaaaaaaa-0000-0000-0000-000000000001", "2.1.219", "main",
                 [("user", "How do I calibrate the alpha sensor array?"),
                  ("assistant", "Calibrate the alpha sensor array from the config file.")])
        _session(beta_dir / "bbbbbbbb-0000-0000-0000-000000000002.jsonl",
                 beta_cwd, "bbbbbbbb-0000-0000-0000-000000000002", "2.1.209", "dev",
                 [("user", "The beta tool crashes when parsing an empty manifest."),
                  ("assistant", "Guard the empty-manifest case before parsing.")])

        reset_project_cache()

        # --- 1. different encoded dirs -> different repo tags ---
        a_repo, a_path = project_for_path(
            alpha_dir / "aaaaaaaa-0000-0000-0000-000000000001.jsonl", projects)
        b_repo, b_path = project_for_path(
            beta_dir / "bbbbbbbb-0000-0000-0000-000000000002.jsonl", projects)
        check(a_repo != b_repo, "two encoded project dirs get DIFFERENT repo tags",
              f"{a_repo!r} vs {b_repo!r}")
        check(a_repo == "Alpha Project", "repo comes from cwd, not the encoded name",
              f"got {a_repo!r} (encoded name would give 'Alpha-Project')")
        check(b_repo == "beta-tool", "second project tagged from its own cwd", f"got {b_repo!r}")
        check(a_path == alpha_cwd and b_path == beta_cwd,
              "project_path carries the full cwd")

        # --- 2. same via the watcher's metadata hook ---
        codewatcher.WATCH_ROOT = projects
        reset_project_cache()
        ma = codewatcher.code_metadata(alpha_dir / "aaaaaaaa-0000-0000-0000-000000000001.jsonl")
        mb = codewatcher.code_metadata(beta_dir / "bbbbbbbb-0000-0000-0000-000000000002.jsonl")
        check(ma.get("repo") != mb.get("repo"),
              "code_metadata tags the two files differently",
              f"{ma.get('repo')!r} vs {mb.get('repo')!r}")

        # --- 3. unresolvable project -> "unknown", never a guess ---
        orphan = projects / "C--Users-someone-Nothing-Here"
        orphan.mkdir()
        (orphan / "empty.jsonl").write_text("", encoding="utf-8")
        reset_project_cache()
        o_repo, o_path = project_for_path(orphan / "empty.jsonl", projects)
        check(o_repo == "unknown" and o_path == "",
              "no cwd anywhere -> tagged 'unknown' rather than guessed", f"got {o_repo!r}")

        # --- 4. chunking keeps only conversation ---
        chunks, stats = parse_transcript(
            alpha_dir / "aaaaaaaa-0000-0000-0000-000000000001.jsonl")
        joined = "\n".join(c.text for c in chunks)
        check(len(chunks) >= 1, "transcript produced chunks", f"{len(chunks)}")
        check("calibrate the alpha sensor" in joined.lower(), "conversation text is kept")
        check("BBBB" not in joined and "tool_use" not in joined,
              "thinking signatures and tool_use plumbing are excluded")
        check(stats.version == "2.1.219", "transcript version captured", str(stats.version))
        check(stats.git_branch == "main", "git branch captured", str(stats.git_branch))
        check(stats.cwd == alpha_cwd, "cwd captured")
        check(all(len(c.text) <= 2400 for c in chunks), "no chunk exceeds the hard cap")

        # --- 5. stable, idempotent chunk ids ---
        from _indexer import chunk_id
        p = str((alpha_dir / "aaaaaaaa-0000-0000-0000-000000000001.jsonl").resolve())
        check(chunk_id(p, 0) == chunk_id(p, 0), "chunk_id is deterministic")
        check(chunk_id(p, 0) != chunk_id(p, 1), "chunk_id varies by index")

        # --- 6. schema-drift guard: parses fine, no conversation ---
        drift = alpha_dir / "journal-like.jsonl"
        drift.write_text(
            "\n".join([_record(type="started", id="1"), _record(type="result", id="1")]) + "\n",
            encoding="utf-8")
        dchunks, dstats = parse_transcript(drift)
        check(len(dchunks) == 0 and dstats.records_parsed == 2,
              "records that carry no conversation yield ZERO chunks",
              f"chunks={len(dchunks)} records={dstats.records_parsed}")
        check("started" in dstats.histogram(),
              "histogram names the unexpected record types", dstats.histogram())

        # --- 7. malformed lines are counted, never raised ---
        bad = alpha_dir / "malformed.jsonl"
        bad.write_text("{not json\n" + _record(
            type="user", sessionId="s", cwd=alpha_cwd,
            message={"role": "user", "content": "a real turn survives the bad line"},
        ) + "\n", encoding="utf-8")
        bchunks, bstats = parse_transcript(bad)
        check(bstats.records_malformed == 1, "malformed line counted", str(bstats.records_malformed))
        check(len(bchunks) == 1, "valid records still indexed alongside a bad line")

        # --- 8. journal.jsonl is not treated as a transcript ---
        check(not codewatcher.code_relevant(alpha_dir / "journal.jsonl"),
              "journal.jsonl excluded (workflow log, not conversation)")
        check(not codewatcher.code_relevant(alpha_dir / "agent-x.meta.json"),
              ".meta.json sidecars excluded")
        check(codewatcher.code_relevant(alpha_dir / "memory" / "MEMORY.md"),
              "memory/*.md still indexed (original predicate preserved)")

        print("\n" + ("ALL TRANSCRIPT TESTS PASSED" if not FAILURES
                      else f"{len(FAILURES)} TRANSCRIPT TEST(S) FAILED"))
        return 0 if not FAILURES else 1
    finally:
        codewatcher.WATCH_ROOT = None
        reset_project_cache()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
