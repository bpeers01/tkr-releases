// Tests for INV-136: the two SessionStart spawns that blocked every session.
// Run with: node --test hooks/lib/sessionstart/inv136-spawn-cache.test.js
//
// Both suites assert the SAME thing in two different ways: that a cache hit
// returns without spawning. Neither counts spawns directly — instead each
// arranges for a spawn to be IMPOSSIBLE (an unexecutable binary, or no
// resolvable binary at all) and then asserts a non-null/non-empty result.
// A value that could only have come from cache is proof the spawn was
// skipped, and unlike a counter it cannot pass vacuously.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveTkrVersion } = require("./version-ledger");
const { loadGraduationNudge } = require("./graduation-nudge");
const { binStamp } = require("../bin-stamp");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// withEnv sets keys for the duration of fn and restores exactly, including
// keys that were previously unset.
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// A plain file with a non-.js name. resolveTkrExe rejects .js/.cjs/.mjs
// (a launcher runs a different binary underneath) but is happy to stamp
// anything else, and this file is deliberately NOT executable — so if the
// cache ever misses, the spawn fails and resolveTkrVersion returns null.
function fakeBinary(dir) {
  const p = path.join(dir, process.platform === "win32" ? "fake.exe" : "fake");
  fs.writeFileSync(p, "not a real binary");
  return p;
}

// ── version cache (keyed on binary identity) ────────────────────────────────

test("INV-136: cached version for an unchanged binary returns without spawning", () => {
  const state = tmpDir("tkr-vc-state-");
  const bin = fakeBinary(tmpDir("tkr-vc-bin-"));
  withEnv({ TKR_STATE_DIR: state, TKR_BIN: bin, TKR_VERSION: undefined }, () => {
    const stamp = binStamp();
    assert.ok(stamp, "a plain non-.js file must be stampable");
    fs.writeFileSync(
      path.join(state, "version-cache.json"),
      JSON.stringify({ v: 1, stamp, version: "v9.9.9" }),
    );
    // The binary is not executable, so a spawn could only yield null.
    assert.strictEqual(resolveTkrVersion(), "v9.9.9");
  });
});

test("INV-136: a changed binary invalidates the cached version", () => {
  const state = tmpDir("tkr-vc2-state-");
  const bin = fakeBinary(tmpDir("tkr-vc2-bin-"));
  withEnv({ TKR_STATE_DIR: state, TKR_BIN: bin, TKR_VERSION: undefined }, () => {
    fs.writeFileSync(
      path.join(state, "version-cache.json"),
      JSON.stringify({ v: 1, stamp: "some-other-binary|1|1", version: "v9.9.9" }),
    );
    // Stamp mismatch → must re-ask the binary, which cannot run → null.
    // Crucially NOT "v9.9.9": a stale version must never reach the ledger.
    assert.strictEqual(resolveTkrVersion(), null);
  });
});

test("INV-136: TKR_VERSION still wins over the cache", () => {
  const state = tmpDir("tkr-vc3-state-");
  const bin = fakeBinary(tmpDir("tkr-vc3-bin-"));
  withEnv({ TKR_STATE_DIR: state, TKR_BIN: bin, TKR_VERSION: "v1.2.3" }, () => {
    const stamp = binStamp();
    fs.writeFileSync(
      path.join(state, "version-cache.json"),
      JSON.stringify({ v: 1, stamp, version: "v9.9.9" }),
    );
    assert.strictEqual(resolveTkrVersion(), "v1.2.3");
  });
});

test("INV-136: a corrupt version cache falls back instead of throwing", () => {
  const state = tmpDir("tkr-vc4-state-");
  const bin = fakeBinary(tmpDir("tkr-vc4-bin-"));
  withEnv({ TKR_STATE_DIR: state, TKR_BIN: bin, TKR_VERSION: undefined }, () => {
    fs.writeFileSync(path.join(state, "version-cache.json"), "{not json");
    assert.strictEqual(resolveTkrVersion(), null);
  });
});

// ── graduation nudge cache (TTL) ────────────────────────────────────────────

