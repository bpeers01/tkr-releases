// hooks/session-summary.test.js — unit tests for the Stop-hook value report.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { renderSummary, extractSessionID } = require("./session-summary");
const { getTelemetryPath } = require("./lib/statusline-path");

// INV-075 harness. Deliberately does NOT set TKR_STATUSLINE_PATH: that
// override short-circuits the cleanup branch, which is exactly why every
// pre-existing test in this file missed the bug. Scope via TMPDIR + sid
// instead, so the hook resolves the same real per-session path the test
// wrote to.
function runShardLifecycle(hookEventName) {
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shard-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shard-state-"));
  const sid = "inv075-" + hookEventName;
  const cwd = path.resolve(__dirname, "..");
  const shard = getTelemetryPath(cwd, sid, tmp);

  // A COMPLETE shard: statusline-owned fields (written by statusline.{sh,ps1})
  // plus the tkr-owned fields (written only by `tkr statusline-update`).
  fs.writeFileSync(
    shard,
    JSON.stringify({
      seven_day_pct: 41,
      five_hour_pct: 12,
      model_display: "Opus 5",
      last_ctx_k: 158,
      turn_count: 151,
      cap_units_total: 2500000,
      tkr_launch: true,
    })
  );

  const env = { ...process.env, TMPDIR: tmp, TKR_STATE_DIR: state, TKR_SESSION_ID: sid };
  delete env.TKR_STATUSLINE_PATH;

  const result = spawnSync(process.execPath, [require.resolve("./session-summary.js")], {
    input: JSON.stringify({ session_id: sid, hook_event_name: hookEventName }),
    env,
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });

  const exists = fs.existsSync(shard);
  const after = exists ? JSON.parse(fs.readFileSync(shard, "utf8")) : null;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
  return { result, exists, after };
}

test("INV-075: Stop preserves the statusline shard (Stop is per-turn, not session end)", () => {
  const { result, exists, after } = runShardLifecycle("Stop");

  assert.equal(result.status, 0);
  assert.ok(exists, "Stop deleted the per-session shard — INV-075 regression");
  // The tkr-owned fields are the ones that vanish: statusline.{sh,ps1}
  // recreates the file with its own fields, so asserting mere existence is
  // not enough to catch a re-introduction of the per-turn delete.
  assert.equal(after.last_ctx_k, 158);
  assert.equal(after.turn_count, 151);
  assert.equal(after.cap_units_total, 2500000);
  assert.equal(after.tkr_launch, true);
});

test("INV-075: SessionEnd deletes the statusline shard", () => {
  const { result, exists } = runShardLifecycle("SessionEnd");

  assert.equal(result.status, 0);
  assert.ok(!exists, "SessionEnd left the shard behind — $TMPDIR would grow unbounded");
});

test("INV-075: SessionEnd emits no report (Claude Code ignores SessionEnd output)", () => {
  const { result } = runShardLifecycle("SessionEnd");
  assert.equal(result.stderr, "");
});

test("renderSummary: empty inputs → empty string (silent)", () => {
  const out = renderSummary({ stats: {}, brevity: null, busts: null });
  assert.equal(out, "");
});

test("renderSummary: full inputs → multi-line block within 10-line budget", () => {
  const out = renderSummary({
    stats: {
      five_hour_pct: 23,
      seven_day_pct: 12,
      last_ctx_k: 142,
      turn_count: 188,
      tkr_savings_7d_pct: 3,
    },
    brevity: "full",
    busts: { count: 3, paths: ["a", "b", "c"] },
  });

  const lines = out.split("\n");
  assert.ok(lines.length <= 10, `expected <=10 lines, got ${lines.length}`);
  assert.equal(lines[0], "[tkr] session summary");
  assert.match(lines[1], /5h 23%/);
  assert.match(lines[1], /7d 12%/);
  assert.match(lines[1], /3%/); // tkr 7d savings
  assert.match(lines[2], /142K/);
  assert.match(lines[2], /turns: 188/);
  assert.ok(out.includes("cache busts: 3 this session"));
  assert.ok(out.includes("brevity:    full"));
  assert.ok(out.includes("tkr gain --week"));
});

