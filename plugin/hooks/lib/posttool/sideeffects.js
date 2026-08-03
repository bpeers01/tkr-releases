// Fire-and-forget side effects from PostToolUse: statusline refresh,
// session record, last-activity touch, read-cache invalidate, extra-read
// flip, reconcile sweep, mode auto-select, artifact debug stderr.
//
// Every spawn here is detached + unref'd so the hook exit path is fast.

const fs = require("fs");
const path = require("path");
const { spawnBounded } = require("../spawn-bounded");
const { stateDir } = require("../state-dir");
const { tkrSpawnSync } = require("./tkr-spawn");

const RECONCILE_EVERY_N = parseInt(process.env.TKR_RECONCILE_EVERY_N || "5", 10);
const MODE_AUTO_EVERY_N = parseInt(process.env.TKR_MODE_AUTO_EVERY_N || "5", 10);
const STATUSLINE_DEBOUNCE_MS = 1_000;

function statePaths() {
  const dir = stateDir();
  return {
    dir,
    lastActivity: path.join(dir, "last-activity"),
    reconcileCounter: path.join(dir, "reconcile-counter"),
    modeAutoCounter: path.join(dir, "mode-auto-counter"),
    statuslineFire: path.join(dir, "last-statusline-fire.ms"),
  };
}

function writeLastActivity() {
  const p = statePaths();
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.lastActivity, String(Date.now()));
  } catch {
    // best-effort
  }
}

// Spawn tkr session record-event detached with the raw event JSON on
// stdin. Fire-and-forget — the hook exit path must not wait for classify
// + SQLite insert. INV-011 pattern: spawn tkr directly (no shell), pipe
// stdin, unref on successful write+end. The Go binary exits as soon as
// stdin hits EOF.
function spawnSessionRecord(rawInput) {
  try {
    const child = spawnBounded("tkr", ["session", "record-event"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    }, 5_000);
    if (!child) return;
    if (child.stdin) {
      child.stdin.on("error", () => {}); // swallow EPIPE on early child exit
      child.stdin.end(rawInput);
    }
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — never fail the hook for session-event telemetry
  }
}

// LCTX-001 Phase 3: drop read-cache entries for filePath. Detached
// spawn with 2s hard timeout; never blocks the hook exit path.
function spawnReadCacheInvalidate(filePath) {
  if (!filePath) return;
  try {
    const child = spawnBounded(
      "tkr",
      ["read-cache", "invalidate", "--quiet", filePath],
      { detached: true, stdio: "ignore", windowsHide: true },
      2_000,
    );
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — never fail the hook
  }
}

// PLAN-18: observe Read calls for extra_read signal.
function spawnFlipExtraRead(sessionID, filePath) {
  if (!sessionID || !filePath) return;
  try {
    const child = spawnBounded(
      "tkr",
      ["telemetry", "flip-extra-read", "--session", sessionID, "--path", filePath],
      { detached: true, stdio: "ignore", windowsHide: true },
      5_000,
    );
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — never fail the hook
  }
}

// Spawn tkr signals reconcile-decisions every RECONCILE_EVERY_N tool calls
// to mark stale delegate-recommendations as rejected (PLAN-19). Counter
// persisted in state dir; fire-and-forget, never blocks hook exit.
function maybeSpawnReconcile(sessionID) {
  const p = statePaths();
  try {
    let count = 0;
    try {
      count = parseInt(fs.readFileSync(p.reconcileCounter, "utf8").trim(), 10) || 0;
    } catch {}
    count++;
    fs.mkdirSync(p.dir, { recursive: true });
    // M-10: atomic tmp+rename — avoids torn reads on concurrent hook fires.
    const tmp = `${p.reconcileCounter}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, String(count));
    fs.renameSync(tmp, p.reconcileCounter);
    if (count % RECONCILE_EVERY_N !== 0) return;
    const child = spawnBounded(
      "tkr",
      ["signals", "reconcile-decisions", "--session", sessionID || ""],
      { detached: true, stdio: "ignore", windowsHide: true },
      10_000,
    );
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — never fail the hook
  }
}

// Fire-and-forget: spawn `tkr mode auto` every MODE_AUTO_EVERY_N tool calls
// so the session budget-mode tracks live pressure (PLAN-21). Guarded by
// TKR_MODE_AUTO_DISABLED=1 escape hatch. Counter persisted in state dir.
function maybeSpawnModeAuto() {
  if (process.env.TKR_MODE_AUTO_DISABLED === "1") return;
  const p = statePaths();
  try {
    let count = 0;
    try {
      count = parseInt(fs.readFileSync(p.modeAutoCounter, "utf8").trim(), 10) || 0;
    } catch {}
    count++;
    fs.mkdirSync(p.dir, { recursive: true });
    // M-10: atomic tmp+rename.
    const tmp = `${p.modeAutoCounter}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, String(count));
    fs.renameSync(tmp, p.modeAutoCounter);
    if (count % MODE_AUTO_EVERY_N !== 0) return;
    const child = spawnBounded("tkr", ["mode", "auto"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }, 5_000);
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — never fail the hook
  }
}

