#!/usr/bin/env node
// hooks/bench/e2e-latency-bench.js
//
// HOOK-003: END-TO-END hook latency bench — the number hooks/CLAUDE.md's
// <100ms budget is actually about. Unlike userprompt-bench.js (which
// measures one function in-process and excludes node startup), this
// spawns each hook exactly the way Claude Code does — `node <hook>` with
// JSON on stdin — so node boot, requires, state reads, and any
// synchronous subprocess spawns (route classify) are all inside the
// measurement.
//
// Report-only by default (CI containers have noisy cold-start tails);
// set BENCH_ENFORCE=1 to exit non-zero when any hook's p95 exceeds
// BENCH_BUDGET_MS (default 100).
//
// Run: node hooks/bench/e2e-latency-bench.js
//   BENCH_ITER=30 BENCH_ENFORCE=1 BENCH_BUDGET_MS=100 node hooks/bench/e2e-latency-bench.js

"use strict";

const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ITER = Number(process.env.BENCH_ITER) || 30;
const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS) || 100;
// Bash hooks pay a bash startup on top of every external spawn, so they
// get their own (looser) budget. Their load-independent regression signal
// is the forks column, not the latency.
const BASH_BUDGET_MS = Number(process.env.BENCH_BASH_BUDGET_MS) || 500;
const ENFORCE = process.env.BENCH_ENFORCE === "1";

