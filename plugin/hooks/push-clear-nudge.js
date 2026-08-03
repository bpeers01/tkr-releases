// Ship 5 — push-boundary /clear nudge.
//
// Detects `git push` completion via PostToolUse Bash hook and, when the
// session has built up enough context-tail to make /clear worthwhile,
// emits a suggestion to clear before the next work unit. Push events
// are natural work-unit boundaries — context built before the push is
// rarely needed after.
//
// Gates (avoid negative-savings cases per build queue Ship 5 spec):
//   - turn_count >= 50  (long session — rebuild cost amortized)
//   - last_ctx_k >= 150 (large tail — actually worth /clear-ing)
//
// One nudge per session (per-sid debounce file). Once user dismisses,
// further pushes in same session don't re-prompt.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getTelemetryPath } = require("./lib/statusline-path");
const { stateDir } = require("./lib/state-dir");

const TKR_STATE_DIR = stateDir();

// Per-session telemetry path resolved lazily. Callers pass sessionID
// through checkPushBoundary so we can set TKR_SESSION_ID here before
// readTelemetry resolves the path. See hooks/lib/statusline-path.js.

// Mirrors continue-here Ship 5 spec.
const PUSH_NUDGE_TURN_GATE  = 50;
const PUSH_NUDGE_CTX_K_GATE = 150;

// Match `git push` with or without args. Excludes `git push --help` and
// `git push-ref` plumbing. Whitespace flexibility for piped chains.
const GIT_PUSH_PATTERN = /(?:^|[;&|\s])git\s+push(?:\s|$)(?!.*--help\b)/;

function debouncePath(sid) {
  const safe = sid && String(sid).trim() ? String(sid).trim() : "default";
  return path.join(TKR_STATE_DIR, `push-nudge-${safe}.flag`);
}

function alreadyNudged(sid) {
  try {
    fs.statSync(debouncePath(sid));
    return true;
  } catch {
    return false;
  }
}

function markNudged(sid) {
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    fs.writeFileSync(debouncePath(sid), String(Date.now()));
  } catch {
    // Best-effort.
  }
}

function readTelemetry(telemetryPath) {
  try {
    return JSON.parse(fs.readFileSync(telemetryPath || getTelemetryPath(), "utf8"));
  } catch {
    return {};
  }
}

// isGitPush returns true when the command string runs `git push`.
function isGitPush(command) {
  if (!command || typeof command !== "string") return false;
  return GIT_PUSH_PATTERN.test(command);
}

// checkPushBoundary inspects an event and returns warning text or null.
// Caller passes sessionID for debounce isolation; telemetryPath is
// optional override for tests.
function checkPushBoundary(event, sessionID, telemetryPath) {
  if (!event || event.tool_name !== "Bash") return null;
  const command = event.tool_input && event.tool_input.command;
  if (!isGitPush(command)) return null;

  // Per-session telemetry scope — without this, readTelemetry below
  // resolves to the legacy per-project path and reads stale fields.
  // INV-039: payload sid wins over inherited env (stale launch-time pin).
  if (sessionID) {
    process.env.TKR_SESSION_ID = sessionID;
  }

  // PLAN-1 T5: when 1h cache is confirmed active, /clear would force a rebuild
  // that wouldn't otherwise happen — suppress the nudge entirely.
  // source="default" means no evidence either way → preserve legacy 5m behavior.
  const { detectTTL } = require("./lib/cache-ttl");
  const ttl = detectTTL(sessionID);
  if (ttl.ttl_seconds >= 3600 && ttl.source !== "default") {
    return null;
  }

  const tel = readTelemetry(telemetryPath);
  const turns = typeof tel.turn_count === "number" ? tel.turn_count : 0;
  const ctxK = typeof tel.last_ctx_k === "number" ? tel.last_ctx_k : 0;

  if (turns < PUSH_NUDGE_TURN_GATE || ctxK < PUSH_NUDGE_CTX_K_GATE) {
    return null;
  }

  if (alreadyNudged(sessionID)) return null;
  markNudged(sessionID);

  return (
    `[tkr push-boundary] ${turns}-turn session, ${ctxK}K ctx — push is a ` +
    `natural work boundary. \`/clear\` now drops the tail without rebuild ` +
    `cost; resume cheap on the next task. (Won't repeat this session.)`
  );
}

module.exports = {
  PUSH_NUDGE_TURN_GATE,
  PUSH_NUDGE_CTX_K_GATE,
  GIT_PUSH_PATTERN,
  isGitPush,
  checkPushBoundary,
};
