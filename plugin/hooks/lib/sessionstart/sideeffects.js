// Detached fire-and-forget spawns from SessionStart.
//
// spawnCleanupOld — prune >7-day session rows from SQLite. Binary-side
//   lock prevents concurrent cleanups. 10s hard kill.
// spawnCaptureRules — capture CLAUDE.md rule paths so they survive
//   /compact (PLAN-6). 10s hard kill.
// spawnKeepalivePrune — reap orphan ~/.tkr/keepalive/<sid>/ dirs
//   (INV-085 adjacent finding: cleanup.sh runs only on a clean
//   SessionEnd, so crashed sessions leaked dirs forever and `tkr
//   keepalive prune-state` had no automatic caller). 10s hard kill.

const { spawnBounded } = require("../spawn-bounded");
const { tkrSpawnArgv } = require("../tkr-bin");

function spawnCleanupOld(projectPath) {
  try {
    const args = ["session", "cleanup-old"];
    if (projectPath) {
      args.push("--project", projectPath);
    }
    const { cmd, argv } = tkrSpawnArgv(args);
    const child = spawnBounded(cmd, argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }, 10_000);
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort
  }
}

function spawnCaptureRules(sid, projectPath) {
  try {
    const args = ["session", "capture-rules", "--session-id", sid, "--project", projectPath];
    const { cmd, argv } = tkrSpawnArgv(args);
    const child = spawnBounded(cmd, argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }, 10_000);
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort
  }
}

// spawnKeepalivePrune reaps orphan keepalive state dirs via the Go verb
// rather than a JS mtime sweep: `tkr keepalive prune-state` validates
// liveness against the CC session registry (INV-054 pid guards) and
// keeps anything <5min old, so a live-but-idle session's watcher state
// is never reaped the way a naive 24h-mtime sweep could. Honors
// TKR_KEEPALIVE_DISABLE the same way the rest of SessionStart honors
// feature switches: pruning still runs — it removes state, it does not
// create keepalive activity.
function spawnKeepalivePrune() {
  try {
    const { cmd, argv } = tkrSpawnArgv(["keepalive", "prune-state"]);
    const child = spawnBounded(cmd, argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }, 10_000);
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort
  }
}

module.exports = { spawnCleanupOld, spawnCaptureRules, spawnKeepalivePrune };
