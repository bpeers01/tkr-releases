#!/usr/bin/env node
// Tests for hooks/pre-compact.js — compaction nudge logic.
// PLAN-1 T6: TTL-aware TURNS_WARN doubling.
//
// Run: node --test hooks/pre-compact.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "pre-compact.js");

// ---- helpers ----

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-compact-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// newStateDir re-requires the module with a fresh TKR_STATE_DIR so
// bypass-flag state doesn't bleed between tests.
function freshModule(stateDir) {
  process.env.TKR_STATE_DIR = stateDir;
  delete require.cache[require.resolve("./pre-compact.js")];
  // Also clear cache-ttl since it references stateDir via stateDir()
  delete require.cache[require.resolve("./lib/cache-ttl.js")];
  return require("./pre-compact.js");
}

// Write a statusline JSON into a temp file; return the path.
function mkTelemetryFile(payload, dir) {
  const fp = path.join(dir, "claude-statusline.json");
  fs.writeFileSync(fp, JSON.stringify(payload));
  return fp;
}

// Run hook via spawnSync with controlled env. Returns parsed JSON output.
function runHook(payload, opts = {}) {
  const { env = {} } = opts;
  return withTempDir((stateDir) => {
    let statuslinePath = null;
    if (opts.telemetry) {
      statuslinePath = path.join(stateDir, "statusline.json");
      fs.writeFileSync(statuslinePath, JSON.stringify(opts.telemetry));
    }
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload || {}),
      env: {
        ...process.env,
        TKR_STATE_DIR: stateDir,
        ...(statuslinePath ? { TKR_STATUSLINE_PATH: statuslinePath } : {}),
        ...env,
      },
      encoding: "utf8",
    });
    return { res, stateDir };
  });
}

// ---- exported constants ----

test("TURNS_WARN is 50, TURNS_HARD is 80, CAP_WARN_PCT is 70", () => {
  withTempDir((dir) => {
    const m = freshModule(dir);
    assert.strictEqual(m.TURNS_WARN, 50);
    assert.strictEqual(m.TURNS_HARD, 80);
    assert.strictEqual(m.CAP_WARN_PCT, 70);
  });
});

// ---- compactionNudge unit tests ----
// These drive compactionNudge() directly, controlling telemetry via
// TKR_STATUSLINE_PATH env so the module-level TELEMETRY_PATH picks up the
// test file. We re-require the module after setting env.

test("no nudge below turn and cap thresholds (default TTL)", () => {
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 30, seven_day_pct: 50 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    const m = freshModule(dir);
    assert.strictEqual(m.compactionNudge("sid-low"), null);
    delete process.env.TKR_STATUSLINE_PATH;
  });
});

test("nudge fires when turn_count >= TURNS_WARN (default TTL=300)", () => {
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 50, seven_day_pct: 10 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    process.env.TKR_CACHE_TTL_SECONDS = "300";
    const m = freshModule(dir);
    const result = m.compactionNudge("sid-long");
    assert.ok(result, "should nudge at turn 50 with 5min TTL");
    assert.ok(result.includes("long") || result.includes("50"), "should mention session length");
    delete process.env.TKR_STATUSLINE_PATH;
    delete process.env.TKR_CACHE_TTL_SECONDS;
  });
});

test("nudge fires when seven_day_pct >= CAP_WARN_PCT", () => {
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 10, seven_day_pct: 75 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    const m = freshModule(dir);
    const result = m.compactionNudge("sid-cap");
    assert.ok(result, "should nudge on cap pressure");
    assert.ok(result.includes("75%") || result.includes("cap"), "should mention cap");
    delete process.env.TKR_STATUSLINE_PATH;
  });
});

test("second /compact bypasses nudge (bypass flag mechanism)", () => {
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 60, seven_day_pct: 10 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    process.env.TKR_CACHE_TTL_SECONDS = "300";
    const m = freshModule(dir);
    const sid = "sid-bypass";
    const first = m.compactionNudge(sid);
    assert.ok(first, "first attempt should nudge");
    const second = m.compactionNudge(sid);
    assert.strictEqual(second, null, "second attempt (bypass) should proceed");
    delete process.env.TKR_STATUSLINE_PATH;
    delete process.env.TKR_CACHE_TTL_SECONDS;
  });
});

