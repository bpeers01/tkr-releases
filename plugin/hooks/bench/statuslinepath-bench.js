#!/usr/bin/env node
// hooks/bench/statuslinepath-bench.js
//
// HOOK-003(d): measure newestPerSessionPath's tmpdir scan before deciding
// whether it needs bounding. The scan runs only on the sid-less fallback
// path (manual tkr invocations; hooks set TKR_SESSION_ID and skip it), but
// its cost scales with TOTAL tmpdir entry count — readdirSync lists
// everything, then prefix-tests each name and stats only matches. Windows
// never auto-cleans %TEMP%, so multi-thousand-entry tmpdirs are realistic.
//
// Run: node hooks/bench/statuslinepath-bench.js
//   BENCH_ITER=200 node hooks/bench/statuslinepath-bench.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { newestPerSessionPath } = require("../lib/statusline-path");

const ITER = Number(process.env.BENCH_ITER) || 200;
const SLUG = "-home-bench-project";
const MATCHING = 25; // per-session leftovers within the 24h sweep window

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function benchAt(entryCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-slpath-bench-"));
  try {
    for (let i = 0; i < entryCount - MATCHING; i++) {
      fs.writeFileSync(path.join(dir, `unrelated-${i}.tmp`), "");
    }
    for (let i = 0; i < MATCHING; i++) {
      fs.writeFileSync(
        path.join(dir, `claude-statusline-${SLUG}-sid${i}.json`),
        "{}"
      );
    }
    const times = [];
    for (let i = 0; i < ITER; i++) {
      const t0 = process.hrtime.bigint();
      const got = newestPerSessionPath(dir, SLUG);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (!got) throw new Error("scan found nothing — bench setup broken");
    }
    times.sort((a, b) => a - b);
    console.log(
      `${String(entryCount).padStart(6)} entries  ` +
      `p50 ${pct(times, 50).toFixed(3).padStart(8)}ms  ` +
      `p95 ${pct(times, 95).toFixed(3).padStart(8)}ms  ` +
      `max ${times[times.length - 1].toFixed(3).padStart(8)}ms`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`newestPerSessionPath scan — ${ITER} calls per size, ${MATCHING} matching files`);
for (const n of [100, 1000, 10000]) benchAt(n);
