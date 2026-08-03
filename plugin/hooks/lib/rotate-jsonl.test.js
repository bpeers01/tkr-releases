// Tests for hooks/lib/rotate-jsonl.js — the shared single-generation
// rotator every JS hot-path JSONL writer is required to use
// (hooks/CLAUDE.md § Stability rules).
//
// The property that matters is the one #86 fixed: a rotator must never
// REMOVE the destination before renaming onto it. These ledgers have
// multiple independent rotators with no shared lock — parallel hook
// processes on the JS side, and for some files a second rotator in the Go
// binary — so remove-then-rename let two racers destroy each other's
// work: A renames live -> .1, B removes the .1 A just created, B's rename
// then finds no source and fails. A whole generation gone, silently, from
// a file that exists to be a record.
//
// Sequential calls cannot reproduce that (the second call's stat returns
// early), so the race test forks real processes — which is also exactly
// how it happens in production, when Claude dispatches several agents at
// once and their PreToolUse hooks run side by side.
//
// Run: node --test hooks/lib/rotate-jsonl.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { rotateIfLarge, DEFAULT_MAX_BYTES } = require("./rotate-jsonl.js");
const MODULE = path.join(__dirname, "rotate-jsonl.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-rotate-"));
}

// overCap puts a marker at the head, then extends the file sparsely so
// stat reports the cap without writing that many bytes.
function overCap(file, marker, cap = DEFAULT_MAX_BYTES) {
  fs.writeFileSync(file, marker + "\n");
  fs.truncateSync(file, cap);
}

test("the live file becomes the generation", () => {
  const dir = tmpdir();
  try {
    const live = path.join(dir, "ledger.jsonl");
    overCap(live, "generation-A");
    rotateIfLarge(live);
    assert.ok(
      fs.readFileSync(live + ".1", "utf8").startsWith("generation-A"),
      "live content did not reach .1",
    );
    assert.ok(!fs.existsSync(live), "live file should have been moved away");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Guards the assumption the fix rests on: rename replaces an existing
// target atomically on POSIX and on Windows. If it did not, dropping the
// unlink would strand every rotation after the first.
test("rename replaces an existing generation", () => {
  const dir = tmpdir();
  try {
    const live = path.join(dir, "ledger.jsonl");
    fs.writeFileSync(live + ".1", "generation-old\n");
    overCap(live, "generation-new");
    rotateIfLarge(live);
    assert.ok(
      fs.readFileSync(live + ".1", "utf8").startsWith("generation-new"),
      "rename did not replace the prior generation",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("under cap and missing are no-ops that leave .1 alone", () => {
  const dir = tmpdir();
  try {
    const live = path.join(dir, "ledger.jsonl");

    rotateIfLarge(live);
    assert.ok(!fs.existsSync(live + ".1"), "rotated a file that does not exist");

    fs.writeFileSync(live + ".1", "generation-old\n");
    fs.writeFileSync(live, "small\n");
    rotateIfLarge(live);
    assert.strictEqual(fs.readFileSync(live, "utf8"), "small\n");
    assert.strictEqual(
      fs.readFileSync(live + ".1", "utf8"),
      "generation-old\n",
      "under-cap rotation touched the prior generation",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit cap overrides the default", () => {
  const dir = tmpdir();
  try {
    const live = path.join(dir, "ledger.jsonl");
    fs.writeFileSync(live, "x".repeat(200) + "\n");
    rotateIfLarge(live, 100);
    assert.ok(fs.existsSync(live + ".1"), "explicit cap was not honored");

    // Invalid caps fall back to the default rather than rotating on
    // every call — a zero or negative cap would rotate a 1-byte file.
    const live2 = path.join(dir, "b.jsonl");
    fs.writeFileSync(live2, "small\n");
    for (const bad of [0, -1, NaN, "100", null]) rotateIfLarge(live2, bad);
    assert.ok(!fs.existsSync(live2 + ".1"), "an invalid cap rotated a small file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The regression gate. Forks real processes so several rotators pass
// their size check before any of them renames — the only interleaving
// that loses data, and the one that happens in production when parallel
// PreToolUse(Agent) hooks fire at once.
//
// Under rename-only the assertion holds for EVERY interleaving, not just
// most: the first rename moves live to .1, and every later rename finds
// no source and fails without touching .1. So correct code cannot fail
// this test. Scheduling only decides whether a BROKEN implementation gets
// caught on a given round — measured at round 1 against the pre-#86
// unlink-then-rename.
test("concurrent rotators do not destroy each other's generation", async () => {
  const ROUNDS = 6;
  const RACERS = 12;
  // spawn, NOT spawnSync: spawnSync blocks until each child exits, which
  // would run the "racers" one at a time and test nothing at all.
  // Two-way handshake, NOT a sleep. The first version of this test let
  // the children boot for 150ms and then released them; on a loaded CI
  // runner a straggler had not started yet, and the whole point is that
  // every racer must be poised to rotate at the moment of release.
  // Each child announces readiness and blocks; the parent releases only
  // once all of them have. No assumption about process startup time.
  const SRC = `
    const {rotateIfLarge} = require(${JSON.stringify(MODULE)});
    const f = process.argv[1];
    process.stdin.once("data", () => { rotateIfLarge(f); process.exit(0); });
    process.stdout.write("ready\\n");
  `;
  for (let round = 0; round < ROUNDS; round++) {
    const dir = tmpdir();
    try {
      const live = path.join(dir, "ledger.jsonl");
      overCap(live, "generation-A");

      const kids = Array.from({ length: RACERS }, () =>
        spawn(process.execPath, ["-e", SRC, live], {
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
      await Promise.all(
        kids.map(
          (k) => new Promise((res) => k.stdout.once("data", res)),
        ),
      );
      for (const k of kids) k.stdin.end("go");

      const codes = await Promise.all(
        kids.map((k) => new Promise((res) => k.once("exit", res))),
      );
      assert.ok(
        codes.every((c) => c === 0),
        `a racer exited non-zero: ${codes.join(",")}`,
      );

      assert.ok(
        fs.existsSync(live + ".1"),
        `round ${round}: the generation was destroyed by a losing rotator`,
      );
      assert.ok(
        fs.readFileSync(live + ".1", "utf8").startsWith("generation-A"),
        `round ${round}: .1 holds unexpected content`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
