#!/usr/bin/env node
// Tests for hooks/push-clear-nudge.js — git push detection, gates,
// per-session debounce.
//
// Run: node hooks/push-clear-nudge.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Each test gets its own state dir so debounce flags don't bleed.
function newStateDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tkr-push-${label}-`));
  process.env.TKR_STATE_DIR = dir;
  // Force a fresh require so the module captures the new TKR_STATE_DIR.
  delete require.cache[require.resolve("./push-clear-nudge.js")];
  return require("./push-clear-nudge.js");
}

function mkTelemetryFile(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-push-tel-"));
  const fp = path.join(dir, "claude-statusline.json");
  fs.writeFileSync(fp, JSON.stringify(payload));
  return fp;
}

test("constants are sane", () => {
  const m = newStateDir("constants");
  assert.strictEqual(m.PUSH_NUDGE_TURN_GATE, 50);
  assert.strictEqual(m.PUSH_NUDGE_CTX_K_GATE, 150);
});

test("isGitPush matches plain `git push`", () => {
  const { isGitPush } = newStateDir("plain");
  assert.ok(isGitPush("git push"));
  assert.ok(isGitPush("git push origin main"));
  assert.ok(isGitPush("git push --force"));
  assert.ok(isGitPush("git push -u origin feature"));
});

test("isGitPush matches piped/chained commands", () => {
  const { isGitPush } = newStateDir("chained");
  assert.ok(isGitPush("git add . && git push"));
  assert.ok(isGitPush("git commit -m 'x'; git push"));
  assert.ok(isGitPush("yes | git push --force-with-lease"));
});

test("isGitPush rejects non-push git commands", () => {
  const { isGitPush } = newStateDir("non-push");
  assert.ok(!isGitPush("git pull"));
  assert.ok(!isGitPush("git status"));
  assert.ok(!isGitPush("git push --help"));
  assert.ok(!isGitPush("git push-ref"));
  assert.ok(!isGitPush("git pushup"));
});

test("isGitPush rejects unrelated commands", () => {
  const { isGitPush } = newStateDir("unrelated");
  assert.ok(!isGitPush("npm publish"));
  assert.ok(!isGitPush("docker push"));
  assert.ok(!isGitPush(""));
  assert.ok(!isGitPush(null));
  assert.ok(!isGitPush(undefined));
});

test("checkPushBoundary returns null on non-Bash tool", () => {
  const { checkPushBoundary } = newStateDir("non-bash");
  const tel = mkTelemetryFile({ turn_count: 100, last_ctx_k: 200 });
  const event = { tool_name: "Edit", tool_input: { command: "git push" } };
  assert.strictEqual(checkPushBoundary(event, "sid-1", tel), null);
});

test("checkPushBoundary returns null when command is not git push", () => {
  const { checkPushBoundary } = newStateDir("not-push");
  const tel = mkTelemetryFile({ turn_count: 100, last_ctx_k: 200 });
  const event = { tool_name: "Bash", tool_input: { command: "git status" } };
  assert.strictEqual(checkPushBoundary(event, "sid-2", tel), null);
});

test("checkPushBoundary returns null below turn gate", () => {
  const { checkPushBoundary, PUSH_NUDGE_TURN_GATE } = newStateDir("turn-gate");
  const tel = mkTelemetryFile({
    turn_count: PUSH_NUDGE_TURN_GATE - 1,
    last_ctx_k: 200,
  });
  const event = { tool_name: "Bash", tool_input: { command: "git push" } };
  assert.strictEqual(checkPushBoundary(event, "sid-3", tel), null);
});

test("checkPushBoundary returns null below ctx gate", () => {
  const { checkPushBoundary, PUSH_NUDGE_CTX_K_GATE } = newStateDir("ctx-gate");
  const tel = mkTelemetryFile({
    turn_count: 100,
    last_ctx_k: PUSH_NUDGE_CTX_K_GATE - 1,
  });
  const event = { tool_name: "Bash", tool_input: { command: "git push" } };
  assert.strictEqual(checkPushBoundary(event, "sid-4", tel), null);
});

test("checkPushBoundary fires when both gates met", () => {
  const { checkPushBoundary } = newStateDir("fires");
  const tel = mkTelemetryFile({ turn_count: 75, last_ctx_k: 180 });
  const event = { tool_name: "Bash", tool_input: { command: "git push origin main" } };
  const out = checkPushBoundary(event, "sid-5", tel);
  assert.ok(out);
  assert.ok(out.includes("push-boundary"));
  assert.ok(out.includes("75-turn"));
  assert.ok(out.includes("180K"));
  assert.ok(out.includes("/clear"));
});

test("checkPushBoundary debounces second push in same session", () => {
  const { checkPushBoundary } = newStateDir("debounce");
  const tel = mkTelemetryFile({ turn_count: 100, last_ctx_k: 200 });
  const event = { tool_name: "Bash", tool_input: { command: "git push" } };
  const first = checkPushBoundary(event, "sid-debounce", tel);
  assert.ok(first, "first push should fire");
  const second = checkPushBoundary(event, "sid-debounce", tel);
  assert.strictEqual(second, null, "second push same sid should be silent");
});

test("checkPushBoundary fires across different sessions independently", () => {
  const { checkPushBoundary } = newStateDir("multi-sid");
  const tel = mkTelemetryFile({ turn_count: 100, last_ctx_k: 200 });
  const event = { tool_name: "Bash", tool_input: { command: "git push" } };
  const a = checkPushBoundary(event, "sid-A", tel);
  const b = checkPushBoundary(event, "sid-B", tel);
  assert.ok(a);
  assert.ok(b);
});

test("checkPushBoundary tolerates missing telemetry gracefully", () => {
  const { checkPushBoundary } = newStateDir("missing-tel");
  const event = { tool_name: "Bash", tool_input: { command: "git push" } };
  // No telemetry file → tel = {} → turns = 0, ctx = 0 → gates fail → null.
  const out = checkPushBoundary(event, "sid-no-tel", "/nonexistent/path.json");
  assert.strictEqual(out, null);
});

// ---- PLAN-1 T5: TTL-aware suppression ----

test("TTL=1h direct → returns null even when turn+ctx gates met", () => {
  // TKR_CACHE_TTL_SECONDS=3600 forces "config" source (not "default") at 3600s.
  // /clear would force a rebuild on a warm 1h cache — suppress the nudge.
  const savedTTL = process.env.TKR_CACHE_TTL_SECONDS;
  process.env.TKR_CACHE_TTL_SECONDS = "3600";
  try {
    const { checkPushBoundary } = newStateDir("ttl-1h-suppress");
    const tel = mkTelemetryFile({ turn_count: 100, last_ctx_k: 200 });
    const event = { tool_name: "Bash", tool_input: { command: "git push" } };
    const out = checkPushBoundary(event, "sid-ttl-1h", tel);
    assert.strictEqual(out, null, "1h cache active → nudge must be suppressed");
  } finally {
    if (savedTTL === undefined) {
      delete process.env.TKR_CACHE_TTL_SECONDS;
    } else {
      process.env.TKR_CACHE_TTL_SECONDS = savedTTL;
    }
  }
});

test("TTL=300 config → nudge fires normally (5min cache, cache may be cold)", () => {
  // Explicit 300s config is a known-5m session: preserve nudge behavior.
  const savedTTL = process.env.TKR_CACHE_TTL_SECONDS;
  process.env.TKR_CACHE_TTL_SECONDS = "300";
  try {
    const { checkPushBoundary } = newStateDir("ttl-5m-allow");
    const tel = mkTelemetryFile({ turn_count: 100, last_ctx_k: 200 });
    const event = { tool_name: "Bash", tool_input: { command: "git push" } };
    const out = checkPushBoundary(event, "sid-ttl-5m", tel);
    assert.ok(out, "5min cache active → nudge should still fire");
    assert.ok(out.includes("/clear"));
  } finally {
    if (savedTTL === undefined) {
      delete process.env.TKR_CACHE_TTL_SECONDS;
    } else {
      process.env.TKR_CACHE_TTL_SECONDS = savedTTL;
    }
  }
});

test("TTL detection disabled → preserves legacy nudge behavior", () => {
  // TKR_TTL_DETECTION_DISABLED=1 → detectTTL returns {300, "default"} →
  // source="default" → guard skipped → nudge fires normally.
  const savedDis = process.env.TKR_TTL_DETECTION_DISABLED;
  process.env.TKR_TTL_DETECTION_DISABLED = "1";
  try {
    const { checkPushBoundary } = newStateDir("ttl-disabled");
    const tel = mkTelemetryFile({ turn_count: 100, last_ctx_k: 200 });
    const event = { tool_name: "Bash", tool_input: { command: "git push" } };
    const out = checkPushBoundary(event, "sid-ttl-dis", tel);
    assert.ok(out, "TTL detection disabled → legacy behavior, nudge fires");
  } finally {
    if (savedDis === undefined) {
      delete process.env.TKR_TTL_DETECTION_DISABLED;
    } else {
      process.env.TKR_TTL_DETECTION_DISABLED = savedDis;
    }
  }
});
