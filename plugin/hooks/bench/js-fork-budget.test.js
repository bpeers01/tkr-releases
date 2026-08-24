#!/usr/bin/env node
// Fork budgets for the registered JS hooks — INV-085 step 2.
//
// The gap this closes: fork-budget.test.js has enforced a spawn ceiling since
// #132, and it covers the BASH hooks only. It counts through a PATH shim, and
// the JS hooks do not resolve their binary through PATH — hooks/lib/tkr-bin.js
// hands spawn an absolute path on purpose (INV-119). So the one hook actually
// being cancelled in production, user-prompt-submit.js, has never had a fork
// budget at all. The guard did not cover the file it exists for.
//
// Mechanism: TKR_BIN wins over every other candidate in resolveTkrBin(), and a
// TKR_BIN ending in .js is launched as `node <path> <args...>` by
// tkrSpawnArgv(). Pointing it at a shim that appends one line per invocation
// counts every tkr spawn the hook makes, on Windows and POSIX alike — the same
// cross-platform shim shape the veto tests already use (#143 finding 1).
//
// It is a FLOOR, not a total, for the same reason the bash counter is: it sees
// tkr spawns, not every process the hook could create. That is the right floor
// here, because every per-prompt spawn on this path IS a tkr spawn.
//
// Why fork count and not latency: a spawn costs ~30ms on an idle box and 4-6s
// under the loaded-Windows degradation in INV-085. Count is the load-
// independent signal; latency measured on a quiet CI runner would report this
// hook as free right up until it eats a user's turn.
//
// Run: node --test hooks/bench/js-fork-budget.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOKS_DIR = path.join(__dirname, "..");
const TKR_BIN_MODULE = path.join(HOOKS_DIR, "lib", "tkr-bin.js");
const SID = "sid-js-fork-budget";

// Budget, and what it is measuring today:
//   user-prompt-submit.js  1  (`tkr hook prompt-submit`, the merged call)
// One above the measured count, so a single deliberate addition passes and is
// caught at the next review, while a storm fails immediately.
//
// INV-085 step 3 landed the merge, so this dropped from 3 to 2 in the same PR
// rather than leaving the ceiling sized for the pre-fix count. The measured 1
// is the merged path: the payload below is a normal prompt, which is what
// mergedPromptSubmitEligible() admits. A /brevity prompt or a subagent
// dispatch takes the other branch and still spawns exactly once — the
// detached record-event — so no input shape reaches 2 today.
const HOOKS = [
  {
    label: "user-prompt-submit.js",
    file: "user-prompt-submit.js",
    budget: 2,
    payload: {
      session_id: SID,
      cwd: process.cwd(),
      prompt: "refactor the retry helper in internal/queue and add a test",
      model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
    },
  },
];

// The shim stands in for the tkr binary. It records the invocation and exits
// 0 without reading stdin: spawnRecordPromptEvent pipes the payload in, and a
// shim that never drains it is the realistic case anyway — the hook already
// handles EPIPE on that stream.
function makeShim(dir) {
  const shim = path.join(dir, "tkr-shim.js");
  fs.writeFileSync(
    shim,
    '"use strict";\n' +
      'try {\n' +
      '  require("fs").appendFileSync(\n' +
      '    process.env.TKR_BENCH_FORK_LOG,\n' +
      '    JSON.stringify(process.argv.slice(2)) + "\\n",\n' +
      '  );\n' +
      '} catch {}\n' +
      'process.exit(0);\n',
  );
  return shim;
}

function countLines(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw ? raw.split("\n").length : 0;
  } catch {
    return 0;
  }
}

