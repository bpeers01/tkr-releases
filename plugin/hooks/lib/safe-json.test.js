// hooks/lib/safe-json.test.js — unit tests for readJSONSync / writeJSONAtomic.
// Run with: node --test hooks/lib/safe-json.test.js

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readJSONSync, writeJSONAtomic } = require("./safe-json");

function tempFile(name = "x.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-safejson-test-"));
  return { dir, file: path.join(dir, name) };
}

test("readJSONSync returns null on missing file", () => {
  assert.equal(readJSONSync("/no/such/path.json"), null);
});

test("readJSONSync returns null on corrupt JSON", () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, "{ not json");
    assert.equal(readJSONSync(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJSONAtomic + readJSONSync round-trips", () => {
  const { dir, file } = tempFile();
  try {
    writeJSONAtomic(file, { foo: "bar", n: 42 });
    assert.deepEqual(readJSONSync(file), { foo: "bar", n: 42 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJSONAtomic creates parent directory", () => {
  const { dir } = tempFile();
  try {
    const nested = path.join(dir, "a", "b", "c", "state.json");
    writeJSONAtomic(nested, { ok: true });
    assert.deepEqual(readJSONSync(nested), { ok: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJSONAtomic leaves no .tmp.* file behind on success", () => {
  const { dir, file } = tempFile();
  try {
    writeJSONAtomic(file, { x: 1 });
    const leftover = fs.readdirSync(dir).filter((n) => n.includes(".tmp."));
    assert.equal(leftover.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJSONAtomic swallows errors when target is unwritable", () => {
  // Pass a path that can't be created (parent is an existing file, not dir).
  const { dir, file } = tempFile("blocker");
  try {
    fs.writeFileSync(file, "blocker");
    const bad = path.join(file, "nested.json");
    assert.doesNotThrow(() => writeJSONAtomic(bad, { x: 1 }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
