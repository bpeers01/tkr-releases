#!/usr/bin/env node
// Tests for the route-verdict channel policy (ADR-0010, 2026-07-27
// addendum): default mismatch mode is statusline-first — context
// injection only for sustained under-effort mismatches, once per
// session per verdict — with `always` preserving the legacy per-turn
// contract and `off` silencing injection entirely.
//
// Run: node hooks/user-prompt-submit.route-policy.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  routeInjectContext,
  shapeNudgeContext,
  routeInjectMode,
  routeNudgeStatePath,
  trackSustained,
  ROUTE_STREAK_MIN,
  effortStatePath,
} = require("./user-prompt-submit.js");

function writeCache(prompt, entry) {
  const sha1 = crypto.createHash("sha1").update(prompt).digest("hex");
  const fp = path.join(os.tmpdir(), "tkr-route-" + sha1 + ".json");
  fs.writeFileSync(fp, JSON.stringify({ written_at: new Date().toISOString(), ...entry }));
  return fp;
}

function writeEffortFile(sid, effort) {
  const fp = effortStatePath(sid);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ effort }));
  return fp;
}

function cleanup(...fps) {
  for (const fp of fps) {
    try { fs.rmSync(fp, { force: true }); } catch {}
  }
}

// Run fn with a controlled env: mode + ambient effort vars cleared
// first (so file-fallback behavior is deterministic), overrides
// applied, everything restored after.
//
// TKR_ROUTE_SYNC=0 is pinned because every test here seeds a verdict and
// asserts on the INJECTION CADENCE that follows it — classification is
// not under test. Without the pin, routeInjectContext runs a real
// `tkr route classify` first (it classifies once per prompt by design),
// which on any machine with tkr installed — i.e. anyone developing this
// repo — overwrites the seeded entry with a real verdict and fails the
// assertions for reasons that have nothing to do with cadence.
function withEnv(overrides, fn) {
  const keys = [
    "TKR_ROUTE_INJECT_MODE",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_EFFORT",
    "TKR_ROUTE_SYNC",
  ];
  const prev = {};
  for (const k of keys) { prev[k] = process.env[k]; delete process.env[k]; }
  process.env.TKR_ROUTE_SYNC = "0";
  for (const [k, v] of Object.entries(overrides || {})) process.env[k] = v;
  try { fn(); } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("routeInjectMode defaults to mismatch, honors always/off", () => {
  withEnv({}, () => assert.strictEqual(routeInjectMode(), "mismatch"));
  withEnv({ TKR_ROUTE_INJECT_MODE: "ALWAYS" }, () => assert.strictEqual(routeInjectMode(), "always"));
  withEnv({ TKR_ROUTE_INJECT_MODE: "off" }, () => assert.strictEqual(routeInjectMode(), "off"));
  withEnv({ TKR_ROUTE_INJECT_MODE: "bogus" }, () => assert.strictEqual(routeInjectMode(), "mismatch"));
});

test("mismatch: unknown active effort → statusline only (no injection)", () => {
  const sid = `rp-unknown-${process.pid}`;
  const prompt = `rp-unknown-prompt-${process.pid}`;
  const cfp = writeCache(prompt, { task_class: "bugfix", effort: "high", why: "x" });
  try {
    withEnv({}, () => {
      assert.strictEqual(routeInjectContext({ prompt, session_id: sid }), "");
    });
  } finally { cleanup(cfp, routeNudgeStatePath(sid)); }
});

test("mismatch: aligned verdict stays silent", () => {
  const sid = `rp-aligned-${process.pid}`;
  const prompt = `rp-aligned-prompt-${process.pid}`;
  const cfp = writeCache(prompt, { task_class: "bugfix", effort: "high", why: "x" });
  const efp = writeEffortFile(sid, "high");
  try {
    withEnv({}, () => {
      for (let i = 0; i < ROUTE_STREAK_MIN + 1; i++) {
        assert.strictEqual(routeInjectContext({ prompt, session_id: sid }), "");
      }
    });
  } finally { cleanup(cfp, efp, routeNudgeStatePath(sid)); }
});

test(`mismatch: under-effort injects once after ${ROUTE_STREAK_MIN} consecutive turns, then dedups`, () => {
  const sid = `rp-sustained-${process.pid}`;
  const prompt = `rp-sustained-prompt-${process.pid}`;
  const cfp = writeCache(prompt, { task_class: "bugfix", effort: "high", why: "auth" });
  const efp = writeEffortFile(sid, "low");
  try {
    withEnv({}, () => {
      const outs = [];
      for (let i = 0; i < ROUTE_STREAK_MIN + 1; i++) {
        outs.push(routeInjectContext({ prompt, session_id: sid }));
      }
      for (let i = 0; i < ROUTE_STREAK_MIN - 1; i++) {
        assert.strictEqual(outs[i], "", `turn ${i + 1} must stay silent`);
      }
      assert.match(outs[ROUTE_STREAK_MIN - 1], /sustained/, "streak turn must inject");
      assert.match(outs[ROUTE_STREAK_MIN - 1], /raise at a natural break/);
      assert.strictEqual(outs[ROUTE_STREAK_MIN], "", "post-injection turn must dedup");
    });
  } finally { cleanup(cfp, efp, routeNudgeStatePath(sid)); }
});

test("mismatch: interleaved aligned turn resets the streak", () => {
  const sid = `rp-reset-${process.pid}`;
  const promptA = `rp-reset-a-${process.pid}`;
  const promptB = `rp-reset-b-${process.pid}`;
  const cfpA = writeCache(promptA, { task_class: "bugfix", effort: "high" });
  // promptB's verdict (low) matches active=low → aligned → resets streak.
  const cfpB = writeCache(promptB, { task_class: "status", effort: "low" });
  const efp = writeEffortFile(sid, "low");
  try {
    withEnv({}, () => {
      assert.strictEqual(routeInjectContext({ prompt: promptA, session_id: sid }), "");
      assert.strictEqual(routeInjectContext({ prompt: promptA, session_id: sid }), "");
      assert.strictEqual(routeInjectContext({ prompt: promptB, session_id: sid }), "");
      assert.strictEqual(routeInjectContext({ prompt: promptA, session_id: sid }), "");
      assert.strictEqual(routeInjectContext({ prompt: promptA, session_id: sid }), "");
      assert.match(routeInjectContext({ prompt: promptA, session_id: sid }), /sustained/);
    });
  } finally { cleanup(cfpA, cfpB, efp, routeNudgeStatePath(sid)); }
});

test("off: never injects even on sustained mismatch", () => {
  const sid = `rp-off-${process.pid}`;
  const prompt = `rp-off-prompt-${process.pid}`;
  const cfp = writeCache(prompt, { task_class: "bugfix", effort: "high" });
  const efp = writeEffortFile(sid, "low");
  try {
    withEnv({ TKR_ROUTE_INJECT_MODE: "off" }, () => {
      for (let i = 0; i < ROUTE_STREAK_MIN + 1; i++) {
        assert.strictEqual(routeInjectContext({ prompt, session_id: sid }), "");
      }
    });
  } finally { cleanup(cfp, efp, routeNudgeStatePath(sid)); }
});

test("always: legacy per-turn line preserved", () => {
  const sid = `rp-always-${process.pid}`;
  const prompt = `rp-always-prompt-${process.pid}`;
  const cfp = writeCache(prompt, { task_class: "implement", effort: "medium", why: "bounded" });
  try {
    withEnv({ TKR_ROUTE_INJECT_MODE: "always" }, () => {
      const out = routeInjectContext({ prompt, session_id: sid });
      assert.strictEqual(out, "[tkr route: implement → effort=medium (bounded)]");
    });
  } finally { cleanup(cfp, routeNudgeStatePath(sid)); }
});

test("shape over-effort line is streak-gated in mismatch mode", () => {
  const sid = `rp-shape-${process.pid}`;
  const prompt = `rp-shape-prompt-${process.pid}`;
  const cfp = writeCache(prompt, {
    task_class: "localized_edit",
    effort: "low",
    shape: "narrow_reversible",
    recommend_effort: "low",
  });
  const efp = writeEffortFile(sid, "max");
  try {
    withEnv({}, () => {
      const outs = [];
      for (let i = 0; i < ROUTE_STREAK_MIN + 1; i++) {
        outs.push(shapeNudgeContext({ prompt, session_id: sid }));
      }
      for (let i = 0; i < ROUTE_STREAK_MIN - 1; i++) {
        assert.strictEqual(outs[i], "", `turn ${i + 1} must stay silent`);
      }
      assert.match(outs[ROUTE_STREAK_MIN - 1], /recommend=low active=max/);
      assert.strictEqual(outs[ROUTE_STREAK_MIN], "", "post-injection turn must dedup");
    });
  } finally { cleanup(cfp, efp, routeNudgeStatePath(sid)); }
});

test("trackSustained: null key resets streak, dedup persists per key", () => {
  const track = {};
  assert.strictEqual(trackSustained(track, "k"), false);
  assert.strictEqual(trackSustained(track, "k"), false);
  assert.strictEqual(trackSustained(track, "k"), true);
  assert.strictEqual(trackSustained(track, "k"), false); // deduped
  assert.strictEqual(trackSustained(track, ""), false);  // reset
  assert.strictEqual(trackSustained(track, "k"), false); // streak restarts at 1
  assert.strictEqual(trackSustained(track, "k"), false);
  assert.strictEqual(trackSustained(track, "k"), false); // hits 3 again but stays deduped
});