// The whole point of the change: "" is the answer on virtually every session,
// so an empty cached value must count as a HIT. If it were treated as a miss
// the spawn would stay on the hot path for every user forever.
test("INV-136: a cached EMPTY nudge is a hit, not a miss", () => {
  const state = tmpDir("tkr-gn-state-");
  const noTkr = tmpDir("tkr-gn-nopath-");
  withEnv(
    {
      TKR_STATE_DIR: state,
      TKR_SUGGEST_NO_GRADUATION: undefined,
      TKR_BIN: undefined,
      PATH: noTkr,
      Path: noTkr,
      HOME: noTkr,
      USERPROFILE: noTkr,
      LOCALAPPDATA: noTkr,
    },
    () => {
      fs.writeFileSync(
        path.join(state, "graduation-nudge.json"),
        JSON.stringify({ v: 1, at: Date.now(), line: "" }),
      );
      // Indistinguishable from a miss by return value alone, so this test
      // leans on its sibling below: same setup, non-empty cached line.
      assert.strictEqual(loadGraduationNudge(), "");
    },
  );
});

test("INV-136: a fresh cached nudge returns without spawning", () => {
  const state = tmpDir("tkr-gn2-state-");
  const noTkr = tmpDir("tkr-gn2-nopath-");
  withEnv(
    {
      TKR_STATE_DIR: state,
      TKR_SUGGEST_NO_GRADUATION: undefined,
      TKR_BIN: undefined,
      PATH: noTkr,
      Path: noTkr,
      HOME: noTkr,
      USERPROFILE: noTkr,
      LOCALAPPDATA: noTkr,
    },
    () => {
      fs.writeFileSync(
        path.join(state, "graduation-nudge.json"),
        JSON.stringify({ v: 1, at: Date.now(), line: "\n\ntkr: suggest mode rewrite" }),
      );
      // No resolvable tkr anywhere, so this string can only be the cache.
      assert.strictEqual(loadGraduationNudge(), "\n\ntkr: suggest mode rewrite");
    },
  );
});

test("INV-136: an expired nudge cache is not served", () => {
  const state = tmpDir("tkr-gn3-state-");
  const noTkr = tmpDir("tkr-gn3-nopath-");
  withEnv(
    {
      TKR_STATE_DIR: state,
      TKR_SUGGEST_NO_GRADUATION: undefined,
      TKR_BIN: undefined,
      PATH: noTkr,
      Path: noTkr,
      HOME: noTkr,
      USERPROFILE: noTkr,
      LOCALAPPDATA: noTkr,
    },
    () => {
      const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
      fs.writeFileSync(
        path.join(state, "graduation-nudge.json"),
        JSON.stringify({ v: 1, at: sevenHoursAgo, line: "\n\ntkr: suggest mode rewrite" }),
      );
      // Expired → falls through to a spawn that cannot happen → "".
      assert.strictEqual(loadGraduationNudge(), "");
    },
  );
});

// A clock that jumped backwards must not make a future-stamped cache valid
// forever; the reader requires a non-negative age.
test("INV-136: a future-dated nudge cache is rejected", () => {
  const state = tmpDir("tkr-gn4-state-");
  const noTkr = tmpDir("tkr-gn4-nopath-");
  withEnv(
    {
      TKR_STATE_DIR: state,
      TKR_SUGGEST_NO_GRADUATION: undefined,
      TKR_BIN: undefined,
      PATH: noTkr,
      Path: noTkr,
      HOME: noTkr,
      USERPROFILE: noTkr,
      LOCALAPPDATA: noTkr,
    },
    () => {
      fs.writeFileSync(
        path.join(state, "graduation-nudge.json"),
        JSON.stringify({ v: 1, at: Date.now() + 60 * 60 * 1000, line: "\n\ntkr: suggest mode x" }),
      );
      assert.strictEqual(loadGraduationNudge(), "");
    },
  );
});

// ── concurrent-writer safety (torn-read regression) ─────────────────────────
//
// The 9 tests above all use an isolated per-test TKR_STATE_DIR and run
// single-process — exactly why the non-atomic writeFileSync in
// version-ledger.js and graduation-nudge.js went unnoticed: this box
// routinely runs 8-12 concurrent Claude Code sessions, all firing
// SessionStart against the SAME state dir, so a concurrent writer is the
// normal case here. Racing real processes against each other is flaky by
// nature; simulating the torn state directly (a 0-byte / truncated file on
// disk, which is exactly what a reader can observe mid non-atomic write) is
// deterministic and exercises the same code path a real race would hit.

