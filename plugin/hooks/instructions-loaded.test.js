#!/usr/bin/env node
// Probe test for hooks/instructions-loaded.js — verifies one JSONL row
// is appended per call with the right fields, and stdout returns `{}`.
//
// Run: node hooks/instructions-loaded.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "instructions-loaded.js");

function runHook(payload) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-il-test-"));
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, TKR_STATE_DIR: tmp },
      encoding: "utf8",
    });
    const log = path.join(tmp, "instructions-load.jsonl");
    const rows = fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    return { res, rows, tmp };
  } finally {
    // Caller decides cleanup — return tmp for inspection
  }
}

test("returns empty JSON on stdout", () => {
  const { res, tmp } = runHook({
    file_path: "/x/CLAUDE.md",
    load_reason: "session_start",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
});

test("appends one row per call with full payload", () => {
  const payload = {
    session_id: "s123",
    cwd: "/repo",
    file_path: "/repo/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
    globs: ["src/**/*.ts"],
    trigger_file_path: "/repo/src/foo.ts",
    parent_file_path: "/repo/CLAUDE.md",
  };
  const { res, rows, tmp } = runHook(payload);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.session_id, "s123");
  assert.strictEqual(r.file_path, "/repo/CLAUDE.md");
  assert.strictEqual(r.memory_type, "Project");
  assert.strictEqual(r.load_reason, "session_start");
  assert.deepStrictEqual(r.globs, ["src/**/*.ts"]);
  assert.strictEqual(r.trigger_file_path, "/repo/src/foo.ts");
  assert.ok(typeof r.ts === "string" && r.ts.length > 0);
});

test("malformed JSON stdin still returns {} and writes nothing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-il-test-"));
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{not json",
      env: { ...process.env, TKR_STATE_DIR: tmp },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, "{}");
    const log = path.join(tmp, "instructions-load.jsonl");
    assert.strictEqual(fs.existsSync(log), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing optional fields default to empty/[]", () => {
  const { rows, tmp } = runHook({ file_path: "/x", load_reason: "session_start" });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].session_id, "");
  assert.deepStrictEqual(rows[0].globs, []);
  assert.strictEqual(rows[0].parent_file_path, "");
});
