// Planning-context nudge — capability-style hint that planners (Claude's
// built-in plan mode, blueprint:design, custom planning skills) should
// factor context/token cost into task organization. Cost IS the
// compounding lever (turn-1 token = 21× effective over 200 turns), not
// a tiebreaker.
// Gated by cfg.planning?.nudge config (default on) and
// TKR_PLANNING_NUDGE_DISABLED env. Permanent ~180-token prefix tax;
// opt-out is the escape hatch for users who don't want it.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

const PLANNING_NUDGE_BODY = fs
  .readFileSync(
    path.join(__dirname, "..", "..", "data", "sessionstart", "planning-nudge.md"),
    "utf8",
  )
  .replace(/\n+$/, "");

// gate(ctx) — pure decision (Phase 2b contract).
//   ctx.env: env-var bag
//   ctx.cfg: parsed config (or {})
function gate(ctx) {
  const env = (ctx && ctx.env) || {};
  if (env.TKR_PLANNING_NUDGE_DISABLED === "1") return false;
  const v = ctx && ctx.cfg && ctx.cfg.planning
    ? ctx.cfg.planning.nudge
    : undefined;
  return v === undefined || v === null || v === true;
}

function body() {
  return `\n\n${PLANNING_NUDGE_BODY}`;
}

function readConfigFromDisk() {
  try {
    const configPath = path.join(stateDir(), "config.json");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {}
  return {};
}

function shouldEmitPlanningNudge() {
  return gate({ env: process.env, cfg: readConfigFromDisk() });
}

function loadPlanningNudge() {
  if (!shouldEmitPlanningNudge()) return "";
  return body();
}

module.exports = { gate, body, shouldEmitPlanningNudge, loadPlanningNudge };
