// Tests for hooks/lib/statusline-path.js — per-session scoping.
// Regression coverage for the stale [tkr: t=N ctx=NK] injection bug:
// the previous per-project file was reused across sessions on the same
// project, leaking turn_count / last_ctx_k from the prior session into
// the first UserPromptSubmit hook read of the new session.
//
// Run: node --test hooks/lib/statusline-path.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SP = require("./statusline-path");

// Helper to clear env vars between tests so default-param resolution is
// deterministic. node:test runs tests sequentially per file by default.
function clearEnv() {
  delete process.env.TKR_STATUSLINE_PATH;
  delete process.env.TKR_SESSION_ID;
  delete process.env.TMPDIR;
}

test("getTelemetryPath: sid arg produces per-session filename", () => {
  clearEnv();
  const p = SP.getTelemetryPath("/work/proj", "sid-abc", "/tmp");
  assert.strictEqual(p, path.join("/tmp", "claude-statusline--work-proj-sid-abc.json"));
});

test("getTelemetryPath: no sid + no per-session file → unscoped path (read will ENOENT)", () => {
  // The legacy per-project file used to be the documented fallback. It now
  // serves only as the "nothing found" return — callers reading it get
  // ENOENT, which they already handle. No writer creates this file.
  clearEnv();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sp-empty-"));
  try {
    const p = SP.getTelemetryPath("/work/proj", "", empty);
    assert.strictEqual(p, path.join(empty, "claude-statusline--work-proj.json"));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("getTelemetryPath: no sid + per-session files exist → newest wins (2026-05-25)", () => {
  // Regression for the "stale 70% pressure" bug: a sid-less caller used to
  // read a legacy per-project file that no current writer touches. Now it
  // walks the tmpdir for matching per-session files and picks the freshest.
  clearEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sp-newest-"));
  try {
    const older = path.join(tmp, "claude-statusline--work-proj-sid-old.json");
    const newer = path.join(tmp, "claude-statusline--work-proj-sid-new.json");
    const unrelated = path.join(tmp, "claude-statusline--other-proj-sid.json");
    fs.writeFileSync(older, "{}");
    fs.writeFileSync(unrelated, "{}");
    fs.writeFileSync(newer, "{}");
    // Force older mtime well in the past so the comparison is unambiguous
    // even on filesystems with low-resolution timestamps (HFS+, FAT).
    const past = Date.now() - 60_000;
    fs.utimesSync(older, past / 1000, past / 1000);
    fs.utimesSync(unrelated, past / 1000, past / 1000);
    const got = SP.getTelemetryPath("/work/proj", "", tmp);
    assert.strictEqual(got, newer, "expected the newest per-session file");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("getTelemetryPath: TKR_SESSION_ID env picked up when sid arg omitted", () => {
  clearEnv();
  process.env.TKR_SESSION_ID = "env-sid";
  // Default param reads env at call-time, not at module-load.
  const p = SP.getTelemetryPath("/work/proj", undefined, "/tmp");
  assert.strictEqual(p, path.join("/tmp", "claude-statusline--work-proj-env-sid.json"));
  clearEnv();
});

test("getTelemetryPath: explicit sid arg wins over env", () => {
  clearEnv();
  process.env.TKR_SESSION_ID = "env-sid";
  const p = SP.getTelemetryPath("/work/proj", "arg-sid", "/tmp");
  assert.strictEqual(p, path.join("/tmp", "claude-statusline--work-proj-arg-sid.json"));
  clearEnv();
});

test("getTelemetryPath: TKR_STATUSLINE_PATH override wins over everything", () => {
  clearEnv();
  process.env.TKR_STATUSLINE_PATH = "/custom/override.json";
  process.env.TKR_SESSION_ID = "env-sid";
  assert.strictEqual(SP.getTelemetryPath("/work/proj", "arg-sid", "/tmp"), "/custom/override.json");
  clearEnv();
});

test("two distinct sids on the same project produce distinct paths (regression)", () => {
  clearEnv();
  const a = SP.getTelemetryPath("/work/proj", "session-A", "/tmp");
  const b = SP.getTelemetryPath("/work/proj", "session-B", "/tmp");
  assert.notStrictEqual(a, b, "session-A and session-B must not share a file");
});

test("getTelemetryGlobPrefix: matches per-session basenames", () => {
  const prefix = SP.getTelemetryGlobPrefix("/work/proj");
  assert.strictEqual(prefix, "claude-statusline--work-proj-");
  // Sanity: a per-session basename should start with the prefix.
  const basename = "claude-statusline--work-proj-sid-xyz.json";
  assert.ok(basename.startsWith(prefix));
});

test("slugifyCwd: normalizes drive + slashes", () => {
  assert.strictEqual(SP.slugifyCwd("C:\\Users\\b\\proj"), "C--Users-b-proj");
  assert.strictEqual(SP.slugifyCwd("/home/b/proj"), "-home-b-proj");
});
