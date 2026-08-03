// Channel 2 (proposal §3.3) — ctx-breakpoint advisories.
// Per-session JSON file: { "high_water_k": N } where N is the highest
// breakpoint threshold already advised in this session. Sentinel 0 =
// fresh session, no advisory emitted yet.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");
const { loadCtxBreakpoints } = require("../injection-config");
const { getTelemetryPath } = require("../statusline-path");

// Channel 2 (proposal §3.3) — per-session claude-statusline path resolved
// lazily so process.env.TKR_SESSION_ID set by the PostToolUse hook entry
// reaches the resolver. Same scoping convention as user-prompt-submit.js.

// State-only advisory wording (stage 2, 2026-06-01 — supersedes the
// §5 Q4 imperative freeze). Per the LOCKED division of labor, hooks
// report STATE only ("ctx crossed ~NK"); the verb — what to DO about
// it — lives solely in the system prompt's Pressure-awareness section.
// Source lives in hooks/data/posttool/ctx-breakpoint-advisories.json;
// loaded at module-init and frozen. Map threshold-K → text. Indexed by
// threshold value, not slot. JSON keys parse as strings; coerce to number.
const CTX_BREAKPOINT_ADVISORIES = Object.freeze(
  Object.fromEntries(
    Object.entries(
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "..", "data", "posttool", "ctx-breakpoint-advisories.json"),
          "utf8",
        ),
      ),
    ).map(([k, v]) => [Number(k), v]),
  ),
);

// Resolve TKR_STATE_DIR lazily via hooks/lib/state-dir so tests can
// override via env without re-requiring the module.
function ctxBreakpointStatePath(sid) {
  return path.join(stateDir(), `ctx-breakpoint-${sid || "default"}.json`);
}

function readCtxBreakpointState(sid) {
  try {
    const raw = fs.readFileSync(ctxBreakpointStatePath(sid), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" &&
        typeof parsed.high_water_k === "number" &&
        Number.isFinite(parsed.high_water_k)) {
      return { high_water_k: parsed.high_water_k };
    }
  } catch {
    // missing or corrupt → fresh state
  }
  return { high_water_k: 0 };
}

function writeCtxBreakpointState(sid, state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const target = ctxBreakpointStatePath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// gate(ctx) — pure decision (Phase 2b contract). Returns the chosen
// threshold (number) when an advisory should fire, or 0 if none.
//   ctx.ctxK: last_ctx_k from telemetry (preloaded)
//   ctx.highWaterK: per-session monotonic high-water mark (preloaded)
//   ctx.breakpoints: sorted threshold array (preloaded via injection-config)
//
// Multi-threshold jump: takes the highest breakpoint that is both
// <= ctxK AND > highWaterK. Skipping intermediate thresholds is
// intentional — model gets the most-actionable advisory, not a stack.
// Drop-and-re-cross: high-water is monotonic. Once ctx hits 100K, the
// 100K advisory never fires again even after compaction drops ctx.
function gate(ctx) {
  const ctxK = ctx && typeof ctx.ctxK === "number" && Number.isFinite(ctx.ctxK)
    ? ctx.ctxK
    : 0;
  if (ctxK <= 0) return 0;
  const breakpoints = (ctx && ctx.breakpoints) || [];
  const hw = ctx && typeof ctx.highWaterK === "number" ? ctx.highWaterK : 0;
  for (let i = breakpoints.length - 1; i >= 0; i--) {
    const b = breakpoints[i];
    if (b <= ctxK && b > hw) return b;
  }
  return 0;
}

// body(threshold) — pure lookup of FROZEN advisory text.
function body(threshold) {
  return CTX_BREAKPOINT_ADVISORIES[threshold] || "";
}

// ctxBreakpointContext — I/O wrapper around gate + body.
//
// Architectural rule (Risk #15): dedup state is read FRESH inside this
// function. Result is computed once per invocation, then returned to a
// single composedCtx site in post-tool-call.js. Caller MUST NOT
// pre-compose this result and reuse it across multiple return paths the
// way the (since-deleted, INV-073) legacy brevityContext pattern did.
function ctxBreakpointContext(sid, telemetryPath) {
  const target = telemetryPath || getTelemetryPath();
  let tel;
  try {
    tel = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return "";
  }
  const state = readCtxBreakpointState(sid);
  const chosen = gate({
    ctxK: tel.last_ctx_k,
    highWaterK: state.high_water_k,
    breakpoints: loadCtxBreakpoints(),
  });
  if (chosen === 0) return "";
  const advisory = body(chosen);
  if (!advisory) return ""; // Defensive — subset rule should keep this in sync.
  writeCtxBreakpointState(sid, { high_water_k: chosen });
  return advisory;
}

module.exports = {
  gate,
  body,
  ctxBreakpointContext,
  ctxBreakpointStatePath,
  CTX_BREAKPOINT_ADVISORIES,
  getTelemetryPath,
};
