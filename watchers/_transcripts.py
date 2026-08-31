"""
handoff-mcp :: watchers/_transcripts.py

Parser for Claude Code session transcripts (~/.claude/projects/<encoded>/*.jsonl).

WHY THIS EXISTS
---------------
Claude Code writes one newline-delimited JSON file per session. Measured across
this machine's 43 transcripts (126 MB), only ~2.6% of the bytes are actual
conversation; the rest is tool-call plumbing, echoed tool output, and opaque
base64 `thinking` signatures. Indexing such a file as one document is useless:
the embedding model has a 512-token window, so a 40 MB file would be represented
by roughly its first 2,000 characters.

So we stream each file line-by-line, keep only user/assistant TEXT blocks, and
group consecutive turns into small windows that fit the embedder.

SCHEMA COUPLING (read this before debugging a drop in results)
--------------------------------------------------------------
The transcript format is undocumented and can change without notice. Every
function here is defensive: a malformed line is counted and skipped, never
raised. `ParseStats` records what was seen so a format shift is visible rather
than silent — in particular, a file that parses but yields ZERO text chunks is
the signature of a schema change and is reported loudly by the caller. The
records' own `version` field is carried into chunk metadata so a shift can be
correlated after the fact.

Record shape we depend on (all optional, all guarded):
    type        : "user" | "assistant" | "system" | "attachment" | ...
    sessionId   : UUID, constant within a file
    cwd         : the real project path (the encoded directory name is LOSSY --
                  spaces and backslashes both become "-", and at least one
                  directory here is keyed on the launch dir, not the project)
    version     : Claude Code version that wrote the record
    gitBranch   : branch at the time of the turn
    timestamp   : ISO-8601
    message     : { role, content } where content is a string or a list of
                  blocks; we keep only blocks with type == "text".
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

# Windows are sized for all-MiniLM-L6-v2's 512-token context (~2000 chars).
TARGET_CHARS = 1800
HARD_CHARS = 2400

# Roles whose text we treat as conversation.
KEEP_ROLES = {"user", "assistant"}

# Scaffolding injected into user turns; pure noise for retrieval.
_SYSTEM_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)


@dataclass
class Chunk:
    """One embeddable window of conversation."""
    index: int
    text: str
    first_timestamp: Optional[str] = None
    roles: str = ""


@dataclass
class ParseStats:
    """What the parser saw. Logged per file so schema drift is visible."""
    path: str = ""
    lines_total: int = 0
    records_parsed: int = 0
    records_malformed: int = 0
    text_blocks: int = 0
    chunks: int = 0
    record_types: Counter = field(default_factory=Counter)
    skipped_types: Counter = field(default_factory=Counter)
    session_id: Optional[str] = None
    cwd: Optional[str] = None
    version: Optional[str] = None
    git_branch: Optional[str] = None

    def summary(self) -> str:
        return (
            f"records={self.records_parsed} malformed={self.records_malformed} "
            f"text_blocks={self.text_blocks} chunks={self.chunks} "
            f"session={(self.session_id or '?')[:8]} version={self.version or '?'}"
        )

    def histogram(self) -> str:
        if not self.record_types:
            return "(no records)"
        return ", ".join(f"{k}={v}" for k, v in self.record_types.most_common())


def is_transcript(path: Path) -> bool:
    """True for files this module knows how to parse."""
    return path.suffix.lower() == ".jsonl"


def _clean(text: str) -> str:
    """Strip injected scaffolding and collapse runaway blank lines."""
    text = _SYSTEM_REMINDER.sub("", text)
    return text.strip()


def _record_text(obj: dict, stats: ParseStats) -> Optional[tuple[str, str]]:
    """Return (role, text) for a conversational record, or None.

    Defensive by construction: any unexpected shape returns None rather than
    raising, and the record's type is counted as skipped.
    """
    message = obj.get("message")
    if not isinstance(message, dict):
        return None
    role = message.get("role")
    if role not in KEEP_ROLES:
        return None

    content = message.get("content")
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "text":
                continue
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text)
    else:
        return None

    if not parts:
        return None
    stats.text_blocks += len(parts)
    cleaned = _clean("\n".join(parts))
    if not cleaned:
        return None
    return role, cleaned


def iter_turns(path: Path, stats: ParseStats) -> Iterator[tuple[str, str, Optional[str]]]:
    """Stream (role, text, timestamp) for each conversational turn in `path`.

    Never loads the whole file: a 40 MB transcript is read line by line.
    """
    try:
        handle = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return
    with handle as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            stats.lines_total += 1
            try:
                obj = json.loads(line)
            except Exception:
                stats.records_malformed += 1
                continue
            if not isinstance(obj, dict):
                stats.records_malformed += 1
                continue

            stats.records_parsed += 1
            rtype = str(obj.get("type", "?"))
            stats.record_types[rtype] += 1

            # First-seen wins for session-level fields; `cwd` is the authoritative
            # project reference (the encoded directory name is not).
            if stats.session_id is None and obj.get("sessionId"):
                stats.session_id = str(obj["sessionId"])
            if stats.cwd is None and obj.get("cwd"):
                stats.cwd = str(obj["cwd"])
            if stats.version is None and obj.get("version"):
                stats.version = str(obj["version"])
            if stats.git_branch is None and obj.get("gitBranch"):
                stats.git_branch = str(obj["gitBranch"])

            got = _record_text(obj, stats)
            if got is None:
                stats.skipped_types[rtype] += 1
                continue
            role, text = got
            ts = obj.get("timestamp")
            yield role, text, (str(ts) if ts else None)


def parse_transcript(
    path, *, target_chars: int = TARGET_CHARS, hard_chars: int = HARD_CHARS
) -> tuple[list[Chunk], ParseStats]:
    """Parse a transcript into embeddable chunks plus diagnostics.

    Consecutive turns are packed into windows of about `target_chars`; a single
    turn longer than `hard_chars` is split across windows so no chunk ever
    exceeds the embedder's usable context by much.
    """
    p = Path(path)
    stats = ParseStats(path=str(p))
    chunks: list[Chunk] = []

    buf: list[str] = []
    buf_len = 0
    buf_ts: Optional[str] = None
    buf_roles: list[str] = []

    def flush() -> None:
        nonlocal buf, buf_len, buf_ts, buf_roles
        if not buf:
            return
        chunks.append(
            Chunk(
                index=len(chunks),
                text="\n\n".join(buf).strip(),
                first_timestamp=buf_ts,
                roles=",".join(dict.fromkeys(buf_roles)),
            )
        )
        buf, buf_len, buf_ts, buf_roles = [], 0, None, []

    for role, text, ts in iter_turns(p, stats):
        piece = f"{role}: {text}"

        # A single oversized turn is split rather than dropped.
        while len(piece) > hard_chars:
            flush()
            head, piece = piece[:hard_chars], piece[hard_chars:]
            chunks.append(
                Chunk(index=len(chunks), text=head.strip(), first_timestamp=ts, roles=role)
            )

        if buf and buf_len + len(piece) > target_chars:
            flush()
        if buf_ts is None:
            buf_ts = ts
        buf.append(piece)
        buf_roles.append(role)
        buf_len += len(piece) + 2

    flush()
    stats.chunks = len(chunks)
    return chunks, stats


# ---------------------------------------------------------------------------
# Project identity
# ---------------------------------------------------------------------------

_project_cache: dict[str, tuple[str, str]] = {}


def reset_project_cache() -> None:
    """Clear the per-directory project lookup cache (useful between tests)."""
    _project_cache.clear()


def _first_cwd_in_dir(project_dir: Path) -> Optional[str]:
    """Read `cwd` from the first transcript under `project_dir` that has one."""
    try:
        candidates = sorted(project_dir.rglob("*.jsonl"))
    except OSError:
        return None
    for jf in candidates:
        try:
            with open(jf, "r", encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i > 500:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if isinstance(obj, dict) and obj.get("cwd"):
                        return str(obj["cwd"])
        except OSError:
            continue
    return None


def project_for_path(path: Path, projects_root: Path) -> tuple[str, str]:
    """Resolve (repo, project_path) for a file inside a transcripts tree.

    Uses the `cwd` recorded in the transcripts, never the encoded directory
    name: that encoding maps ":", "\\" and " " all to "-", so it cannot be
    reversed, and at least one directory on this machine is keyed on the
    session's launch directory rather than the project it worked on.

    Returns ("unknown", "") when no cwd can be found rather than guessing.
    """
    try:
        rel = path.resolve().relative_to(projects_root.resolve())
    except (ValueError, OSError):
        return "unknown", ""
    if not rel.parts:
        return "unknown", ""

    project_dir = projects_root / rel.parts[0]
    key = str(project_dir).lower()
    cached = _project_cache.get(key)
    if cached is not None:
        return cached

    cwd = _first_cwd_in_dir(project_dir)
    if cwd:
        resolved = (Path(cwd).name or "unknown", cwd)
    else:
        resolved = ("unknown", "")
    _project_cache[key] = resolved
    return resolved
