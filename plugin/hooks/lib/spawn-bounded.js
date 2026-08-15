// Detached spawn with hard kill timeout — caps every fire-and-forget tkr
// spawn so a hung child can't accumulate across sessions (v3.9.0 pile-up bug).
//
// Pattern: spawn → schedule kill → unref. setTimeout MUST run before unref()
// so the timer keeps the parent event loop alive long enough to fire the
// killer (refs the timer to the parent process). Once unref'd, the parent
// can exit — but the timer + child handle still let us terminate the child
// from a separate Node process? No: once parent exits, the timer dies too.
//
// On Node + Windows: parent retains child handle until unref(); child.kill()
// works on detached children regardless of parent state, but only while the
// parent is alive. So if parent (the hook) exits before timeoutMs, the child
// runs uncapped. That's by design — fire-and-forget contract. The kill cap
// catches hangs WHILE the hook is still wrapping up other work.
//
// If you need a cap that survives parent death, the binary itself must hold
// the lock + age-check. That's what proc-lock.js + binary-side locks do.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { stateDir } = require("./state-dir");

const TKR_STATE_DIR = stateDir();

const TIMINGS_FILE = path.join(TKR_STATE_DIR, "hook-timings.jsonl");

function logTimeoutKill(cmd, args, timeoutMs) {
  if (process.env.TKR_HOOK_TIMINGS !== "1") return;
  try {
    const entry = {
      kind: "spawn_timeout_kill",
      cmd: String(cmd),
      args: Array.isArray(args) ? args.slice(0, 6) : [],
      timeout_ms: timeoutMs,
      ts: new Date().toISOString(),
    };
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    // C-2: rotate before append. Shared file with tkr-rewrite + post-tool-
    // call writers; any one must rotate or unbounded growth.
    try {
      const { rotateIfLarge } = require("./rotate-jsonl");
      rotateIfLarge(TIMINGS_FILE);
    } catch {
      // best-effort
    }
    fs.appendFileSync(TIMINGS_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort
  }
}

// spawnBounded spawns a detached child with a hard kill at timeoutMs.
// Returns the child handle (for stdin piping etc). Returns null on
// spawn failure — callers must check for null before using.
//
// Default timeout 5s — long enough for normal sub-100ms tkr exits,
// short enough to kill hangs before they accumulate.
function spawnBounded(cmd, args, opts, timeoutMs) {
  const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 5_000;
  let child;
  try {
    // windowsHide defaults on: hooks spawn from a console-less parent, so
    // Windows would allocate a NEW visible console per call and steal
    // focus. Defaulted here rather than at each call site because this
    // helper is the shared path — a caller may still override it.
    child = spawn(cmd, args || [], { windowsHide: true, ...(opts || {}) });
  } catch {
    return null;
  }

  const killer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
    logTimeoutKill(cmd, args, t); // Enable with TKR_HOOK_TIMINGS=1 for debugging fire-and-forget spawns.
  }, t);
  // Unref the timer so it doesn't keep the parent Node process alive.
  // Binary-side proclock is the authoritative singleton guard; if the
  // hook process exits before the timer fires, the child runs uncapped
  // — that's the fire-and-forget contract. Keeping the timer refed
  // (prior behavior) blocked SessionStart for the full timeoutMs when
  // children hung (e.g., tkr search --refresh during graph rebuild).
  killer.unref();
  child.on("exit", () => clearTimeout(killer));
  child.on("error", () => clearTimeout(killer));
  // Caller decides whether to unref the child (most callers do — fire-and-forget).
  return child;
}

module.exports = { spawnBounded };
