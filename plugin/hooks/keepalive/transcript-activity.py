# transcript-activity.py <transcript.jsonl> — print the epoch of the last
# REAL turn row (type user|assistant) in the transcript's tail.
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
# 60s poll cadence. Any failure exits non-zero; the caller falls back
# to mtime (over-counts activity -> WAIT, the safe direction).
import json
import os
import sys
from datetime import datetime, timezone

TAIL_BYTES = 262144

path = sys.argv[1]
size = os.path.getsize(path)
with open(path, "rb") as f:
    f.seek(max(0, size - TAIL_BYTES))
    data = f.read()

best = 0
for line in data.splitlines():
    try:
        row = json.loads(line)
    except Exception:
        continue  # partial first line at the seek boundary, or junk
    if row.get("type") not in ("user", "assistant"):
        continue
    ts = str(row.get("timestamp") or "")
    try:
        t = int(
            datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")
            .replace(tzinfo=timezone.utc)
            .timestamp()
        )
    except Exception:
        continue
    if t > best:
        best = t

print(best)
