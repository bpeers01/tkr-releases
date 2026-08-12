// Per-session mode bootstrap + stale-file sweep (PLAN-33).
//
// Two responsibilities, both fire-and-forget on SessionStart:
//
// 1. Sweep stale `~/.tkr/mode-*.json` files older than 24h. Crashed
//    sessions never hit Stop, so without a sweep the dir grows
//    unbounded over the project's lifetime. Mirrors
//    sweepStaleStatuslineFiles policy (same 24h cutoff).
//
// 2. Spawn `tkr mode auto` with TKR_SESSION_ID exported so the
//    binary writes a fresh per-session `mode-<sid>.json` from live
//    pressure. Without this, the statusline reads the leftover
//    global `mode.json` (e.g. "critical" from the prior session)
//    and badges the new session incorrectly even though pressure
//    is low. Detached so hook return isn't blocked by the spawn.
//
// Best-effort throughout. Never throws — SessionStart cannot afford
// to fail on tidiness work.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { tkrSpawnArgv } = require("../tkr-bin");

const STALE_MS = 24 * 60 * 60 * 1000; // 24h

function stateDir() {
  return process.env.TKR_STATE_DIR || path.join(os.homedir(), ".tkr");
}

// sweepStaleModeFiles deletes stale mode state files under ~/.tkr/.
// Three classes, all with the same 24h cutoff:
//
//   1. `mode-<sid>.json` — per-session files left by crashed sessions.
//   2. `mode-auto-counter.tmp.*` — proc-lock tmp files. The lock helper
//      atomic-renames on acquire; on abnormal exit the tmp can be
//      orphaned and the SessionStart sweep is the only cleanup path.
//   3. `mode.json` — legacy global file. After PLAN-34 every CLI
//      invocation resolves sid via DiscoverSID, so the legacy file is
//      only written by very old tkr versions or genuinely sid-less
//      shell invocations. A stale legacy file (e.g. "critical" from
//      yesterday) misleads any rare sid-less reader.
//   4. `effort-<sid>.json` (+ its `.tmp.*` orphans) — per-session
//      active-effort snapshots written by persistSessionEffort; same
//      crashed-session leak profile as class 1.
//
// Returns the count removed. Best-effort: any fs error short-circuits.
function sweepStaleModeFiles(now = Date.now(), staleMs = STALE_MS) {
  const dir = stateDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const isPerSession = name.startsWith("mode-") && name.endsWith(".json");
    const isLegacy = name === "mode.json";
    const isLockTmp = name.startsWith("mode-auto-counter.tmp.");
    const isEffort = name.startsWith("effort-") &&
      (name.endsWith(".json") || name.includes(".json.tmp."));
    if (!isPerSession && !isLegacy && !isLockTmp && !isEffort) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < staleMs) continue;
    try {
      fs.unlinkSync(full);
      removed++;
    } catch {
      // file may be locked by another process — skip
    }
  }
  return removed;
}

// spawnModeAuto fires `tkr mode auto` detached so the current session
// writes its per-session mode-<sid>.json from live pressure. sid is
// passed via env (TKR_SESSION_ID) so the binary's StatePath resolver
// picks the right per-session file. Returns true when spawn launched,
// false when guarded off or the binary missing.
//
// Bounded by spawnBoundedFn (injectable for tests). Caller fires this
// from SessionStart only.
function spawnModeAuto(sid, spawnBoundedFn) {
  if (!sid) return false;
  if (process.env.TKR_MODE_AUTO_DISABLED === "1") return false;
  if (typeof spawnBoundedFn !== "function") return false;
  try {
    const env = Object.assign({}, process.env, { TKR_SESSION_ID: sid });
    const { cmd, argv } = tkrSpawnArgv(["mode", "auto"], env);
    const child = spawnBoundedFn(
      cmd,
      argv,
      { detached: true, stdio: "ignore", windowsHide: true, env },
      5_000
    );
    if (!child) return false;
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { sweepStaleModeFiles, spawnModeAuto, STALE_MS };