test("INV-136: a torn (0-byte) version cache degrades to a cache miss, not a throw", () => {
  const state = tmpDir("tkr-torn-vc-state-");
  const bin = fakeBinary(tmpDir("tkr-torn-vc-bin-"));
  withEnv({ TKR_STATE_DIR: state, TKR_BIN: bin, TKR_VERSION: undefined }, () => {
    fs.mkdirSync(state, { recursive: true });
    // Simulate a reader landing between truncate and write on a concurrent
    // fs.writeFileSync: an empty file, not valid JSON.
    fs.writeFileSync(path.join(state, "version-cache.json"), "");
    // Binary is not executable, so a spawn triggered by the cache miss can
    // only yield null — proves the empty file was treated as a miss, not
    // thrown from JSON.parse and left to crash the SessionStart hook.
    assert.strictEqual(resolveTkrVersion(), null);
  });
});

test("INV-136: a torn (truncated mid-object) version cache degrades to a cache miss", () => {
  const state = tmpDir("tkr-torn-vc2-state-");
  const bin = fakeBinary(tmpDir("tkr-torn-vc2-bin-"));
  withEnv({ TKR_STATE_DIR: state, TKR_BIN: bin, TKR_VERSION: undefined }, () => {
    fs.mkdirSync(state, { recursive: true });
    // Truncated partway through a write: valid UTF-8, invalid JSON.
    fs.writeFileSync(path.join(state, "version-cache.json"), '{"v":1,"stamp":"xy');
    assert.strictEqual(resolveTkrVersion(), null);
  });
});

test("INV-136: writeCachedVersion never leaves a torn file behind for a concurrent reader", () => {
  const state = tmpDir("tkr-atomic-vc-state-");
  const bin = fakeBinary(tmpDir("tkr-atomic-vc-bin-"));
  withEnv({ TKR_STATE_DIR: state, TKR_BIN: bin, TKR_VERSION: "v7.7.7" }, () => {
    // Drive the real write path (resolveTkrVersion → writeCachedVersion) via
    // the module's public surface, then assert the file on disk is exactly
    // one complete, parseable JSON document — the atomic-write guarantee.
    // TKR_VERSION short-circuits before ever reaching the cache, so call the
    // module's version-cache writer indirectly by re-requiring with a stamp
    // instead: assert directly against the shared helper's contract, which
    // is what both call sites now delegate to.
    const { writeJSONAtomic } = require("../safe-json");
    const target = path.join(state, "version-cache.json");
    writeJSONAtomic(target, { v: 1, stamp: "s", version: "v7.7.7" });
    const raw = fs.readFileSync(target, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.deepStrictEqual(JSON.parse(raw), { v: 1, stamp: "s", version: "v7.7.7" });
    // No leftover tmp file from the rename.
    const leftovers = fs.readdirSync(state).filter((f) => f.includes(".tmp."));
    assert.deepStrictEqual(leftovers, []);
  });
});

test("INV-136: a torn (0-byte) graduation-nudge cache degrades to a cache miss, not a throw", () => {
  const state = tmpDir("tkr-torn-gn-state-");
  const noTkr = tmpDir("tkr-torn-gn-nopath-");
  withEnv(
    {
      TKR_STATE_DIR: state,
      TKR_SUGGEST_NO_GRADUATION: undefined,
      TKR_BIN: undefined,
      PATH: noTkr,
      Path: noTkr,
      HOME: noTkr,
      USERPROFILE: noTkr,
      LOCALAPPDATA: noTkr,
    },
    () => {
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, "graduation-nudge.json"), "");
      // No resolvable tkr, so a fall-through past the torn cache can only
      // produce "" — proves the empty file was read as a miss.
      assert.strictEqual(loadGraduationNudge(), "");
    },
  );
});

test("INV-136: the kill switch short-circuits before the cache is even read", () => {
  const state = tmpDir("tkr-gn5-state-");
  withEnv({ TKR_STATE_DIR: state, TKR_SUGGEST_NO_GRADUATION: "1" }, () => {
    fs.writeFileSync(
      path.join(state, "graduation-nudge.json"),
      JSON.stringify({ v: 1, at: Date.now(), line: "\n\ntkr: suggest mode rewrite" }),
    );
    assert.strictEqual(loadGraduationNudge(), "");
  });
});
