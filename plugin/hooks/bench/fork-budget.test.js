#!/usr/bin/env node
// Fork budgets for the registered bash hooks — issue #132 item 1.
//
// The gap this closes: e2e-latency-bench.js has counted bash-hook forks
// since 2026-07-25, but it only PRINTS the number. Its BENCH_ENFORCE=1
// path checks p95 latency and nothing else, and the bench is run by
// nothing — not CI, not scripts/ci-local.sh, not the Makefile. So the
// signal that would have caught #129 exists, is correct, and fires at
// nobody. A regression guard nobody runs is not a guard.
//
// This is the same measurement as an ordinary `node --test` suite, so it
// runs on every PR through ci.yml's `node --test hooks/**/*.test.js` and
// through ci-local.sh step 7a. Cost is one spawn per hook.
//
// Budgets are ceilings with headroom, not golden values. The point is to
// catch a fork STORM (#129 added ~9 to one hook), not to freeze the exact
// count — a legitimate +1 should be a deliberate budget bump with a
// reason, and a +5 should fail loudly.
//
// Run: node --test hooks/bench/fork-budget.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findBash, makeShimDir, countForksDetailed } = require("./fork-shim");

const HOOKS_DIR = path.join(__dirname, "..");
const SID = "sid-fork-budget";
const BASH = findBash();
const SKIP = !BASH && "bash not available on this runner";

// Measured on Linux with python3 present, stable across runs:
//   keepalive/cleanup.sh  4
//   statusline.sh         6
// Budgets sit one above each so a single added spawn passes and is caught
// on the next deliberate review, while a storm fails immediately.
//
// Only hooks that are actually REGISTERED are listed. watcher.sh is not:
// plugin.json's Stop entry runs `tkr keepalive watch`, the Go fork-free
// replacement (INV-085, "zero per-tick child processes"), so watcher.sh is
// vestigial and its fork count guards nothing. That is a change since
// #132 was filed, which names "watcher.sh Stop path" as in scope.
const HOOKS = [
  {
    label: "keepalive/cleanup.sh",
    file: path.join("keepalive", "cleanup.sh"),
    budget: 5,
    payload: { session_id: SID, cwd: process.cwd() },
  },
  {
    label: "statusline.sh",
    file: "statusline.sh",
    budget: 7,
    payload: {
      session_id: SID,
      cwd: process.cwd(),
      model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
    },
  },
];

// measure runs the count, retrying once on a spawn failure before giving
// up. A saturated runner is a transient condition, not a hook regression:
// this suite runs in parallel with the rest of `node --test hooks/**`, and
// a fork budget that goes red because the machine briefly could not fork
// is a flake that teaches people to ignore fork budgets. Two consecutive
// spawn failures is treated as inconclusive and reported as such — never
// as a silent pass, and never as a budget violation.
function measure(hookPath, payload, fx) {
  const shimDir = makeShimDir(fx.dir);
  const forkLog = path.join(fx.dir, "fork-count");
  let last = countForksDetailed(BASH, hookPath, payload, fx.env, shimDir, forkLog);
  if (last.forks === -1) {
    last = countForksDetailed(BASH, hookPath, payload, fx.env, shimDir, forkLog);
  }
  return last;
}

// Isolated state + a synthetic mid-session statusline payload so reads hit
// real content rather than the empty-file fast path.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-fork-budget-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const telPath = path.join(dir, `claude-statusline-slug-${SID}.json`);
  fs.writeFileSync(
    telPath,
    JSON.stringify({
      session_id: SID,
      turn_count: 42,
      last_ctx_k: 95,
      five_hour_pct: 34,
      weekly_pct: 51,
      cache_ttl: "1h",
    }),
  );
  const env = {
    ...process.env,
    TKR_STATE_DIR: stateDir,
    TMPDIR: dir,
    TKR_STATUSLINE_PATH: telPath,
    TKR_ROUTE_CACHE_DIR: dir,
  };
  // Realistic Claude Code spawn: no TKR_SESSION_ID, so resolve-sid.sh takes
  // the payload-parse path — the fork-heavy branch that runs in production.
  // Leaving it set would measure a cheaper hook than anyone actually runs.
  delete env.TKR_SESSION_ID;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.CLAUDE_EFFORT;
  return { dir, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

for (const hook of HOOKS) {
  test(`fork budget: ${hook.label} spawns at most ${hook.budget} external commands`, { skip: SKIP }, (t) => {
    const fx = fixture();
    try {
      const { forks, error } = measure(path.join(HOOKS_DIR, hook.file), hook.payload, fx);
      if (forks === -1) {
        t.skip(`${hook.label}: could not measure (${error}) — inconclusive, not a pass`);
        return;
      }
      assert.ok(
        forks <= hook.budget,
        `${hook.label} spawned ${forks} external commands, budget ${hook.budget}. ` +
          `Each one costs 4-6s under loaded-Windows spawn degradation (INV-085) — ` +
          `that is how #129 blew the 30s UserPromptSubmit budget. Remove the spawn, ` +
          `or raise the budget here deliberately and say why.`,
      );
    } finally {
      fx.cleanup();
    }
  });
}

test("the counter can actually see forks — a hook that spawns nothing reads 0", { skip: SKIP }, (t) => {
  // Without this, every budget assertion above would pass vacuously if the
  // shim mechanism silently broke (wrong PATH, unwritable log, a bash that
  // resolves builtins first). Pins both ends: 0 for a no-op script, and a
  // nonzero count for one that spawns a shimmed command.
  const fx = fixture();
  try {
    const quiet = path.join(fx.dir, "quiet.sh");
    fs.writeFileSync(quiet, "#!/bin/bash\n: ignore stdin\n");
    const q = measure(quiet, {}, fx);

    const noisy = path.join(fx.dir, "noisy.sh");
    fs.writeFileSync(noisy, "#!/bin/bash\ndate >/dev/null\ndate >/dev/null\n");
    const n = measure(noisy, {}, fx);

    if (q.forks === -1 || n.forks === -1) {
      t.skip(`could not measure (${q.error || n.error}) — inconclusive, not a pass`);
      return;
    }
    assert.strictEqual(q.forks, 0, "a script spawning no external command must count 0");
    assert.strictEqual(n.forks, 2, "two shimmed spawns must count 2");
  } finally {
    fx.cleanup();
  }
});
