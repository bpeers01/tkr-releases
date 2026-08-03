// Cache-mechanics nudge — explains prefix-cache rolling-multiplier math,
// state-signal channel framing, ctx/rate-limit decision matrix, trajectory
// hint, and `tkr signals --current` pull directive. Bakes into prefix
// cache turn 1 (paid ~21× over 200-turn session); the cost buys the
// framework that lets Channel 1/2/3 state surfacing work coherently.
// Wording is FROZEN per proposal docs/proposals/2026-05-12-prefix-aware-
// context-injection.md §5 Q4 — do not edit without amending the proposal.
//
// Gating (issue #11):
//   - TKR_CACHE_MECHANICS_DISABLED=1 → always suppress
//   - cfg.cache_mechanics.nudge === false → always suppress
//   - cfg.cache_mechanics.nudge === true / "always" → always emit
//   - default ("heavy_only"): emit only when prior session was heavy
//     (prior_cum_cw > 100K) OR cache cold/stale (signal absent).
//     Light prior sessions skip the ~1500-char block — the framework
//     pays off when context pressure is realistic, not on quick one-offs.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");
const { readLastSessionCWCache } = require("./last-session-cw");

const CACHE_MECHANICS_HEAVY_CW = 100_000;

// FROZEN body lives in hooks/data/sessionstart/cache-mechanics.md (proposal
// §5 Q4). Cached at module-init so per-session-start emit is one read.
const CACHE_MECHANICS_BODY = fs
  .readFileSync(
    path.join(__dirname, "..", "..", "data", "sessionstart", "cache-mechanics.md"),
    "utf8",
  )
  .replace(/\r\n/g, "\n")
  .replace(/\n+$/, "");

// gate(ctx) — pure decision given resolved ctx. Phase 2b contract.
//   ctx.env: env-var bag (e.g. { TKR_CACHE_MECHANICS_DISABLED: "1" })
//   ctx.cfg: parsed config object (or {} when no config.json present)
//   ctx.priorSessionCW: number | null (null = no signal / cold-or-stale
//     cache → emit; number = fresh cum_cw → emit iff > HEAVY_CW)
function gate(ctx) {
  const env = (ctx && ctx.env) || {};
  if (env.TKR_CACHE_MECHANICS_DISABLED === "1") return false;
  const v = ctx && ctx.cfg && ctx.cfg.cache_mechanics
    ? ctx.cfg.cache_mechanics.nudge
    : undefined;
  if (v === false) return false;
  if (v === true || v === "always") return true;
  const cw = ctx ? ctx.priorSessionCW : null;
  if (cw === null || cw === undefined) return true; // no signal → emit
  return Number(cw) > CACHE_MECHANICS_HEAVY_CW;
}

function body() {
  return `\n\n${CACHE_MECHANICS_BODY}`;
}

function shouldEmitCacheMechanicsNudge() {
  return gate({
    env: process.env,
    cfg: readConfigFromDisk(),
    priorSessionCW: readPriorSessionCW(),
  });
}

function readConfigFromDisk() {
  try {
    const configPath = path.join(stateDir(), "config.json");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {
    // ignore — caller treats missing as defaults
  }
  return {};
}

function readPriorSessionCW() {
  const cache = readLastSessionCWCache();
  if (!cache || cache.stale) return null;
  return Number(cache.payload?.prior_cum_cw || 0);
}

// isLikelyHeavySession — back-compat shim. Equivalent to:
//   gate(ctx) with cfg.cache_mechanics.nudge=undefined (heuristic path).
// Returns true when prior cum_cw > HEAVY_CW OR cache cold/stale.
function isLikelyHeavySession() {
  const cw = readPriorSessionCW();
  if (cw === null) return true;
  return cw > CACHE_MECHANICS_HEAVY_CW;
}

function loadCacheMechanicsNudge() {
  if (!shouldEmitCacheMechanicsNudge()) return "";
  return body();
}

module.exports = {
  CACHE_MECHANICS_HEAVY_CW,
  gate,
  body,
  shouldEmitCacheMechanicsNudge,
  isLikelyHeavySession,
  loadCacheMechanicsNudge,
};
