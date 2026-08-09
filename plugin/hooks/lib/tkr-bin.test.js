#!/usr/bin/env node
// Tests for hooks/lib/tkr-bin.js — binary resolution + the JS entry-point
// rule (#143 finding 1).
//
// The load-bearing property is PATH INDEPENDENCE. The old veto shim put an
// extensionless `#!/bin/sh` file named `tkr` first on PATH, which Node
// cannot resolve on Windows without a shell — so on Windows the veto tests
// could not execute their own shim, and the ones asserting "no deny
// happened" passed vacuously. Resolving through TKR_BIN to an absolute
// path, and launching a .js target with the current node, removes the
// platform-specific step entirely.
//
// This suite cannot run on Windows from here, so it proves the property
// rather than the platform: with PATH emptied, the resolved shim must
// still run. PATH lookup is the only part of the old mechanism that was
// platform-specific, so a mechanism that never consults PATH cannot fail
// the way the old one did.
//
// Run: node --test hooks/lib/tkr-bin.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { resolveTkrBin, tkrSpawnArgv } = require("./tkr-bin");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-bin-"));
}

test("TKR_BIN wins over every other candidate", () => {
  const dir = tmpdir();
  const bin = path.join(dir, "my-tkr");
  fs.writeFileSync(bin, "");
  try {
    assert.strictEqual(resolveTkrBin({ TKR_BIN: bin, HOME: dir }), bin);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a TKR_BIN naming a nonexistent file falls through to bare tkr", () => {
  const dir = tmpdir();
  try {
    // Not an error: the override is a preference, and PATH resolution is
    // still a legitimate way to find the binary. Failing hard here would
    // turn a stale env var into a broken hook.
    assert.strictEqual(
      resolveTkrBin({ TKR_BIN: path.join(dir, "nope"), HOME: dir }),
      "tkr",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bare tkr is the fallback when nothing is installed", () => {
  const dir = tmpdir();
  try {
    assert.strictEqual(resolveTkrBin({ HOME: dir }), "tkr");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-JS binary is spawned directly, args unchanged", () => {
  const dir = tmpdir();
  const bin = path.join(dir, "tkr-real");
  fs.writeFileSync(bin, "");
  try {
    const { cmd, argv } = tkrSpawnArgv(["route", "veto-check"], { TKR_BIN: bin, HOME: dir });
    assert.strictEqual(cmd, bin);
    assert.deepStrictEqual(argv, ["route", "veto-check"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const ext of [".js", ".cjs", ".mjs", ".JS"]) {
  test(`a ${ext} entry point is launched with the current node`, () => {
    const dir = tmpdir();
    const bin = path.join(dir, "launcher" + ext);
    fs.writeFileSync(bin, "");
    try {
      const { cmd, argv } = tkrSpawnArgv(["rewrite"], { TKR_BIN: bin, HOME: dir });
      assert.strictEqual(cmd, process.execPath);
      assert.deepStrictEqual(argv, [bin, "rewrite"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("PATH independence: a resolved JS shim runs with PATH emptied", () => {
  // The whole point. The old mechanism needed the OS to find an
  // extensionless file on PATH — the step that does not work on Windows.
  // Nothing here consults PATH, so emptying it changes nothing.
  const dir = tmpdir();
  const bin = path.join(dir, "shim.js");
  fs.writeFileSync(bin, `process.stdout.write(JSON.stringify({verdict:"allow"}));\n`);
  try {
    const { cmd, argv } = tkrSpawnArgv(["route", "veto-check"], { TKR_BIN: bin });
    const res = spawnSync(cmd, argv, {
      encoding: "utf8",
      // No shell, exactly as vetoCheck spawns. PATH is a directory that
      // contains nothing at all.
      env: { ...process.env, PATH: tmpdir() },
      windowsHide: true,
    });
    assert.ifError(res.error);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepStrictEqual(JSON.parse(res.stdout), { verdict: "allow" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a JS shim spawned WITHOUT the argv mapping fails — the mapping is required, not cosmetic", () => {
  // Guards the caller contract in the module header. Handing the resolved
  // .js path straight to spawnSync means "exec a text file", which fails
  // as ENOEXEC/EACCES — and on a fail-open path like the veto that is
  // indistinguishable from a clean allow, so the failure would be silent.
  const dir = tmpdir();
  const bin = path.join(dir, "shim.js");
  fs.writeFileSync(bin, `process.stdout.write("{}");\n`);
  try {
    const res = spawnSync(bin, ["route", "veto-check"], { encoding: "utf8", windowsHide: true });
    assert.ok(
      res.error || res.status !== 0,
      "executing a .js file directly must not succeed",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
