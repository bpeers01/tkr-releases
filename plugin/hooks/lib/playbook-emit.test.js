// Wave 1 — playbook-emit.js round-trip + edge cases.
// Run with: node --test hooks/lib/playbook-emit.test.js

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-playbook-test-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function freshRequire() {
  delete require.cache[require.resolve("./playbook-emit")];
  return require("./playbook-emit");
}

test("emit then read round-trip", () => {
  withTempStateDir(() => {
    const { emitEvent, readLedger, SCHEMA_VERSION } = freshRequire();
    emitEvent(
      "L0",
      "fired",
      { pinned_actual_tok: 18420, pinned_budget_tok: 12000, biggest_offender: "global CLAUDE.md" },
      null,
      "sid-test",
    );
    const { events, unknownSkipped } = readLedger();
    assert.strictEqual(events.length, 1, "one event written");
    assert.strictEqual(unknownSkipped, 0);
    const evt = events[0];
    assert.strictEqual(evt.layer, "L0");
    assert.strictEqual(evt.event, "fired");
    assert.strictEqual(evt.session_id, "sid-test");
    assert.strictEqual(evt.schema_version, SCHEMA_VERSION);
    assert.ok(evt.at, "at field present");
    assert.strictEqual(evt.trigger_state.pinned_actual_tok, 18420);
    assert.strictEqual(evt.outcome, null);
  });
});

test("invalid layer or event silently dropped", () => {
  withTempStateDir(() => {
    const { emitEvent, readLedger } = freshRequire();
    emitEvent("L99", "fired", {}, null);
    emitEvent("L0", "garbage", {}, null);
    const { events } = readLedger();
    assert.strictEqual(events.length, 0);
  });
});

test("global kill switch suppresses emit", () => {
  withTempStateDir(() => {
    const prev = process.env.TKR_PLAYBOOK_DISABLED;
    process.env.TKR_PLAYBOOK_DISABLED = "1";
    try {
      const { emitEvent, readLedger } = freshRequire();
      emitEvent("L1", "fired", { idle_secs: 400 }, null);
      const { events } = readLedger();
      assert.strictEqual(events.length, 0);
    } finally {
      if (prev === undefined) delete process.env.TKR_PLAYBOOK_DISABLED;
      else process.env.TKR_PLAYBOOK_DISABLED = prev;
    }
  });
});

test("creates missing nested state dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-pb-mkdir-"));
  const nested = path.join(tmp, "a", "b", "c");
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = nested;
  try {
    const { emitEvent, readLedger } = freshRequire();
    emitEvent("L2", "fired", { classification: "high" }, null);
    const { events } = readLedger();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].layer, "L2");
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
});

test("session id falls back to TKR_SESSION_ID then default", () => {
  withTempStateDir(() => {
    const prev = process.env.TKR_SESSION_ID;
    process.env.TKR_SESSION_ID = "from-env";
    try {
      const { emitEvent, readLedger } = freshRequire();
      emitEvent("L3", "fired", { last_ctx_k: 268 }, null);
      const { events } = readLedger();
      assert.strictEqual(events[0].session_id, "from-env");
    } finally {
      if (prev === undefined) delete process.env.TKR_SESSION_ID;
      else process.env.TKR_SESSION_ID = prev;
    }
  });
});

test("unknown future schema_version skipped on read", () => {
  withTempStateDir((dir) => {
    const { ledgerPath, readLedger, SCHEMA_VERSION } = freshRequire();
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const good = JSON.stringify({
      at: "2026-05-10T00:00:00Z",
      session_id: "s",
      layer: "L0",
      event: "fired",
      trigger_state: {},
      outcome: null,
      schema_version: SCHEMA_VERSION,
    });
    const future = JSON.stringify({
      at: "2026-05-10T00:00:01Z",
      session_id: "s",
      layer: "L0",
      event: "fired",
      trigger_state: {},
      outcome: null,
      schema_version: SCHEMA_VERSION + 99,
    });
    fs.writeFileSync(file, good + "\n" + future + "\n");
    const { events, unknownSkipped } = readLedger();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(unknownSkipped, 1);
  });
});

test("L6 layer (PLAN-1 cache-TTL inference) accepted", () => {
  withTempStateDir(() => {
    const { emitEvent, readLedger } = freshRequire();
    emitEvent(
      "L6",
      "fired",
      { ttl_seconds: 3600, source: "direct", idle_gap_observed_secs: 0 },
      null,
      "sid-l6",
    );
    const { events } = readLedger();
    assert.strictEqual(events.length, 1, "L6 must be a valid layer");
    assert.strictEqual(events[0].layer, "L6");
    assert.strictEqual(events[0].trigger_state.ttl_seconds, 3600);
    assert.strictEqual(events[0].trigger_state.source, "direct");
  });
});

test("L7 layer (session-shape advisor) accepted", () => {
  withTempStateDir(() => {
    const { emitEvent, readLedger } = freshRequire();
    emitEvent(
      "L7",
      "fired",
      { trigger: "tool_bytes", tool_result_bytes: 204800, last_ctx_k: 120 },
      null,
      "sid-l7",
    );
    const { events } = readLedger();
    assert.strictEqual(events.length, 1, "L7 must be a valid layer");
    assert.strictEqual(events[0].layer, "L7");
    assert.strictEqual(events[0].trigger_state.trigger, "tool_bytes");
    assert.strictEqual(events[0].trigger_state.tool_result_bytes, 204800);
  });
});

test("malformed jsonl line skipped, valid lines preserved", () => {
  withTempStateDir(() => {
    const { ledgerPath, emitEvent, readLedger } = freshRequire();
    emitEvent("L0", "fired", { x: 1 }, null);
    fs.appendFileSync(ledgerPath(), "{not valid json\n");
    emitEvent("L1", "fired", { y: 2 }, null);
    const { events } = readLedger();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].layer, "L0");
    assert.strictEqual(events[1].layer, "L1");
  });
});