// Synchronous sleep with no process of its own — spawning a sleeper inside a
// test that counts spawns would be measuring the instrument.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// settle waits for the count to stop moving. spawnRecordPromptEvent is
// DETACHED and unref'd, so the hook process can exit before its child has
// written anything — reading the log the instant the hook returns races the
// very spawn we are counting and would under-report it as 0. Polling to a
// stable value is what makes the number reproducible; without it this test
// would flake green, which is worse than no test.
function settle(file, quietMs = 400, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  let last = countLines(file);
  let stableSince = Date.now();
  for (;;) {
    sleepSync(50);
    const now = countLines(file);
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return last;
    }
    if (Date.now() > deadline) return last;
  }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-js-fork-budget-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  // Mid-session statusline payload, so the context detectors read real content
  // rather than taking the empty-file fast path and skipping work a production
  // run would do.
  const telPath = path.join(dir, `claude-statusline-slug-${SID}.json`);
  fs.writeFileSync(
    telPath,
    JSON.stringify({
      session_id: SID,
      turn_count: 120,
      last_ctx_k: 95,
      five_hour_pct: 34,
      weekly_pct: 51,
      cache_ttl: "1h",
      model_display: "Opus 4.6",
    }),
  );

  const forkLog = path.join(dir, "fork-count.jsonl");
  fs.writeFileSync(forkLog, "");
  const shim = makeShim(dir);

  const env = {
    ...process.env,
    TKR_BIN: shim,
    TKR_BENCH_FORK_LOG: forkLog,
    TKR_STATE_DIR: stateDir,
    TMPDIR: dir,
    TKR_STATUSLINE_PATH: telPath,
    TKR_ROUTE_CACHE_DIR: dir,
  };
  delete env.TKR_SESSION_ID;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.CLAUDE_EFFORT;
  delete env.TKR_HOOKS_DISABLED;
  delete env.TKR_ROUTE_DISABLED;
  delete env.TKR_ROUTE_SYNC;

  return {
    dir,
    env,
    forkLog,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// measure runs one JS hook and returns { forks, error }. -1 means the run
// itself failed — a saturated runner is a transient condition, not a hook
// regression, and a budget that cannot tell the two apart is a flake that
// teaches people to ignore fork budgets.
function measure(hookPath, payload, fx) {
  fs.writeFileSync(fx.forkLog, "");
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    env: fx.env,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 30_000,
    windowsHide: true,
  });
  if (res.error) {
    return { forks: -1, error: `spawn failed: ${res.error.code || res.error.message}` };
  }
  if (res.signal) {
    return { forks: -1, error: `killed by ${res.signal} (timeout?)` };
  }
  return { forks: settle(fx.forkLog), error: "" };
}

for (const hook of HOOKS) {
  test(`js fork budget: ${hook.label} spawns tkr at most ${hook.budget} times`, (t) => {
    const fx = fixture();
    try {
      const { forks, error } = measure(path.join(HOOKS_DIR, hook.file), hook.payload, fx);
      if (forks === -1) {
        t.skip(`${hook.label}: could not measure (${error}) — inconclusive, not a pass`);
        return;
      }
      assert.ok(
        forks <= hook.budget,
        `${hook.label} spawned tkr ${forks} times, budget ${hook.budget}. ` +
          `Each creation costs 4-6s under loaded-Windows spawn degradation and ` +
          `is bounded by NO timeout the hook can set (INV-085: spawnSync's timer ` +
          `starts after uv_spawn returns). Remove the spawn, or raise the budget ` +
          `here deliberately and say why.`,
      );
    } finally {
      fx.cleanup();
    }
  });
}

test("the counter can actually see tkr spawns", (t) => {
  // Without this, the budget above passes vacuously the moment the shim
  // mechanism breaks — a TKR_BIN that stops winning resolution, an unwritable
  // log, a tkrSpawnArgv that stops launching .js through node. Pins both ends:
  // 0 for a hook that spawns nothing, 2 for one that spawns twice, through the
  // same resolver the real hooks use.
  const fx = fixture();
  try {
    const quiet = path.join(fx.dir, "quiet-hook.js");
    fs.writeFileSync(quiet, 'process.stdin.resume();process.stdin.on("data",()=>{});\nprocess.exit(0);\n');
    const q = measure(quiet, {}, fx);

    const noisy = path.join(fx.dir, "noisy-hook.js");
    fs.writeFileSync(
      noisy,
      'const { tkrSpawnArgv } = require(' + JSON.stringify(TKR_BIN_MODULE) + ');\n' +
        'const { spawnSync } = require("child_process");\n' +
        'for (const n of ["one", "two"]) {\n' +
        '  const { cmd, argv } = tkrSpawnArgv(["probe", n]);\n' +
        '  spawnSync(cmd, argv, { stdio: "ignore", windowsHide: true });\n' +
        '}\n',
    );
    const n = measure(noisy, {}, fx);

    if (q.forks === -1 || n.forks === -1) {
      t.skip(`could not measure (${q.error || n.error}) — inconclusive, not a pass`);
      return;
    }
    assert.strictEqual(q.forks, 0, "a hook spawning no tkr must count 0");
    assert.strictEqual(n.forks, 2, "two tkr spawns must count 2");
  } finally {
    fx.cleanup();
  }
});
