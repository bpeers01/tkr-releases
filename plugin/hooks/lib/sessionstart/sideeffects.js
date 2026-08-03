// Detached fire-and-forget spawns from SessionStart.
//
// spawnCleanupOld — prune >7-day session rows from SQLite. Binary-side
//   lock prevents concurrent cleanups. 10s hard kill.
// spawnCaptureRules — capture CLAUDE.md rule paths so they survive
//   /compact (PLAN-6). 10s hard kill.

const { spawnBounded } = require("../spawn-bounded");

function spawnCleanupOld(projectPath) {
  try {
    const args = ["session", "cleanup-old"];
    if (projectPath) {
      args.push("--project", projectPath);
    }
    const child = spawnBounded("tkr", args, {
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
    const child = spawnBounded("tkr", args, {
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

module.exports = { spawnCleanupOld, spawnCaptureRules };
