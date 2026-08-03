// Hook-side debounce gate for `tkr search --refresh`. Cheap last-fire
// timestamp at $TKR_STATE_DIR/last-search-refresh-fire.ms — skip if
// fired <REFRESH_DEBOUNCE_MS ago. Binary-side lock + mtime short-circuit
// are the authoritative guards; this just avoids redundant spawns when
// SessionStart re-fires (e.g., /resume, /clear).
//
// Self-heal: when ≥REFRESH_STRIKE_LIMIT spawn_timeout_kill events for
// `tkr search --refresh` are logged in the last
// REFRESH_STRIKE_WINDOW_MS, stop auto-firing and surface a one-line
// stderr nudge. The user can re-enable by clearing
// hook-timings.jsonl or with TKR_SESSION_REFRESH_ENABLED=1.
//
// Kill switch: TKR_SESSION_REFRESH_DISABLED=1 forces skip
// regardless of debounce/strike state.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

const REFRESH_DEBOUNCE_MS = 60_000;
const REFRESH_STRIKE_LIMIT = 3;
const REFRESH_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

function refreshFireFile() {
  return path.join(stateDir(), "last-search-refresh-fire.ms");
}

function hookTimingsFile() {
  return path.join(stateDir(), "hook-timings.jsonl");
}

function countRecentRefreshTimeouts() {
  // Best-effort: scan the last ~2KB worth of lines (cheap) since
  // spawn_timeout_kill events are infrequent enough that a tail
  // read suffices. On error return 0 (fail-open).
  try {
    const file = hookTimingsFile();
    const stat = fs.statSync(file);
    const tailBytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(tailBytes);
    fs.readSync(fd, buf, 0, tailBytes, Math.max(0, stat.size - tailBytes));
    fs.closeSync(fd);
    const cutoff = Date.now() - REFRESH_STRIKE_WINDOW_MS;
    let n = 0;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes("spawn_timeout_kill")) continue;
      if (!line.includes('"search"') || !line.includes('"--refresh"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const t = obj && obj.ts ? Date.parse(obj.ts) : NaN;
      if (Number.isFinite(t) && t >= cutoff) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

function shouldFireSearchRefresh() {
  // Hard kill switch.
  if (process.env.TKR_SESSION_REFRESH_DISABLED === "1") return false;

  // Self-heal: too many recent timeouts → stop auto-firing.
  if (process.env.TKR_SESSION_REFRESH_ENABLED !== "1") {
    const strikes = countRecentRefreshTimeouts();
    if (strikes >= REFRESH_STRIKE_LIMIT) {
      try {
        process.stderr.write(
          `[tkr] auto-refresh disabled (${strikes} timeouts in last 24h); ` +
          `run \`tkr search --refresh\` manually or set TKR_SESSION_REFRESH_ENABLED=1\n`
        );
      } catch {}
      return false;
    }
  }

  const fireFile = refreshFireFile();
  try {
    const raw = fs.readFileSync(fireFile, "utf8").trim();
    const last = Number(raw);
    if (Number.isFinite(last) && Date.now() - last < REFRESH_DEBOUNCE_MS) {
      return false;
    }
  } catch {
    // No prior fire → fire now.
  }
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(fireFile, String(Date.now()));
  } catch {}
  return true;
}

module.exports = {
  REFRESH_DEBOUNCE_MS,
  REFRESH_STRIKE_LIMIT,
  REFRESH_STRIKE_WINDOW_MS,
  countRecentRefreshTimeouts,
  shouldFireSearchRefresh,
};
