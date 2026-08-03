// Shared read of ~/.tkr/last-session-cw.json (5min TTL).
// Used by cache-mechanics-nudge (heavy_only heuristic) and continue (L0R).

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

const L0R_CACHE_TTL_MS = 5 * 60 * 1000;

function readLastSessionCWCache() {
  try {
    const p = path.join(stateDir(), "last-session-cw.json");
    if (!fs.existsSync(p)) return null;
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!c || !c.updated_at) return null;
    const age = Date.now() - new Date(c.updated_at).getTime();
    if (Number.isNaN(age) || age > L0R_CACHE_TTL_MS) {
      return { stale: true, payload: c };
    }
    return { stale: false, payload: c };
  } catch {
    return null;
  }
}

module.exports = { readLastSessionCWCache, L0R_CACHE_TTL_MS };
