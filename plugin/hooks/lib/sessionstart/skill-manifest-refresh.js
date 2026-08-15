// hooks/lib/sessionstart/skill-manifest-refresh.js
//
// #263 follow-up — keeps skill-manifest.json from going permanently
// stale. skill-scrape.js writes the manifest out of the hot path, but
// nothing else ever refreshes it: after a CLI upgrade (new binary size
// + mtime), manifestEntryFor()'s own size/mtime cross-check (skill-
// bundle.js) would correctly stop trusting the stale manifest, but no
// caller would ever produce a fresh one to replace it — the first-
// invocation gate goes permanently blind again on any box that
// upgrades. This module runs a cheap staleness check at SessionStart
// and, when stale, fires a single detached rescrape.
//
// Deliberately NOT gated on `complete`: a manifest that resolved
// incompletely against an UNCHANGED binary will resolve exactly the
// same way again — the scrape recipe doesn't change without a binary
// change — so treating incomplete-but-current as stale would just
// re-run the ~22s scrape every session for no gain.

const fs = require("fs");
const path = require("path");
const { spawnBounded } = require("../spawn-bounded");
const { stateDir } = require("../state-dir");
const { hooksDisabled } = require("../stdin-with-timeout");
const { MANIFEST_FILE, MANIFEST_SCHEMA } = require("../skill-bundle");

// Stale when: no manifest on disk, unparseable, wrong schema, missing/
// empty binaryPath, OR the binary it describes no longer stats to the
// same size + floor(mtimeMs) (upgrade, reinstall, or a manifest scraped
// against a different binary than the one on this box now). Never
// throws — any unexpected shape reads as stale, which just costs one
// rescrape rather than leaving a bad manifest trusted.
function isManifestStale(opts) {
  const dir = (opts && opts.dir) || stateDir();
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
  } catch {
    return true;
  }
  if (!m || m.schema !== MANIFEST_SCHEMA) return true;
  if (typeof m.binaryPath !== "string" || m.binaryPath === "") return true;
  let st;
  try {
    st = fs.statSync(m.binaryPath);
  } catch {
    return true;
  }
  return st.size !== m.binarySize || Math.floor(st.mtimeMs) !== m.binaryMtimeMs;
}

// Detached fire-and-forget rescrape via `node skill-scrape.js` (not the
// tkr binary — the scraper is a standalone JS module with no Go verb).
// 60s hard kill: the real-binary validation scrape measured ~22s
// against a 292MB binary (#263); 60s leaves headroom without letting a
// hung scrape linger the way an uncapped spawn would.
function spawnSkillManifestRefresh(opts) {
  if (hooksDisabled()) return;
  try {
    const scriptPath = path.join(__dirname, "..", "skill-scrape.js");
    const spawnEnv = (opts && opts.env) || process.env;
    const child = spawnBounded(process.execPath, [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: spawnEnv,
    }, 60_000);
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort
  }
}

// SessionStart entry point. Call at most once per session (startup
// source only — see session-start.js) so an upgrade is picked up
// within one session start rather than piling up rescrapes on resume/
// compact sources within the same session.
function refreshSkillManifestIfStale(opts) {
  try {
    if (isManifestStale(opts)) {
      spawnSkillManifestRefresh(opts);
    }
  } catch {
    // Best-effort
  }
}

module.exports = {
  isManifestStale,
  spawnSkillManifestRefresh,
  refreshSkillManifestIfStale,
};
