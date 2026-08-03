// PLAN-1 T7 (Wave-0, v3.13.1) — cache-ttl-inference.js unit tests.
//
// Verifies the L6-emit decision matrix against detectTTL's source field:
//   "direct"   → emit L6 with shape { ttl_seconds, source, idle_gap_observed_secs }
//   "inferred" → emit L6, preserving idle_gap_observed_secs
//   "default"  → NO emit (absence-of-signal would be noise)
//   "config"   → NO emit (operator override, not inference)
//
// detectTTL is mocked via require-cache replacement so these tests stay
// independent of cache-ttl.js internals — that lib has its own suite at
// hooks/lib/cache-ttl.test.js (16 cases, unmodified by this task).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_TTL_PATH = require.resolve("../cache-ttl");
const PLAYBOOK_EMIT_PATH = require.resolve("../playbook-emit");
const INFERENCE_PATH = require.resolve("./cache-ttl-inference");

// withMockedDetect — install a fake cache-ttl module that returns the
// supplied tuple from detectTTL, then load the inference module fresh
// against an isolated TKR_STATE_DIR so the playbook ledger is per-test.
function withMockedDetect(fakeResult, fn) {
  const prevState = process.env.TKR_STATE_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ttl-inf-"));
  process.env.TKR_STATE_DIR = tmp;

  // Replace cache-ttl in require cache. Inference module re-requires
  // it on each invocation pattern, but we also blow away the inference
  // module + playbook-emit (the latter holds an in-memory rate guard).
  delete require.cache[CACHE_TTL_PATH];
  delete require.cache[PLAYBOOK_EMIT_PATH];
  delete require.cache[INFERENCE_PATH];

  require.cache[CACHE_TTL_PATH] = {
    id: CACHE_TTL_PATH,
    filename: CACHE_TTL_PATH,
    loaded: true,
    exports: { detectTTL: () => fakeResult },
  };

  try {
    const inference = require(INFERENCE_PATH);
    const emit = require(PLAYBOOK_EMIT_PATH);
    return fn({ inference, emit, tmp });
  } finally {
    delete require.cache[CACHE_TTL_PATH];
    delete require.cache[PLAYBOOK_EMIT_PATH];
    delete require.cache[INFERENCE_PATH];
    if (prevState === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevState;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

test("source 'direct' emits L6 with full trigger_state shape", () => {
  withMockedDetect(
    { ttl_seconds: 3600, source: "direct", idle_gap_observed_secs: 0 },
    ({ inference, emit }) => {
      const result = inference.performTTLInference("sid-direct");
      assert.deepStrictEqual(result, {
        ttl_seconds: 3600,
        source: "direct",
        idle_gap_observed_secs: 0,
      });
      const { events } = emit.readLedger();
      assert.strictEqual(events.length, 1, "direct must emit one L6 event");
      const evt = events[0];
      assert.strictEqual(evt.layer, "L6");
      assert.strictEqual(evt.event, "fired");
      assert.strictEqual(evt.session_id, "sid-direct");
      assert.strictEqual(evt.trigger_state.ttl_seconds, 3600);
      assert.strictEqual(evt.trigger_state.source, "direct");
      assert.strictEqual(evt.trigger_state.idle_gap_observed_secs, 0);
      assert.strictEqual(evt.outcome, null);
    },
  );
});

test("source 'inferred' emits L6 preserving idle_gap_observed_secs", () => {
  withMockedDetect(
    { ttl_seconds: 3600, source: "inferred", idle_gap_observed_secs: 720 },
    ({ inference, emit }) => {
      const result = inference.performTTLInference("sid-inf");
      assert.strictEqual(result.source, "inferred");
      const { events } = emit.readLedger();
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].layer, "L6");
      assert.strictEqual(events[0].trigger_state.source, "inferred");
      assert.strictEqual(events[0].trigger_state.idle_gap_observed_secs, 720);
      assert.strictEqual(events[0].trigger_state.ttl_seconds, 3600);
    },
  );
});

test("source 'default' does NOT emit L6 (no evidence)", () => {
  withMockedDetect(
    { ttl_seconds: 300, source: "default", idle_gap_observed_secs: 0 },
    ({ inference, emit }) => {
      const result = inference.performTTLInference("sid-default");
      assert.strictEqual(result.source, "default");
      const { events } = emit.readLedger();
      assert.strictEqual(events.length, 0, "default tuple must not emit");
    },
  );
});

test("source 'config' does NOT emit L6 (operator override, not inference)", () => {
  withMockedDetect(
    { ttl_seconds: 3600, source: "config", idle_gap_observed_secs: 0 },
    ({ inference, emit }) => {
      const result = inference.performTTLInference("sid-config");
      assert.strictEqual(result.source, "config");
      const { events } = emit.readLedger();
      assert.strictEqual(events.length, 0, "config override must not emit L6");
    },
  );
});

test("performTTLInference returns the detectTTL tuple unmodified", () => {
  const fake = { ttl_seconds: 1234, source: "default", idle_gap_observed_secs: 0 };
  withMockedDetect(fake, ({ inference }) => {
    const result = inference.performTTLInference("sid-pass");
    // Pass-through contract: caller can use the value without a second
    // detectTTL call (matters for sibling hooks reading the same tuple).
    assert.strictEqual(result.ttl_seconds, 1234);
    assert.strictEqual(result.source, "default");
  });
});
