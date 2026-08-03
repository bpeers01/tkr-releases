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

  console.log(`e2e hook latency — ${ITER} spawns each (includes node startup, budget ${BUDGET_MS}ms p95)`);
  console.log("hook                     min      p50      p95      max");
  let failed = false;
  for (const r of runs) {
    const flag = r.p95 > BUDGET_MS ? "  << OVER BUDGET" : "";
    if (r.p95 > BUDGET_MS) failed = true;
    console.log(
      `${r.label.padEnd(22)} ${r.min.toFixed(1).padStart(6)}ms ${r.p50.toFixed(1).padStart(6)}ms ` +
      `${r.p95.toFixed(1).padStart(6)}ms ${r.max.toFixed(1).padStart(6)}ms${flag}`
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });

  if (failed && ENFORCE) {
    console.error(`FAIL: at least one hook p95 exceeded ${BUDGET_MS}ms (BENCH_ENFORCE=1)`);
    process.exit(1);
  }
}

main();
