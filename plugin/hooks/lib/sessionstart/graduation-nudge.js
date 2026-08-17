// Suggest→rewrite graduation prompt (#52).
//
// In suggest mode tkr never substitutes a command, so the upgrade to rewrite
// mode has to be the user's decision — made against their own measured
// savings rather than a pitch. `tkr gain --suggest --graduation` owns every
// part of that decision: it prints one line only when the evidence clears the
// bar, and marks itself fired as it prints. This module DOES cache (see
// CACHE_TTL_MS below), but never replays a positive verdict: once a
// non-empty line has been returned to a caller, the cache is written back as
// consumed (empty) so a later cache hit within the TTL cannot hand the same
// upgrade prompt to every session that starts in the next 6h (#356).
//
// Silent by construction — empty stdout is the overwhelmingly common case
// (wrong mode, already prompted, not enough evidence, savings not positive).
// Suppress ahead of time with TKR_SUGGEST_NO_GRADUATION=1 or by setting
// hooks.graduation_prompted = true.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tkrSpawnArgv } = require("../tkr-bin");
const { stateDir } = require("../state-dir");
const { writeJSONAtomic } = require("../safe-json");

// Cap the injected line so a pathological config can't push an unbounded
// string into the session prefix.
const MAX_LINE = 400;

// INV-136: how long a resolved verdict stays good. This spawn blocked every
// single session start for up to 3s to produce a line that is empty on all
// but one session in a user's lifetime — the worst cost/benefit ratio on a
// path budgeted at <100ms (hooks/CLAUDE.md).
//
// Unlike the version cache next door, this CANNOT be keyed on the binary:
// the verdict is computed from accumulated gain data, which moves while the
// binary sits still. So it is timed, and the tradeoff is explicit — a
// graduation becomes visible up to TTL late. That is acceptable for a
// standing suggestion the user may act on whenever they like, and it would
// not be for anything time-critical.
//
// The EMPTY result is cached too, and deliberately: "no nudge" is the
// answer ~100% of the time, so caching only positives would leave the
// common path paying the full spawn forever.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Required prefix of the graduation line. Plugin hooks ship with the repo but
// the binary is installed separately, so a user can easily run a tkr that
// predates --graduation. Older binaries ignore unknown gain flags and print
// the full savings report instead — without this check that whole table would
// be injected into the session prefix on every single session start.
const EXPECTED_PREFIX = "tkr: suggest mode";

function cachePath() {
  return path.join(stateDir(), "graduation-nudge.json");
}

// readCache returns {hit:true, value} within the TTL, else {hit:false}.
// A two-field return rather than a bare string because "" is a legitimate
// cached VALUE here (the common one), not a miss — collapsing the two is
// exactly the bug that would keep the spawn on the hot path.
function readCache(now) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (
      c &&
      c.v === 1 &&
      typeof c.line === "string" &&
      typeof c.at === "number" &&
      now - c.at >= 0 &&
      now - c.at < CACHE_TTL_MS
    ) {
      return { hit: true, value: c.line };
    }
  } catch {
    // absent or corrupt — ask the binary
  }
  return { hit: false };
}

// INV-136 concurrency fix: this box routinely runs 8-12 concurrent Claude
// Code sessions, all firing SessionStart against the same state dir, so a
// concurrent writer here is the normal case, not an edge case. A direct
// truncating fs.writeFileSync lets a concurrent reader land between the
// truncate and the write and observe a 0-byte file (and on Windows a
// concurrent open can throw EBUSY/EPERM and silently drop the write).
// writeJSONAtomic (tmp + rename) makes every observed file either the old
// complete content or the new complete content, never torn.
//
// No lock on top of the atomic write (unlike hooks/lib/proc-lock.js
// elsewhere in this codebase, e.g. posttool/commit-refresh.js). Reasoning:
// every writer here is computing the SAME kind of answer from the SAME
// inputs — either the deterministic graduation verdict for the current TTL
// window, or (in version-ledger.js) the version keyed to the binary's own
// identity. Two sessions racing to write are writing values that are either
// identical or mutually interchangeable, so the failure mode under
// tmp+rename reduces to last-write-wins between two correct answers, which
// is benign. This is on the SessionStart blocking path (<100ms budget);
// lock acquisition has its own latency and its own failure modes (stale
// locks, contention under 8-12 concurrent sessions), and there is no
// correctness property here for a lock to buy that tmp+rename doesn't
// already provide.
function writeCache(now, line) {
  writeJSONAtomic(cachePath(), { v: 1, at: now, line });
}

function loadGraduationNudge() {
  if (process.env.TKR_SUGGEST_NO_GRADUATION === "1") return "";
  const now = Date.now();
  const cached = readCache(now);
  if (cached.hit) return cached.value;
  try {
    const { cmd, argv } = tkrSpawnArgv(["gain", "--suggest", "--graduation"]);
    const res = spawnSync(cmd, argv, {
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // A spawn that failed, was killed, or timed out is NOT a verdict, and
    // must not be cached: doing so would suppress a real graduation for the
    // whole TTL on the strength of one transient failure. Only an answer
    // from the binary gets written.
    if (res.error || res.signal || (typeof res.status === "number" && res.status !== 0)) {
      return "";
    }
    const line = (res.stdout || "").trim();
    // Everything below is a real answer, empty ones included — an old binary
    // printing a report instead of a nudge is a stable property of that
    // binary, not a transient miss.
    let value = "";
    if (line && line.startsWith(EXPECTED_PREFIX) && !line.includes("\n")) {
      // One line only — never a report.
      value = `\n\n${line.slice(0, MAX_LINE)}`;
    }
    // #356: the Go binary's one-shot prompt is enforced by persisting
    // hooks.graduation_prompted BEFORE it prints (cmd_gain_suggest.go) — a
    // failure to persist must not produce a prompt that reappears. Caching
    // the literal positive `value` here undid that: every session started
    // within CACHE_TTL_MS would replay the identical line from cache, even
    // though the binary itself would now correctly print nothing. Always
    // write back the CONSUMED (empty) marker instead of the returned value —
    // this caller gets the real answer once, the cache never holds a
    // replayable positive. The empty path is unaffected: value is already
    // "" there, so this is a no-op for the common case.
    writeCache(now, "");
    return value;
  } catch {
    return "";
  }
}

module.exports = { loadGraduationNudge, MAX_LINE, EXPECTED_PREFIX };
