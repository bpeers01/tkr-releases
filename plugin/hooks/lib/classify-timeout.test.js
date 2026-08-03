// Tests for hooks/lib/classify-timeout.js (INV-073 evidence marker).
//
// Run: node --test hooks/lib/classify-timeout.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendClassifyTimeout,
  classifyTimeoutsPath,
} = require("./classify-timeout.js");

function withStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-classify-timeout-"));
  const saved = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (saved === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("happy path: one row, exact shape, in the decisions directory", () => {
  withStateDir((dir) => {
    appendClassifyTimeout({ session_id: "sess-1", timeout_ms: 250 });

    // Same directory as decisions.jsonl — the tkr state dir.
    const target = classifyTimeoutsPath();
    assert.strictEqual(target, path.join(dir, "classify-timeouts.jsonl"));

    const lines = fs.readFileSync(target, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.deepStrictEqual(
      Object.keys(row).sort(),
      ["session_id", "source", "timeout_ms", "ts"],
      "row must carry exactly ts/session_id/timeout_ms/source",
    );
    assert.strictEqual(row.session_id, "sess-1");
    assert.strictEqual(row.timeout_ms, 250);
    assert.strictEqual(row.source, "user-prompt-submit");
    assert.ok(!Number.isNaN(Date.parse(row.ts)), "ts must parse as ISO8601");
  });
});

test("appends accumulate — one line per timeout", () => {
  withStateDir(() => {
    appendClassifyTimeout({ session_id: "a", timeout_ms: 250 });
    appendClassifyTimeout({ session_id: "b", timeout_ms: 250 });
    const raw = fs.readFileSync(classifyTimeoutsPath(), "utf8").trim();
    assert.strictEqual(raw.split("\n").length, 2);
  });
});

test("best-effort: an unwritable state dir never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-classify-timeout-"));
  const file = path.join(dir, "not-a-dir");
  fs.writeFileSync(file, "plain file");
  const saved = process.env.TKR_STATE_DIR;
  // A state dir nested UNDER a plain file: mkdirSync and appendFileSync
  // both fail, and the helper must swallow that (hot path, INV-073).
  process.env.TKR_STATE_DIR = path.join(file, "nested");
  try {
    assert.doesNotThrow(() =>
      appendClassifyTimeout({ session_id: "s", timeout_ms: 250 }),
    );
  } finally {
    if (saved === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage input never throws and writes nothing", () => {
  withStateDir(() => {
    assert.doesNotThrow(() => appendClassifyTimeout(null));
    assert.doesNotThrow(() => appendClassifyTimeout("nope"));
    assert.ok(
      !fs.existsSync(classifyTimeoutsPath()),
      "non-object input must not produce a row",
    );
  });
});

test("rotation is delegated to the shared module, not reimplemented", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "classify-timeout.js"),
    "utf8",
  );
  assert.ok(
    /require\(["']\.\/rotate-jsonl["']\)/.test(src),
    "classify-timeout.js must require the shared rotate-jsonl module",
  );
  assert.ok(
    !/unlinkSync|rmSync|\.rm\(/.test(src),
    "classify-timeout.js must not remove files — rotation is rename-only",
  );
});