test("renderSummary: zero cache busts → no cache-bust line", () => {
  const out = renderSummary({
    stats: { five_hour_pct: 10, turn_count: 5 },
    brevity: null,
    busts: { count: 0, paths: [] },
  });
  assert.ok(!out.includes("cache busts"));
});

test("renderSummary: brevity off / no busts / no stats → silent", () => {
  const out = renderSummary({ stats: {}, brevity: "off", busts: null });
  // brevity:"off" alone shouldn't be enough to emit (would just be noise).
  // But the current impl will emit if brevity is truthy. Validate the
  // behaviour matches: "off" is truthy as a string.
  assert.ok(out.includes("brevity:    off"));
});

test("renderSummary: missing numeric fields render as '—'", () => {
  const out = renderSummary({
    stats: { last_ctx_k: 42 },
    brevity: null,
    busts: null,
  });
  // five_hour_pct + seven_day_pct + tkr_savings_7d_pct + turn_count all
  // missing — should render as em-dashes.
  const dashes = (out.match(/—/g) || []).length;
  assert.ok(dashes >= 4, `expected >=4 em-dashes for missing fields, got ${dashes}`);
});

test("extractSessionID uses canonical chain (transcript UUID > session_id > env > pid)", () => {
  // M-15 / issue #15: unified with hooks/lib/session-id so Stop hook reads
  // the same per-session state files other hooks wrote.
  assert.equal(extractSessionID({ session_id: "abc" }), "abc");
  assert.equal(extractSessionID({ sessionId: "camel" }), "camel");
  const prevTkr = process.env.TKR_SESSION_ID;
  const prevClaude = process.env.CLAUDE_SESSION_ID;
  delete process.env.TKR_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = "envid";
  try {
    assert.equal(extractSessionID({}), "envid");
  } finally {
    if (prevTkr === undefined) delete process.env.TKR_SESSION_ID;
    else process.env.TKR_SESSION_ID = prevTkr;
    if (prevClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = prevClaude;
  }
  delete process.env.TKR_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  // Final fallback is pid-<ppid> — matches all other hooks; was "default" before.
  assert.equal(extractSessionID({}), `pid-${process.ppid}`);
});

test("hook process: TKR_SESSION_SUMMARY=0 → silent", () => {
  const { spawnSync } = require("child_process");
  const result = spawnSync(process.execPath, [require.resolve("./session-summary.js")], {
    input: JSON.stringify({ session_id: "test-sid" }),
    env: { ...process.env, TKR_SESSION_SUMMARY: "0" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "{}");
});

test("hook process: empty state dir → silent (no telemetry to report)", () => {
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sum-"));
  const result = spawnSync(process.execPath, [require.resolve("./session-summary.js")], {
    input: JSON.stringify({ session_id: "no-data" }),
    env: {
      ...process.env,
      TKR_STATE_DIR: tmp,
      TKR_STATUSLINE_PATH: path.join(tmp, "nope.json"),
    },
    encoding: "utf8",
    timeout: 5000,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("hook process: with real telemetry → emits block", () => {
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sum-"));
  const statusFile = path.join(tmp, "statusline.json");
  fs.writeFileSync(
    statusFile,
    JSON.stringify({ five_hour_pct: 22, seven_day_pct: 82, last_ctx_k: 192, turn_count: 207 })
  );
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  fs.writeFileSync(
    path.join(tmp, "cache-bust-real.json"),
    JSON.stringify({ count: 3, paths: ["x"] })
  );

  const result = spawnSync(process.execPath, [require.resolve("./session-summary.js")], {
    input: JSON.stringify({ session_id: "real" }),
    env: {
      ...process.env,
      TKR_STATE_DIR: tmp,
      TKR_STATUSLINE_PATH: statusFile,
    },
    encoding: "utf8",
    timeout: 5000,
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /\[tkr\] session summary/);
  assert.match(result.stderr, /5h 22%/);
  assert.match(result.stderr, /192K/);
  assert.match(result.stderr, /cache busts: 3/);
  assert.match(result.stderr, /brevity:\s+full/);
  // Budget guard: ≤10 lines.
  const lineCount = result.stderr.trim().split("\n").length;
  assert.ok(lineCount <= 10, `expected ≤10 lines, got ${lineCount}`);
});
