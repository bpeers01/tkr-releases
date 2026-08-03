// TEL-001 gate test: telemetry-history.jsonl stays bounded under
// sustained tool-call load — the writer rotates before append.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-telemetry-"));
  const prevState = process.env.TKR_STATE_DIR;
  const prevCap = process.env.TKR_TELEMETRY_MAX_BYTES;
  process.env.TKR_STATE_DIR = dir;
  process.env.TKR_TELEMETRY_MAX_BYTES = "65536";
  try {
    return fn(dir);
  } finally {
    if (prevState === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevState;
    if (prevCap === undefined) delete process.env.TKR_TELEMETRY_MAX_BYTES;
    else process.env.TKR_TELEMETRY_MAX_BYTES = prevCap;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test("TEL-001: 10K events stay bounded via rotation", () => {
  withTempState((dir) => {
    const { recordTelemetry } = require("./telemetry");
    for (let i = 0; i < 10_000; i++) {
      recordTelemetry("compression", 5000, 1000, `synthetic sustained load event ${i}`);
    }
    const main = path.join(dir, "telemetry-history.jsonl");
    const size = fs.statSync(main).size;
    // Rotation fires before each append: the live file can exceed the cap
    // by at most one line.
    assert.ok(size < 65536 + 512, `live file ${size} bytes — rotation not bounding`);
    assert.ok(fs.existsSync(main + ".1"), "expected rotated .1 generation");
    // Newest entry is intact valid JSONL.
    const lines = fs.readFileSync(main, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.stream, "compression");
    assert.strictEqual(last.bytes_saved, 4000);
  });
});

test("TEL-001: zero-savings events are not recorded", () => {
  withTempState((dir) => {
    const { recordTelemetry } = require("./telemetry");
    recordTelemetry("compression", 100, 100, "no savings");
    assert.ok(!fs.existsSync(path.join(dir, "telemetry-history.jsonl")));
  });
});

// Counterfactual clamp parity with internal/util/counterfactual.go — the
// JS writer must book the same capped savings the Go side would for the
// same before/after pair.
test("counterfactual clamp caps runaway before-bytes", () => {
  withTempState((dir) => {
    const { recordTelemetry, clampCounterfactual } = require("./telemetry");
    delete process.env.TKR_COUNTERFACTUAL_CAP_BYTES;

    assert.strictEqual(clampCounterfactual(100), 100);
    assert.strictEqual(clampCounterfactual(2_000_000), 30000);

    recordTelemetry("compression", 2_000_000, 1000, "runaway raw output");
    const main = path.join(dir, "telemetry-history.jsonl");
    const lines = fs.readFileSync(main, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.bytes_saved, 29000);
    assert.strictEqual(last.tokens_saved, Math.floor(29000 / 4));
  });
});

test("counterfactual clamp honors env override and 0-disables", () => {
  const prev = process.env.TKR_COUNTERFACTUAL_CAP_BYTES;
  const { clampCounterfactual } = require("./telemetry");
  try {
    process.env.TKR_COUNTERFACTUAL_CAP_BYTES = "5000";
    assert.strictEqual(clampCounterfactual(2_000_000), 5000);
    process.env.TKR_COUNTERFACTUAL_CAP_BYTES = "0";
    assert.strictEqual(clampCounterfactual(2_000_000), 2_000_000);
    process.env.TKR_COUNTERFACTUAL_CAP_BYTES = "junk";
    assert.strictEqual(clampCounterfactual(2_000_000), 30000);
  } finally {
    if (prev === undefined) delete process.env.TKR_COUNTERFACTUAL_CAP_BYTES;
    else process.env.TKR_COUNTERFACTUAL_CAP_BYTES = prev;
  }
});
