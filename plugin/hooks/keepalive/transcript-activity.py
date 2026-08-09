# transcript-activity.py <transcript.jsonl> [mode] — transcript tail scan
# shared by the keepalive watcher (activity/pending) and the handoff writer
# (human-answer, issue #152 item 3).
#
# Modes (arg 2, default "activity"):
#   activity      — print the epoch of the last REAL turn row (type
#                   user|assistant) in the transcript's tail. Original
#                   behavior; unchanged output shape.
#   pending       — print "1" if the last assistant row in the tail carries
#                   an unmatched tool_use for AskUserQuestion or
#                   ExitPlanMode (no tool_result for it appears later in the
#                   tail), else "0". Issue #152 item 1: a pending
#                   interactive prompt appends no transcript rows while a
#                   human decides, so idle time alone cannot tell "blocked
#                   on a human" from "abandoned" — this is that missing
#                   signal.
#   human-answer  — print the epoch of the LATEST tool_result row in the
#                   tail that answers an AskUserQuestion/ExitPlanMode
#                   tool_use (0 if none). Issue #152 item 3: the handoff
#                   writer uses this to tell "the human answered after the
#                   watcher fired" (mislabel risk) from "the fire was
#                   legitimate and nothing has happened since".
#
# Fixed tool list (AskUserQuestion, ExitPlanMode), not "any unmatched
# tool_use": a broad match would also suppress/reclassify around a
# genuinely stalled tool call (e.g. a hung Bash command) — exactly the
# abandoned-session case keepalive exists to catch. Only the two
# known-interactive, blocking-on-a-human tools are in scope.
#
# KEEP-005: the watcher used the transcript file's mtime as the activity
# signal, but Claude Code appends bookkeeping rows after a session goes
# idle (observed: `away_summary` at Stop+3min; also `stop_hook_summary`,
# `turn_duration`, `file-history-snapshot`). Those rows pushed fire-due
# past the asyncRewake hook's 3600s hard-kill, so an abandoned session
# could never fire. They are local bookkeeping — they do not refresh the
# API prompt-cache TTL — so they must not count as activity either way.
# Allowlist user/assistant (turns AND tool results — agentic-turn
# protection from KEEP-002 is preserved), ignore everything else.
#
# Tail-bounded read (256KB) so hour-long transcripts stay cheap at a
# 60s poll cadence. Any failure exits non-zero; the "activity" caller
# falls back to mtime (over-counts activity -> WAIT, the safe direction).
# The "pending" and "human-answer" callers treat a failure/non-numeric
# result as "no signal" and fall back to pre-#152 behavior (see watcher.sh
# / write-continue-here.sh) rather than assuming either 0 or 1 blind.
import json
import os
import sys
from datetime import datetime, timezone

TAIL_BYTES = 262144
INTERACTIVE_TOOLS = ("AskUserQuestion", "ExitPlanMode")

path = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "activity"
size = os.path.getsize(path)
with open(path, "rb") as f:
    f.seek(max(0, size - TAIL_BYTES))
    data = f.read()

rows = []
for line in data.splitlines():
    try:
        rows.append(json.loads(line))
    except Exception:
        continue  # partial first line at the seek boundary, or junk


def row_epoch(row):
    ts = str(row.get("timestamp") or "")
    try:
        return int(
            datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")
            .replace(tzinfo=timezone.utc)
            .timestamp()
        )
    except Exception:
        return None


def content_blocks(row):
    msg = row.get("message") or {}
    content = msg.get("content") or []
    return content if isinstance(content, list) else []


if mode == "activity":
    best = 0
    for row in rows:
        if row.get("type") not in ("user", "assistant"):
            continue
        t = row_epoch(row)
        if t is not None and t > best:
            best = t
    print(best)

elif mode == "pending":
    # Last assistant row in the tail, in append order.
    last_assistant = None
    for row in reversed(rows):
        if row.get("type") == "assistant":
            last_assistant = row
            break

    pending_ids = set()
    if last_assistant is not None:
        for block in content_blocks(last_assistant):
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_use"
                and block.get("name") in INTERACTIVE_TOOLS
            ):
                tid = block.get("id")
                if tid:
                    pending_ids.add(tid)

    if pending_ids:
        # A tool_result for any pending id, anywhere in the tail (order
        # doesn't matter here — we only need "has it been answered at all
        # since it was raised").
        for row in rows:
            if row.get("type") != "user":
                continue
            for block in content_blocks(row):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    pending_ids.discard(block.get("tool_use_id"))

    print("1" if pending_ids else "0")

elif mode == "human-answer":
    ask_ids = set()
    for row in rows:
        if row.get("type") != "assistant":
            continue
        for block in content_blocks(row):
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_use"
                and block.get("name") in INTERACTIVE_TOOLS
            ):
                tid = block.get("id")
                if tid:
                    ask_ids.add(tid)

    best = 0
    if ask_ids:
        for row in rows:
            if row.get("type") != "user":
                continue
            ts = None
            for block in content_blocks(row):
                if (
                    isinstance(block, dict)
                    and block.get("type") == "tool_result"
                    and block.get("tool_use_id") in ask_ids
                ):
                    ts = row_epoch(row)
                    break
            if ts is not None and ts > best:
                best = ts
    print(best)

else:
    sys.stderr.write(f"transcript-activity.py: unknown mode '{mode}'\n")
    sys.exit(2)