// ---- PLAN-1 T6: TTL-aware TURNS_WARN doubling ----

test("TTL=1h direct: turn_count=60 → no nudge (60 < 100 doubled threshold)", () => {
  // With 1h cache: TURNS_WARN doubles from 50 → 100. Turn 60 is below.
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 60, seven_day_pct: 10 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    process.env.TKR_CACHE_TTL_SECONDS = "3600"; // config source → ttlActive1h = true
    const m = freshModule(dir);
    const result = m.compactionNudge("sid-1h-60");
    assert.strictEqual(result, null, "turn 60 should NOT nudge when 1h cache raises gate to 100");
    delete process.env.TKR_STATUSLINE_PATH;
    delete process.env.TKR_CACHE_TTL_SECONDS;
  });
});

test("TTL=1h direct: turn_count=100 → nudge fires (equals doubled threshold)", () => {
  // Doubled gate: 100 >= 100 → longSession = true → nudge.
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 100, seven_day_pct: 10 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    process.env.TKR_CACHE_TTL_SECONDS = "3600";
    const m = freshModule(dir);
    const result = m.compactionNudge("sid-1h-100");
    assert.ok(result, "turn 100 should nudge at doubled threshold");
    delete process.env.TKR_STATUSLINE_PATH;
    delete process.env.TKR_CACHE_TTL_SECONDS;
  });
});

test("TTL=1h: cap pressure (seven_day_pct >= 70) still fires regardless of turn threshold", () => {
  // underPressure path is unrelated to TTL — cap pressure always nudges.
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 10, seven_day_pct: 80 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    process.env.TKR_CACHE_TTL_SECONDS = "3600";
    const m = freshModule(dir);
    const result = m.compactionNudge("sid-1h-cap");
    assert.ok(result, "cap pressure nudge must fire even with 1h TTL");
    delete process.env.TKR_STATUSLINE_PATH;
    delete process.env.TKR_CACHE_TTL_SECONDS;
  });
});

test("TTL detection disabled: preserves original 50-turn threshold", () => {
  // source="default" with ttl_seconds=300 → ttlActive1h = false → TURNS_WARN=50.
  withTempDir((dir) => {
    const telPath = mkTelemetryFile({ turn_count: 50, seven_day_pct: 10 }, dir);
    process.env.TKR_STATUSLINE_PATH = telPath;
    process.env.TKR_TTL_DETECTION_DISABLED = "1";
    const m = freshModule(dir);
    const result = m.compactionNudge("sid-dis-50");
    assert.ok(result, "TTL detection disabled → legacy 50-turn gate → nudge at turn 50");
    delete process.env.TKR_STATUSLINE_PATH;
    delete process.env.TKR_TTL_DETECTION_DISABLED;
  });
});

// ---- end-to-end via spawnSync ----

test("hook outputs {} when no nudge needed", () => {
  const { res } = runHook(
    { session_id: "sid-e2e-low" },
    { telemetry: { turn_count: 10, seven_day_pct: 10 } },
  );
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.ok(!out.decision, "should not block when thresholds not met");
});

test("hook outputs block decision when turn_count >= 50 (default TTL)", () => {
  const { res } = runHook(
    { session_id: "sid-e2e-block" },
    {
      telemetry: { turn_count: 55, seven_day_pct: 10 },
      env: { TKR_CACHE_TTL_SECONDS: "300" },
    },
  );
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.decision, "block");
  assert.ok(out.reason && out.reason.includes("compact"), "reason should mention compact");
});

test("hook: TTL=1h suppresses nudge at turn_count=55 (below doubled 100-turn gate)", () => {
  const { res } = runHook(
    { session_id: "sid-e2e-1h" },
    {
      telemetry: { turn_count: 55, seven_day_pct: 10 },
      env: { TKR_CACHE_TTL_SECONDS: "3600" },
    },
  );
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.ok(!out.decision, "TTL=1h should suppress nudge at turn 55");
});
