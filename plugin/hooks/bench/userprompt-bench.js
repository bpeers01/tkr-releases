#!/usr/bin/env node
// hooks/bench/userprompt-bench.js
//
// PR #1 latency bench — measures writeInjectionLogRow() in isolation
// over 1000 iterations. Excludes node startup (in-process require, no
// subprocess spawn). Reports min/p50/p95/max in ms; fails if p95 ≥ 5ms.
//
// Per docs/proposals/2026-05-12-prefix-aware-context-injection.md §11.4.
// Hook total budget is p95 < 100ms (§7 Phase 1). Writer-only budget
// here is 5ms — comfortable margin since existing hook work is also
// well under 100ms.
//
// Run: node hooks/bench/userprompt-bench.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ITER = Number(process.env.BENCH_ITER) || 1000;
const P95_BUDGET_MS = 5;

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ups-bench-"));
  process.env.TKR_STATE_DIR = dir;

  // Synthetic statusline payload — realistic mid-session values.
  const telPath = path.join(dir, "claude-statusline.json");
  fs.writeFileSync(
    telPath,
    JSON.stringify({
      turn_count: 87,
      last_ctx_k: 142,
      idle_secs: 33,
      five_hour_pct: 41,
      seven_day_pct: 64,
    }),
  );

  // Fresh require after TKR_STATE_DIR set.
  delete require.cache[require.resolve("../user-prompt-submit.js")];
  const { writeInjectionLogRow } = require("../user-prompt-submit.js");

  const input = {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    prompt: "implement the feature",
  };
  const emitted =
    "[tkr brevity: full — fragments, no articles, no filler, no hedging]\n" +
    "[tkr pressure: 7d=64% 5h=41%]";

  // Warmup (JIT, fs cache).
  for (let i = 0; i < 50; i++) writeInjectionLogRow(input, emitted, telPath);

  const samples = new BigInt64Array(ITER);
  for (let i = 0; i < ITER; i++) {
    const t0 = process.hrtime.bigint();
    writeInjectionLogRow(input, emitted, telPath);
    samples[i] = process.hrtime.bigint() - t0;
  }

  const sorted = Array.from(samples).sort((a, b) => (a < b ? -1 : 1));
  const ns = (i) => Number(sorted[i]);
  const ms = (n) => (n / 1_000_000).toFixed(3);
  const min = ns(0);
  const p50 = ns(Math.floor(ITER * 0.5));
  const p95 = ns(Math.floor(ITER * 0.95));
  const max = ns(ITER - 1);

  const logSize = fs.statSync(path.join(dir, "injection-events.jsonl")).size;

  process.stdout.write(
    [
      `tkr injection-log writer bench — N=${ITER}`,
      `  min:  ${ms(min)} ms`,
      `  p50:  ${ms(p50)} ms`,
      `  p95:  ${ms(p95)} ms  (budget: ${P95_BUDGET_MS} ms)`,
      `  max:  ${ms(max)} ms`,
      `  log:  ${logSize} bytes after ${ITER + 50} rows`,
      ``,
    ].join("\n"),
  );

  // Cleanup.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  const p95Ms = p95 / 1_000_000;
  if (p95Ms >= P95_BUDGET_MS) {
    process.stderr.write(`FAIL: p95 ${p95Ms.toFixed(3)}ms ≥ ${P95_BUDGET_MS}ms budget\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
