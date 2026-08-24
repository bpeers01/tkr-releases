// Tests for hooks/lib/git-status-snapshot.js (INV-097).
//
// Run: node --test hooks/lib/git-status-snapshot.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function withTempRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-gss-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-gss-state-"));
  const prevCwd = process.cwd();
  const prevState = process.env.TKR_STATE_DIR;
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "tracked.txt"), "one\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    process.env.TKR_STATE_DIR = stateDir;
    process.chdir(dir);
    delete require.cache[require.resolve("./git-status-snapshot.js")];
    const mod = require("./git-status-snapshot.js");
    fn(mod, dir);
  } finally {
    process.chdir(prevCwd);
    if (prevState === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevState;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete require.cache[require.resolve("./git-status-snapshot.js")];
  }
}

test("snapshotGitStatus + popOldestSnapshot round-trips a clean tree", () => {
  withTempRepo((mod) => {
    mod.snapshotGitStatus("sid-a");
    const snap = mod.popOldestSnapshot("sid-a");
    assert.ok(snap);
    assert.deepStrictEqual(snap.lines, []);
    // Popped once, gone.
    assert.strictEqual(mod.popOldestSnapshot("sid-a"), null);
  });
});

test("diffTrackedMutations flags a tracked-file edit made after the snapshot", () => {
  withTempRepo((mod, dir) => {
    mod.snapshotGitStatus("sid-b");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "two\n");
    const before = mod.popOldestSnapshot("sid-b");
    const after = mod.currentGitStatus();
    const mutated = mod.diffTrackedMutations(before.lines, after);
    assert.strictEqual(mutated.length, 1);
    assert.ok(mutated[0].includes("tracked.txt"));
  });
});

test("diffTrackedMutations ignores new untracked scratch files", () => {
  withTempRepo((mod, dir) => {
    mod.snapshotGitStatus("sid-c");
    fs.writeFileSync(path.join(dir, "scratch.txt"), "new\n");
    const before = mod.popOldestSnapshot("sid-c");
    const after = mod.currentGitStatus();
    const mutated = mod.diffTrackedMutations(before.lines, after);
    assert.strictEqual(mutated.length, 0);
  });
});

test("concurrent spawns in the same session do not clobber each other's snapshot", () => {
  withTempRepo((mod) => {
    mod.snapshotGitStatus("sid-d");
    mod.snapshotGitStatus("sid-d");
    const first = mod.popOldestSnapshot("sid-d");
    const second = mod.popOldestSnapshot("sid-d");
    assert.ok(first);
    assert.ok(second);
    assert.strictEqual(mod.popOldestSnapshot("sid-d"), null);
  });
});

test("popOldestSnapshot fails open when no snapshot exists", () => {
  withTempRepo((mod) => {
    assert.strictEqual(mod.popOldestSnapshot("no-such-sid"), null);
  });
});

test("snapshotGitStatus is a no-op outside a git repo (fails open)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-gss-nogit-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-gss-nogit-state-"));
  const prevCwd = process.cwd();
  const prevState = process.env.TKR_STATE_DIR;
  try {
    process.env.TKR_STATE_DIR = stateDir;
    process.chdir(dir);
    delete require.cache[require.resolve("./git-status-snapshot.js")];
    const mod = require("./git-status-snapshot.js");
    assert.doesNotThrow(() => mod.snapshotGitStatus("sid-e"));
    assert.strictEqual(mod.popOldestSnapshot("sid-e"), null);
  } finally {
    process.chdir(prevCwd);
    if (prevState === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevState;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete require.cache[require.resolve("./git-status-snapshot.js")];
  }
});