const HOOKS_DIR = path.join(__dirname, "..");
const SID = "sid-e2e-bench";

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function benchHook(label, hookFile, payload, env) {
  const input = JSON.stringify(payload);
  const times = [];
  for (let i = 0; i < ITER; i++) {
    const t0 = process.hrtime.bigint();
    const res = spawnSync(process.execPath, [path.join(HOOKS_DIR, hookFile)], {
      input,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (res.error) {
      console.error(`${label}: spawn error: ${res.error.message}`);
      return null;
    }
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  return {
    label,
    min: times[0],
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1],
  };
}

// ── Bash hooks (issue #129 item 3) ──────────────────────────────────────
//
// The activity-touch fork storm (#129) shipped because no bench ever
// counted a bash hook's process spawns: ~9 forks per prompt looked free
// on Linux and cost 4–6s EACH under loaded-Windows spawn degradation.
// So bash hooks report FORK COUNT alongside latency — fork count is the
// load-independent number; latency is environment-dependent.
//
// Fork counting: a PATH-shim directory where common external commands
// are wrapped to append one byte to a log, then exec the real binary.
// Counts external-command spawns (the dominant Windows cost). NOT
// counted: subshell forks of pure builtins, externals missing from
// SHIM_COMMANDS, and commands exec'd via absolute path (they bypass
// PATH — e.g. a resolve-python.sh result). Treat the count as a floor.
// The count run is separate from the latency runs — the shim doubles
// each spawn, so its timings are discarded.
//
// watcher.sh is deliberately absent: it is a long-running poller
// (Stop + asyncRewake), so per-invocation latency is meaningless.

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

function makeShimDir(root, realPath) {
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

function benchBashHook(bash, label, hookFile, payload, env, shimDir, forkLog) {
  const input = JSON.stringify(payload);
  const hookPath = path.join(HOOKS_DIR, hookFile);
  const times = [];
  // stdout/stderr ignored (not piped): statusline.sh backgrounds a
  // fire-and-forget subprocess that inherits stdio, and spawnSync would
  // otherwise wait for the grandchild to close the pipe.
  const stdio = ["pipe", "ignore", "ignore"];
  for (let i = 0; i < ITER; i++) {
    const t0 = process.hrtime.bigint();
    const res = spawnSync(bash, [hookPath], { input, env, stdio, timeout: 30_000 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (res.error) {
      console.error(`${label}: spawn error: ${res.error.message}`);
      return null;
    }
    times.push(ms);
  }
  times.sort((a, b) => a - b);

  // Separate single run with the shim PATH prepended, for the fork count.
  let forks = -1;
  try {
    fs.writeFileSync(forkLog, "");
    const shimEnv = {
      ...env,
      PATH: `${shimDir}${path.delimiter}${env.PATH || ""}`,
      TKR_BENCH_FORK_LOG: forkLog,
      TKR_BENCH_REAL_PATH: env.PATH || "",
    };
    const res = spawnSync(bash, [hookPath], { input, env: shimEnv, stdio, timeout: 30_000 });
    if (!res.error) forks = fs.statSync(forkLog).size;
  } catch {
    // fork count stays -1 (reported as "?")
  }

  return {
    label,
    min: times[0],
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1],
    forks,
  };
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-e2e-bench-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  // Synthetic mid-session statusline payload so reads hit real content.
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
    })
  );

  const env = {
    ...process.env,
    TKR_STATE_DIR: stateDir,
    TMPDIR: dir,
    TKR_STATUSLINE_PATH: telPath,
    TKR_ROUTE_CACHE_DIR: dir,
    TKR_SESSION_ID: SID,
  };
  // The developer's own session env must not leak into measurements.
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.CLAUDE_EFFORT;

  // HOOK-003: one warm-up rewrite lets the binary write the rewrite-heads
  // manifest into this bench's state dir through its real refresh path, so
  // the fastpath scenario below measures what installs actually get. With no
  // binary on PATH there is no manifest and the fastpath scenario measures
  // the (identical) no-binary passthrough.
  let manifest = "no";
  try {
    execFileSync(process.env.TKR_BIN || "tkr", ["rewrite", "git status"], {
      env, stdio: "ignore", timeout: 10_000,
    });
    manifest = "yes";
  } catch (err) {
    if (!(err && err.code === "ENOENT")) manifest = "yes"; // ran, nonzero exit
  }
  if (manifest === "yes" && !fs.existsSync(path.join(stateDir, "rewrite-heads.json"))) {
    manifest = "missing(!)"; // binary present but didn't write — fastpath off
  }
  console.log(`rewrite-heads manifest: ${manifest}`);

  const runs = [
    benchHook("user-prompt-submit", "user-prompt-submit.js", {
      session_id: SID,
      cwd: process.cwd(),
      prompt: "explain how the filter registry matches a kubectl describe command",
    }, env),
    benchHook("post-tool-call", "post-tool-call.js", {
      session_id: SID,
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: { stdout: "On branch main\nnothing to commit\n", stderr: "", interrupted: false },
    }, env),
    benchHook("tkr-rewrite", "tkr-rewrite.js", {
      session_id: SID,
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "git status" },
    }, env),
    // HOOK-003 fast-path: a command no rewrite rule or filter can match.
    // With the manifest present this must not spawn the binary — expect
    // roughly the no-binary hook cost. The eligible scenario above stays
    // binary-startup-bound (#67).
    benchHook("tkr-rewrite-fastpath", "tkr-rewrite.js", {
      session_id: SID,
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "cd /tmp/project && export BUILD=1 && mkdir -p out" },
    }, env),
  ].filter(Boolean);

  // Bash hooks (issue #129 item 3) — latency + fork count.
  const bash = findBash();
  if (bash) {
    const shimDir = makeShimDir(dir, env.PATH || "");
    const forkLog = path.join(dir, "fork-count");
    // Realistic CC spawn: no TKR_SESSION_ID env, so resolve-sid.sh takes
    // the payload-parse path (the python spawn) — the fork-heavy branch
    // that actually runs in production.
    const bashEnv = { ...env };
    delete bashEnv.TKR_SESSION_ID;
    runs.push(
      benchBashHook(bash, "keepalive/cleanup [sh]", "keepalive/cleanup.sh", {
        session_id: SID,
        cwd: process.cwd(),
      }, bashEnv, shimDir, forkLog),
      benchBashHook(bash, "statusline [sh]", "statusline.sh", {
        session_id: SID,
        transcript_path: path.join(dir, `${SID}.jsonl`),
        cwd: process.cwd(),
        model: { id: "claude-opus-4-6", display_name: "Opus 4.6" },
      }, bashEnv, shimDir, forkLog),
    );
  } else {
    console.log("bash not found — bash hook scenarios skipped");
  }
  const finalRuns = runs.filter(Boolean);

  console.log(`e2e hook latency — ${ITER} spawns each (includes interpreter startup; budget ${BUDGET_MS}ms p95, bash ${BASH_BUDGET_MS}ms p95)`);
  console.log("hook                       min      p50      p95      max  forks");
  let failed = false;
  for (const r of finalRuns) {
    const budget = r.forks === undefined ? BUDGET_MS : BASH_BUDGET_MS;
    const flag = r.p95 > budget ? "  << OVER BUDGET" : "";
    if (r.p95 > budget) failed = true;
    const forks = r.forks === undefined ? "" : `  ${r.forks < 0 ? "?" : r.forks}`.padStart(5);
    console.log(
      `${r.label.padEnd(24)} ${r.min.toFixed(1).padStart(6)}ms ${r.p50.toFixed(1).padStart(6)}ms ` +
      `${r.p95.toFixed(1).padStart(6)}ms ${r.max.toFixed(1).padStart(6)}ms${forks}${flag}`
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });

  if (failed && ENFORCE) {
    console.error(`FAIL: at least one hook p95 exceeded ${BUDGET_MS}ms (BENCH_ENFORCE=1)`);
    process.exit(1);
  }
}

main();
