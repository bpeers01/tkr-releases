// Mode-aware read nudge (LCTX-001 Phase 2) — point first-pass reads at
// `tkr_read --mode=map|signatures` (slim MCP tool) before falling back
// to the native Read. Gated by cfg.leanctx?.enabled (default on) and
// TKR_LEANCTX_DISABLED env. ~50-token prefix tax — opt-out is the
// escape hatch for users who don't want the suggestion.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

const READ_NUDGE_BODY = fs
  .readFileSync(
    path.join(__dirname, "..", "..", "data", "sessionstart", "read-nudge.md"),
    "utf8",
  )
  .replace(/\n+$/, "");

// gate(ctx) — pure decision (Phase 2b contract).
//   ctx.env: env-var bag
//   ctx.cfg: parsed config (or {})
function gate(ctx) {
  const env = (ctx && ctx.env) || {};
  if (env.TKR_LEANCTX_DISABLED === "1") return false;
  const v = ctx && ctx.cfg && ctx.cfg.leanctx
    ? ctx.cfg.leanctx.enabled
    : undefined;
  return v === undefined || v === null || v === true;
}

function body() {
  return `\n\n${READ_NUDGE_BODY}`;
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

function shouldEmitReadNudge() {
  return gate({ env: process.env, cfg: readConfigFromDisk() });
}

function loadReadNudge() {
  if (!shouldEmitReadNudge()) return "";
  return body();
}

module.exports = { gate, body, shouldEmitReadNudge, loadReadNudge };
