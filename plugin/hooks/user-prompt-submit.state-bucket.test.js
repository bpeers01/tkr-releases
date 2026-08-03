#!/usr/bin/env node
// Tests for state-line delta-only emission: after a field locks, the
// [tkr: …] line re-enters context only on a bucket crossing (25-turn /
// 50K-ctx / 10-point cap bands) or during the transient age window.
// TKR_STATE_LINE_MODE=every-turn restores the legacy cadence.
//
// Run: node hooks/user-prompt-submit.state-bucket.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const {
  stateLineContext,
  stateLineFilePath,
} = require("./user-prompt-submit.js");

function cleanup(sid) {
  try { fs.rmSync(stateLineFilePath(sid), { force: true }); } catch {}
}

function withMode(mode, fn) {
  const prev = process.env.TKR_STATE_LINE_MODE;
  if (mode === undefined) delete process.env.TKR_STATE_LINE_MODE;
  else process.env.TKR_STATE_LINE_MODE = mode;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.TKR_STATE_LINE_MODE;
    else process.env.TKR_STATE_LINE_MODE = prev;
  }
}

const tel = (over) => ({ last_ctx_k: 0, turn_count: 0, idle_secs: 0, five_hour_pct: -1, seven_day_pct: -1, ...over });

test("bucket mode: first lock emits, unchanged bucket stays silent", () => {
  const sid = `sb-first-${process.pid}`;
  try {
    withMode(undefined, () => {
      const first = stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 85 }));
      assert.strictEqual(first, "[tkr: ctx=85K]");
      const second = stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 92 }));
      assert.strictEqual(second, "", "same 50K band (85→92) must not re-emit");
    });
  } finally { cleanup(sid); }
});

test("bucket mode: ctx band crossing re-emits with fresh values", () => {
  const sid = `sb-ctx-${process.pid}`;
  try {
    withMode(undefined, () => {
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 80 })), "[tkr: ctx=80K]");
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 130 })), "[tkr: ctx=130K]");
    });
  } finally { cleanup(sid); }
});

test("bucket mode: turn crossings respect 25-turn bands", () => {
  const sid = `sb-turn-${process.pid}`;
  try {
    withMode(undefined, () => {
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ turn_count: 55 })), "[tkr: t=55]");
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ turn_count: 60 })), "", "55→60 stays in band");
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ turn_count: 75 })), "[tkr: t=75]");
    });
  } finally { cleanup(sid); }
});

test("bucket mode: age window forces emission without bucket change", () => {
  const sid = `sb-age-${process.pid}`;
  try {
    withMode(undefined, () => {
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 85 })), "[tkr: ctx=85K]");
      const out = stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 85, idle_secs: 210 }));
      assert.strictEqual(out, "[tkr: ctx=85K age~210s]");
    });
  } finally { cleanup(sid); }
});

test("every-turn mode: legacy cadence emits on both turns", () => {
  const sid = `sb-legacy-${process.pid}`;
  try {
    withMode("every-turn", () => {
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 85 })), "[tkr: ctx=85K]");
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ last_ctx_k: 92 })), "[tkr: ctx=92K]");
    });
  } finally { cleanup(sid); }
});

test("bucket mode: 7d ten-point band change re-emits", () => {
  const sid = `sb-7d-${process.pid}`;
  try {
    withMode(undefined, () => {
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ seven_day_pct: 52 })), "[tkr: 7d=52%]");
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ seven_day_pct: 57 })), "", "52→57 stays in band");
      assert.strictEqual(stateLineContext(sid, undefined, undefined, tel({ seven_day_pct: 61 })), "[tkr: 7d=61%]");
    });
  } finally { cleanup(sid); }
});