// AT-PLAN27: when TKR_ARTIFACT_DEBUG=1 and delta compression occurred, emit the
// most recently stored artifact's CTX: ref to stderr for traceability.
function maybeEmitArtifactDebug(stdout) {
  if (process.env.TKR_ARTIFACT_DEBUG !== "1") return;
  if (!stdout.includes("[DELTA:")) return;
  try {
    // H-14: tkrSpawnSync = spawnSync + SIGKILL + 10MB maxBuffer.
    const out = tkrSpawnSync(["artifact", "list", "--limit", "1", "--json"], { timeout: 1000 });
    const items = JSON.parse(out);
    if (items && items.length > 0) {
      process.stderr.write(
        `tkr artifact: ${items[0].id} (reuse_count=${items[0].reuse_count})\n`
      );
    }
  } catch {
    // Best-effort — never fail the hook
  }
}

// Statusline spawning is debounced because the payload is overwrite-only;
// latest write wins. Skip if a fire happened within the debounce window.
// Bounds the per-tool-call spawn rate without changing UX (statusline
// updates async).
//
// IMPORTANT: no shell wrapper. On Windows, `shell: "bash"` left the bash
// wrapper process orphaned (bash waited on its tkr child, `unref` only
// detached the bash wrapper from Node — not bash from its child), which
// accumulated zombie bash.exe processes and eventually stalled the
// Claude Code session. Spawning `tkr` directly lets Node/Windows resolve
// tkr.exe via PATHEXT and cleanly detaches on child.unref().
function shouldFireStatuslineUpdate() {
  const p = statePaths();
  try {
    const raw = fs.readFileSync(p.statuslineFire, "utf8").trim();
    const last = Number(raw);
    if (Number.isFinite(last) && Date.now() - last < STATUSLINE_DEBOUNCE_MS) {
      return false;
    }
  } catch {
    // No prior fire → fire now.
  }
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.statuslineFire, String(Date.now()));
  } catch {}
  return true;
}

function spawnStatuslineUpdate(workspaceDir, sessionID, transcriptPath) {
  if (!shouldFireStatuslineUpdate()) return;
  try {
    // PLAN-36: thread CC's event.cwd through TKR_WORKSPACE_DIR so the
    // spawned binary's cacheStatsAndSession resolves the right project
    // slug regardless of where the hook itself was invoked from. When
    // workspaceDir is missing (older callers / tests) the binary falls
    // back to os.Getwd().
    //
    // Session scope: thread the live session id + transcript path so the
    // binary reads THIS session's JSONL (cacheStatsAndSession) instead of
    // the newest-mtime file in the project dir. Without this, a concurrent
    // window or a leftover sibling transcript (resume/fork/rename) can win
    // the mtime race and leak its last_ctx_k into this session's ctx
    // injection (observed: 350K bleeding into a 100K session).
    const extra = {};
    if (workspaceDir) extra.TKR_WORKSPACE_DIR = workspaceDir;
    if (sessionID) extra.TKR_SESSION_ID = sessionID;
    if (transcriptPath) extra.TKR_TRANSCRIPT_PATH = transcriptPath;
    const env = Object.keys(extra).length
      ? Object.assign({}, process.env, extra)
      : process.env;
    const child = spawnBounded("tkr", ["statusline-update"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    }, 5_000);
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — ignore spawn errors
  }
}

module.exports = {
  writeLastActivity,
  spawnSessionRecord,
  spawnReadCacheInvalidate,
  spawnFlipExtraRead,
  maybeSpawnReconcile,
  maybeSpawnModeAuto,
  maybeEmitArtifactDebug,
  spawnStatuslineUpdate,
};
