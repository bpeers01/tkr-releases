// Playbook event emit primitive — JS counterpart to internal/telemetry/playbook.go.
// Hooks (PreToolUse, UserPromptSubmit, SessionStart) call emitEvent to append
// schema-stable jsonl rows to ~/.tkr/playbook-events.jsonl. Best-effort: fire-
// and-forget; disk failures swallow without throwing.
//
// Schema is locked at v1 per ADR-0008. New optional fields and new enum values
// (additional layers/events) do NOT bump SCHEMA_VERSION.

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;

// Cache-bust coverage extensions (proposal 2026-05-10) add three new layer
// enums: L0R (/continue advisory), L4 (long-runner warn), L5 (cache-bust warn).
// PLAN-1 (Wave-0, v3.13.1) adds L6 (cache-TTL inference) — emitted once per
// session start when detectTTL produces evidence (source "direct" or
// "inferred"). The session-shape advisor (UserPromptSubmit) adds L7 —
// emitted once per session per trigger (tool-bytes / tail-burn). Per
// ADR-0008 §AD-9, additive enum values do NOT bump SCHEMA_VERSION.
const VALID_LAYERS = new Set(["L0", "L0R", "L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
const VALID_EVENTS = new Set(["fired", "taken", "declined", "ignored", "measured"]);

function ledgerPath() {
  if (process.env.TKR_STATE_DIR) {
    return path.join(process.env.TKR_STATE_DIR, "playbook-events.jsonl");
  }
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".tkr", "playbook-events.jsonl");
}

function globallyDisabled() {
  return process.env.TKR_PLAYBOOK_DISABLED === "1";
}

// L-10: per-event-type rate guard. In-memory map (process-local, cleared
// per hook invocation since hooks are one-shot — useful only when a single
// hook fires multiple emits during one invocation). 100ms throttle bounds
// runaway duplicate emits from buggy callers without silencing distinct
// event types.
const RATE_GUARD_MS = 100;
const lastEmitMs = new Map();

function rateLimited(layer, event) {
  const key = `${layer}:${event}`;
  const now = Date.now();
  const prev = lastEmitMs.get(key);
  if (typeof prev === "number" && now - prev < RATE_GUARD_MS) {
    return true;
  }
  lastEmitMs.set(key, now);
  return false;
}

// emitEvent appends one playbook event to the ledger. Best-effort — wrapped
// in try/catch with no rethrow. Caller passes:
//   layer: 'L0' | 'L1' | 'L2' | 'L3'
//   event: 'fired' | 'taken' | 'declined' | 'ignored' | 'measured'
//   triggerState: object snapshot at fire time (per-layer shape per ADR §4)
//   outcome: object | null (null at fire time; populated by reconciliation)
//   sessionId: optional override; falls back to TKR_SESSION_ID env or "default"
function emitEvent(layer, event, triggerState, outcome, sessionId) {
  if (globallyDisabled()) return;
  if (!VALID_LAYERS.has(layer) || !VALID_EVENTS.has(event)) return;
  if (rateLimited(layer, event)) return;

  const sid =
    sessionId || process.env.TKR_SESSION_ID || process.env.CLAUDE_SESSION_ID || "default";

  const evt = {
    at: new Date().toISOString(),
    session_id: sid,
    layer,
    event,
    trigger_state: triggerState && typeof triggerState === "object" ? triggerState : {},
    outcome: outcome && typeof outcome === "object" ? outcome : null,
    schema_version: SCHEMA_VERSION,
  };

  try {
    const target = ledgerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(evt) + "\n");
  } catch {
    // best-effort — never throw on observability writes
  }
}

// readLedger returns parsed events from the ledger and a count of rows
// skipped because their schema_version exceeded the current consumer's.
// Used by tests; aggregator consumers (Wave 6) prefer the Go reader.
function readLedger(p) {
  const target = p || ledgerPath();
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { events: [], unknownSkipped: 0 };
    throw e;
  }
  const events = [];
  let unknownSkipped = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line);
      if (typeof evt.schema_version === "number" && evt.schema_version > SCHEMA_VERSION) {
        unknownSkipped++;
        continue;
      }
      events.push(evt);
    } catch {
      // skip malformed line
    }
  }
  return { events, unknownSkipped };
}

// __resetRateGuard clears the in-memory rate-limit map. Test-only helper —
// production hooks are one-shot processes where the map is empty by construction.
// Used by hook tests that re-require the parent module under withTempStateDir.
function __resetRateGuard() {
  lastEmitMs.clear();
}

module.exports = {
  SCHEMA_VERSION,
  emitEvent,
  readLedger,
  ledgerPath,
  __resetRateGuard,
};
