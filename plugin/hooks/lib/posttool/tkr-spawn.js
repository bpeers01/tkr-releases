// Shared spawnSync wrapper for PostToolUse modules.
//
// H-14: bounded spawnSync wrapper. Replaces execFileSync calls on the
// PostToolUse hot path. execFileSync's `timeout` opt sends SIGTERM, which is
// a no-op on Windows — hung children outlive the hook. spawnSync respects
// `killSignal: "SIGKILL"` and `maxBuffer` (default 1MB; bumped to 10MB here).

const { spawnSync } = require("child_process");

function tkrSpawnSync(args, opts) {
  const o = opts || {};
  const res = spawnSync("tkr", args, {
    encoding: "utf8",
    timeout: o.timeout || 3000,
    killSignal: "SIGKILL",
    maxBuffer: o.maxBuffer || 10 * 1024 * 1024,
    input: o.input,
    stdio: o.stdio || ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.signal === "SIGKILL" || res.signal === "SIGTERM") {
    const err = new Error("tkr-spawn-killed");
    err.signal = res.signal;
    throw err;
  }
  if (typeof res.status === "number" && res.status !== 0) {
    const err = new Error(`tkr-spawn-exit-${res.status}`);
    err.status = res.status;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout;
}

module.exports = { tkrSpawnSync };
