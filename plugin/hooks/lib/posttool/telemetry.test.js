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
  const prevHostCap = process.env.BASH_MAX_OUTPUT_LENGTH;
  process.env.TKR_STATE_DIR = dir;
  process.env.TKR_TELEMETRY_MAX_BYTES = "65536";
  // Tests below assert against the hardcoded 30000 default unless they
  // set BASH_MAX_OUTPUT_LENGTH themselves — neutralize whatever the
  // ambient shell (e.g. a live Claude Code session) has configured.
  delete process.env.BASH_MAX_OUTPUT_LENGTH;
  try {
    return fn(dir);
  } finally {
    if (prevState === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevState;
    if (prevCap === undefined) delete process.env.TKR_TELEMETRY_MAX_BYTES;
    else process.env.TKR_TELEMETRY_MAX_BYTES = prevCap;
    if (prevHostCap === undefined) delete process.env.BASH_MAX_OUTPUT_LENGTH;
    else process.env.BASH_MAX_OUTPUT_LENGTH = prevHostCap;
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

// Host-cap gating parity with internal/telemetry.Tracker.Record — the JS
// writer must book the same (zero) saving the Go side would when raw
// output exceeds the host's real truncation cap. #337 P0-1: Claude
// Code's truncate-to-file-and-preview behavior fires off the RAW size
// alone, before a filtered replacement is ever considered, so above the
// cap the replacement is discarded outright — no real saving, however
// small the filtered output is. This inverts the pre-fix expectation,
// which asserted a positive `cap - bytesAfter` saving for an event that
// never happened.
test("counterfactual clamp gates savings when raw exceeds host cap", () => {
  withTempState((dir) => {
    const { recordTelemetry, clampCounterfactual } = require("./telemetry");
    delete process.env.TKR_COUNTERFACTUAL_CAP_BYTES;

    assert.strictEqual(clampCounterfactual(100), 100);
    assert.strictEqual(clampCounterfactual(2_000_000), 30000);

    // The event is still written (forced past the saved===0 early
    // return) so the host-cap case stays visible rather than silently
    // vanishing like a genuine no-op does.
    recordTelemetry("compression", 2_000_000, 1000, "runaway raw output");
    const main = path.join(dir, "telemetry-history.jsonl");
    const lines = fs.readFileSync(main, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.bytes_saved, 0);
    assert.strictEqual(last.tokens_saved, 0);
    assert.strictEqual(last.reason, "host_cap_exceeded");
  });
});

// The host cap tracks BASH_MAX_OUTPUT_LENGTH — Claude Code's own env var
// for its configured truncation threshold — rather than a hardcoded
// 30000, so a before/after pair that fits under a wider configured cap
// books its real saving instead of being wrongly gated to zero.
test("host cap honors BASH_MAX_OUTPUT_LENGTH over the hardcoded default", () => {
  withTempState((dir) => {
    const { recordTelemetry, hostOutputCapBytes } = require("./telemetry");
    delete process.env.TKR_COUNTERFACTUAL_CAP_BYTES;
    process.env.BASH_MAX_OUTPUT_LENGTH = "50000";

    assert.strictEqual(hostOutputCapBytes(), 50000);

    recordTelemetry("compression", 40000, 1000, "under widened cap");
    const main = path.join(dir, "telemetry-history.jsonl");
    const lines = fs.readFileSync(main, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.bytes_saved, 39000);
    assert.strictEqual(last.reason, undefined);
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
