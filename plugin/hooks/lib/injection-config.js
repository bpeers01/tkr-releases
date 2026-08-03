// tkr injection config loader — extracted from session-start.js so
// UserPromptSubmit (hot path) can read thresholds without dragging
// the SessionStart module surface. Single source of truth for
// `cfg.injection.thresholds.*` defaults.
//
// See docs/proposals/2026-05-12-prefix-aware-context-injection.md §3.2.

const fs = require("fs");
const path = require("path");

// Threshold defaults — frozen object. Override via
// ~/.tkr/config.json → injection.thresholds.{ctx_k,turn,age_s,fivehour_pct,sevenday_pct}.
const INJECTION_THRESHOLD_DEFAULTS = Object.freeze({
  ctx_k: 75,
  turn: 50,
  age_s: 200,
  fivehour_pct: 40,
  sevenday_pct: 50,
});

// Ctx-breakpoint defaults — frozen tuple. Override via
// ~/.tkr/config.json → injection.ctx_breakpoints (array of numbers).
// Wording for each breakpoint is state-only (stage 2, 2026-06-01) — see
// hooks/lib/posttool/ctx-breakpoint.js CTX_BREAKPOINT_ADVISORIES. User overrides are
// validated as a SUBSET of these defaults; non-subset arrays fall
// back to defaults so wording stays in lock-step. Simpler than
// synthesizing wording for arbitrary thresholds.
const CTX_BREAKPOINT_DEFAULTS = Object.freeze([100, 150, 200, 250, 300]);

// Session-shape advisor defaults — frozen object. Override via
// ~/.tkr/config.json → advisor.shape.{enabled,tool_result_kb,min_ctx_k,
// tail_turns,tail_ctx_k,tail_cap_mult,min_turns_for_avg,healthy_7d_pct,
// cheap_miss_cents}. Drives the two UserPromptSubmit shape triggers:
//   A (tool-bytes): tool_result_bytes ≥ tool_result_kb·1024 AND ctx ≥ min_ctx_k
//   B (tail-burn):  late-session per-turn cap-unit burn ≥ tail_cap_mult × avg
// Env kill switch: TKR_SHAPE_ADVISOR_DISABLED=1 (checked in the hook, not here).
const SHAPE_ADVISOR_DEFAULTS = Object.freeze({
  enabled: true,
  tool_result_kb: 100,
  min_ctx_k: 50,
  tail_turns: 60,
  tail_ctx_k: 140,
  tail_cap_mult: 2.0,
  min_turns_for_avg: 20,
  healthy_7d_pct: 30,
  cheap_miss_cents: 25,
});

// COMPETE-002 auto-route defaults — frozen object. Opt-in: enabled stays
// false until the adoption experiment says otherwise. Override via
// ~/.tkr/config.json → autoroute.{enabled}. Env kill switch:
// TKR_AUTOROUTE_DISABLED=1 (checked in the hook, not here).
const AUTOROUTE_DEFAULTS = Object.freeze({
  enabled: false,
});

// Resolve state dir lazily — env may change between callers (tests).
function stateDir() {
  return (
    process.env.TKR_STATE_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".tkr")
  );
}

// loadInjectionThresholds — return merged defaults + user overrides.
// Per-field fallback: missing/non-numeric user values keep the default.
// Best-effort: any IO/parse error returns clean defaults.
function loadInjectionThresholds() {
  const defaults = { ...INJECTION_THRESHOLD_DEFAULTS };
  try {
    const configPath = path.join(stateDir(), "config.json");
    if (!fs.existsSync(configPath)) return defaults;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const user = cfg.injection?.thresholds;
    if (!user || typeof user !== "object") return defaults;
    for (const key of Object.keys(defaults)) {
      if (typeof user[key] === "number" && Number.isFinite(user[key])) {
        defaults[key] = user[key];
      }
    }
    return defaults;
  } catch {
    return defaults;
  }
}

// loadCtxBreakpoints — return validated breakpoint array.
// Defaults: [100, 150, 200, 250, 300]. User overrides via
// cfg.injection.ctx_breakpoints must be a SUBSET of defaults. Any other
// value (non-array, contains non-numbers, contains non-default values)
// falls back to defaults silently. Sorted ascending on return.
function loadCtxBreakpoints() {
  const defaults = [...CTX_BREAKPOINT_DEFAULTS];
  try {
    const configPath = path.join(stateDir(), "config.json");
    if (!fs.existsSync(configPath)) return defaults;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const user = cfg.injection?.ctx_breakpoints;
    if (!Array.isArray(user) || user.length === 0) return defaults;
    // Validate: every entry must be a finite positive number that exists
    // in defaults (subset rule). Sorted ascending.
    const valid = [];
    for (const v of user) {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return defaults;
      if (!CTX_BREAKPOINT_DEFAULTS.includes(v)) return defaults;
      valid.push(v);
    }
    valid.sort((a, b) => a - b);
    return valid;
  } catch {
    return defaults;
  }
}

// loadShapeAdvisorConfig — return merged defaults + user overrides from
// ~/.tkr/config.json → advisor.shape. Per-field fallback mirrors
// loadInjectionThresholds(): booleans accept only booleans, numbers accept
// only finite numbers; anything else keeps the default. Best-effort: any
// IO/parse error returns clean defaults.
function loadShapeAdvisorConfig() {
  const defaults = { ...SHAPE_ADVISOR_DEFAULTS };
  try {
    const configPath = path.join(stateDir(), "config.json");
    if (!fs.existsSync(configPath)) return defaults;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const user = cfg.advisor?.shape;
    if (!user || typeof user !== "object") return defaults;
    for (const key of Object.keys(defaults)) {
      if (typeof defaults[key] === "boolean") {
        if (typeof user[key] === "boolean") defaults[key] = user[key];
      } else if (typeof user[key] === "number" && Number.isFinite(user[key])) {
        defaults[key] = user[key];
      }
    }
    return defaults;
  } catch {
    return defaults;
  }
}

// loadAutorouteConfig — return merged defaults + user overrides from
// ~/.tkr/config.json → autoroute. Same per-field fallback discipline as
// the other loaders; any IO/parse error returns clean defaults.
function loadAutorouteConfig() {
  const defaults = { ...AUTOROUTE_DEFAULTS };
  try {
    const configPath = path.join(stateDir(), "config.json");
    if (!fs.existsSync(configPath)) return defaults;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const user = cfg.autoroute;
    if (!user || typeof user !== "object") return defaults;
    if (typeof user.enabled === "boolean") defaults.enabled = user.enabled;
    return defaults;
  } catch {
    return defaults;
  }
}

// The injectionV2Active env gate (proposal §11.2) was deleted 2026-07-23
// (INV-073): V2 had been default-ON since 2026-05-13 and the V2=0
// legacy-parity branches it selected were removed along with the
// TKR_INJECTION_LEGACY rollback handle. See
// docs/audits/2026-07-23-injection-discipline/REPORT.md.

module.exports = {
  INJECTION_THRESHOLD_DEFAULTS,
  CTX_BREAKPOINT_DEFAULTS,
  SHAPE_ADVISOR_DEFAULTS,
  AUTOROUTE_DEFAULTS,
  loadInjectionThresholds,
  loadCtxBreakpoints,
  loadShapeAdvisorConfig,
  loadAutorouteConfig,
};
