// hooks/bench/fork-shim.js
//
// PATH-shim fork counter for bash hooks, shared by e2e-latency-bench.js
// (which reports the number) and fork-budget.test.js (which enforces it).
//
// Why fork count and not latency: the activity-touch fork storm (#129)
// shipped because no bench ever counted a bash hook's process spawns.
// ~9 forks per prompt looks free on Linux and costs 4-6s EACH under
// loaded-Windows spawn degradation (INV-085), which is what blew the 30s
// UserPromptSubmit budget and made Claude Code discard the turn's injected
// context. Fork count is the load-INDEPENDENT signal; latency is not.
//
// Mechanism: a directory of wrappers for common external commands, each
// appending one byte to a log before exec'ing the real binary, prepended
// to PATH for a single run. The log's size is the fork count.
//
// It is a FLOOR, not a total. Not counted: subshell forks of pure
// builtins, externals missing from SHIM_COMMANDS, and anything exec'd by
// absolute path (which bypasses PATH — e.g. a resolve-python.sh result).
// A budget built on it should be read as "no more than N of the spawns we
// can see", which is exactly the regression signal #129 needed and still
// catches a new fork added through PATH.

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SHIM_COMMANDS = [
  "date", "sed", "tr", "cat", "mkdir", "rm", "rmdir", "sleep", "mv", "cp",
  "python", "python3", "py", "grep", "cut", "head", "tail", "wc", "uname",
  "find", "touch", "dirname", "basename", "stat", "jq", "git", "curl",
  "node", "tkr",
];

function findBash() {
  const probe = spawnSync("bash", ["-c", "exit 0"]);
  return probe.error ? null : "bash";
}

function makeShimDir(root) {
  const shimDir = path.join(root, "fork-shims");
  fs.mkdirSync(shimDir, { recursive: true });
  for (const cmd of SHIM_COMMANDS) {
    const shim = path.join(shimDir, cmd);
    fs.writeFileSync(
      shim,
      `#!/bin/bash\n` +
        `printf . >> "$TKR_BENCH_FORK_LOG"\n` +
        `PATH="$TKR_BENCH_REAL_PATH" exec ${cmd} "$@"\n`
    );
    fs.chmodSync(shim, 0o755);
  }
  return shimDir;
}

// countForksDetailed runs one invocation of a bash hook under the shim
// PATH and returns { forks, error }. forks is -1 when the run itself
// failed, and error then names why.
//
// The distinction matters and is not defensive padding: this measurement
// runs alongside a parallel test suite that is itself spawning processes,
// so `fork: Resource temporarily unavailable` is a reachable outcome. A
// budget assertion that cannot tell "the hook spawned too much" from "the
// machine could not spawn at all" turns a saturated runner into a red
// build about hook behavior, which is both wrong and the kind of flake
// people learn to ignore.
//
// stdout/stderr are ignored rather than piped: statusline.sh backgrounds a
// fire-and-forget subprocess that inherits stdio, and spawnSync would
// otherwise block until that grandchild closes the pipe.
function countForksDetailed(bash, hookPath, payload, env, shimDir, forkLog) {
  try {
    fs.writeFileSync(forkLog, "");
    const shimEnv = {
      ...env,
      PATH: `${shimDir}${path.delimiter}${env.PATH || ""}`,
      TKR_BENCH_FORK_LOG: forkLog,
      TKR_BENCH_REAL_PATH: env.PATH || "",
    };
    const res = spawnSync(bash, [hookPath], {
      input: JSON.stringify(payload),
      env: shimEnv,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 30_000,
    });
    if (res.error) {
      return { forks: -1, error: `spawn failed: ${res.error.code || res.error.message}` };
    }
    if (res.signal) {
      return { forks: -1, error: `killed by ${res.signal} (timeout?)` };
    }
    return { forks: fs.statSync(forkLog).size, error: "" };
  } catch (err) {
    return { forks: -1, error: `fork log unreadable: ${err && err.message}` };
  }
}

// countForks keeps the original shape for the reporting bench, which has
// a "?" column for -1 and no use for the reason.
function countForks(bash, hookPath, payload, env, shimDir, forkLog) {
  return countForksDetailed(bash, hookPath, payload, env, shimDir, forkLog).forks;
}

module.exports = { SHIM_COMMANDS, findBash, makeShimDir, countForks, countForksDetailed };
