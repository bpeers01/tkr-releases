// Tests for hooks/lib/sessionstart/mode-bootstrap.js (PLAN-33).
//
// Covers AT-PLAN33-6 (sweep) and AT-PLAN33-8 (bootstrap spawn shape).
//
// Run: node --test hooks/lib/sessionstart/mode-bootstrap.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-mode-sweep-"));
}

function loadFresh() {
  delete require.cache[require.resolve("./mode-bootstrap")];
  return require("./mode-bootstrap");
}

test("AT-PLAN33-6: sweep deletes mode-*.json older than 24h, preserves fresh", () => {
  const tmp = mkTmp();
  const prev = process.env.TKR_STATE_DIR;
  try {
    process.env.TKR_STATE_DIR = tmp;
    const { sweepStaleModeFiles, STALE_MS } = loadFresh();

    const stale = path.join(tmp, "mode-stale-sid.json");
    const fresh = path.join(tmp, "mode-fresh-sid.json");
    fs.writeFileSync(stale, '{"mode":"critical"}');
    fs.writeFileSync(fresh, '{"mode":"normal"}');
    const oldTime = (Date.now() - STALE_MS - 60_000) / 1000;
    fs.utimesSync(stale, oldTime, oldTime);

    const removed = sweepStaleModeFiles();
    assert.strictEqual(removed, 1, "exactly one stale file removed");
    assert.strictEqual(fs.existsSync(stale), false, "stale removed");
    assert.strictEqual(fs.existsSync(fresh), true, "fresh kept");
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("PLAN-34: sweep deletes stale legacy mode.json + mode-auto-counter.tmp.*", () => {
  // Post-PLAN-34, legacy mode.json no longer needs preservation (every
  // CLI invocation promotes sid via DiscoverSID). Stale legacy files
  // mislead the rare sid-less reader. Lock tmp files left by crashed
  // proc-locks also accumulate and must be swept.
  const tmp = mkTmp();
  const prev = process.env.TKR_STATE_DIR;
  try {
    process.env.TKR_STATE_DIR = tmp;
    const { sweepStaleModeFiles, STALE_MS } = loadFresh();

    const legacy = path.join(tmp, "mode.json");
    const lockTmpStale = path.join(tmp, "mode-auto-counter.tmp.12345");
    const lockTmpFresh = path.join(tmp, "mode-auto-counter.tmp.99999");
    const counterNoDot = path.join(tmp, "mode-auto-counter"); // no `.tmp` — leave alone
    const unrelated = path.join(tmp, "decisions.jsonl");
    fs.writeFileSync(legacy, '{"mode":"critical"}');
    fs.writeFileSync(lockTmpStale, "42");
    fs.writeFileSync(lockTmpFresh, "43");
    fs.writeFileSync(counterNoDot, "44");
    fs.writeFileSync(unrelated, "{}");
    const oldTime = (Date.now() - STALE_MS - 60_000) / 1000;
    for (const f of [legacy, lockTmpStale, counterNoDot, unrelated]) {
      fs.utimesSync(f, oldTime, oldTime);
    }

    const removed = sweepStaleModeFiles();
    assert.strictEqual(removed, 2, "legacy + stale lock-tmp swept");
    assert.strictEqual(fs.existsSync(legacy), false, "stale legacy removed");
    assert.strictEqual(fs.existsSync(lockTmpStale), false, "stale lock tmp removed");
    assert.strictEqual(fs.existsSync(lockTmpFresh), true, "fresh lock tmp kept");
    assert.strictEqual(fs.existsSync(counterNoDot), true, "non-tmp counter preserved");
    assert.strictEqual(fs.existsSync(unrelated), true, "unrelated preserved");
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweep leaves FRESH legacy mode.json alone (under staleMs)", () => {
  // Defensive: a sid-less shell user might write `mode.json` directly
  // and immediately re-read it; we must not race-delete a fresh file.
  const tmp = mkTmp();
  const prev = process.env.TKR_STATE_DIR;
  try {
    process.env.TKR_STATE_DIR = tmp;
    const { sweepStaleModeFiles } = loadFresh();

    const legacy = path.join(tmp, "mode.json");
    fs.writeFileSync(legacy, '{"mode":"normal"}');
    // mtime = now → fresh

    const removed = sweepStaleModeFiles();
    assert.strictEqual(removed, 0);
    assert.strictEqual(fs.existsSync(legacy), true);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweep on missing dir is a no-op", () => {
  const prev = process.env.TKR_STATE_DIR;
  try {
    process.env.TKR_STATE_DIR = path.join(os.tmpdir(), "tkr-does-not-exist-" + Date.now());
    const { sweepStaleModeFiles } = loadFresh();
    assert.strictEqual(sweepStaleModeFiles(), 0);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
  }
});

test("AT-PLAN33-8: spawnModeAuto invokes spawnBoundedFn with sid env", () => {
  const { spawnModeAuto } = loadFresh();
  let captured = null;
  const fakeChild = { on: () => {}, unref: () => {} };
  const fakeSpawn = (cmd, argv, opts /*, timeout*/) => {
    captured = { cmd, argv, opts };
    return fakeChild;
  };
  const ok = spawnModeAuto("session-xyz", fakeSpawn);
  assert.strictEqual(ok, true);
  assert.strictEqual(captured.cmd, "tkr");
  assert.deepStrictEqual(captured.argv, ["mode", "auto"]);
  assert.strictEqual(captured.opts.detached, true);
  assert.strictEqual(captured.opts.env.TKR_SESSION_ID, "session-xyz");
});

test("spawnModeAuto returns false on empty sid (manual CLI / hookless)", () => {
  const { spawnModeAuto } = loadFresh();
  let called = false;
  const fakeSpawn = () => { called = true; return null; };
  assert.strictEqual(spawnModeAuto("", fakeSpawn), false);
  assert.strictEqual(called, false, "spawn not attempted without sid");
});

test("spawnModeAuto honors TKR_MODE_AUTO_DISABLED escape hatch", () => {
  const prev = process.env.TKR_MODE_AUTO_DISABLED;
  try {
    process.env.TKR_MODE_AUTO_DISABLED = "1";
    const { spawnModeAuto } = loadFresh();
    let called = false;
    const fakeSpawn = () => { called = true; return null; };
    assert.strictEqual(spawnModeAuto("sid", fakeSpawn), false);
    assert.strictEqual(called, false);
  } finally {
    if (prev === undefined) delete process.env.TKR_MODE_AUTO_DISABLED;
    else process.env.TKR_MODE_AUTO_DISABLED = prev;
  }
});

test("sweep also removes stale effort-<sid>.json and its tmp orphans", () => {
  const tmp = mkTmp();
  const prev = process.env.TKR_STATE_DIR;
  try {
    process.env.TKR_STATE_DIR = tmp;
    const { sweepStaleModeFiles, STALE_MS } = loadFresh();

    const staleEffort = path.join(tmp, "effort-dead-sid.json");
    const staleTmp = path.join(tmp, "effort-dead-sid.json.tmp.123");
    const freshEffort = path.join(tmp, "effort-live-sid.json");
    fs.writeFileSync(staleEffort, '{"effort":"high"}');
    fs.writeFileSync(staleTmp, '{"effort":"high"}');
    fs.writeFileSync(freshEffort, '{"effort":"low"}');
    const oldTime = (Date.now() - STALE_MS - 60_000) / 1000;
    fs.utimesSync(staleEffort, oldTime, oldTime);
    fs.utimesSync(staleTmp, oldTime, oldTime);

    const removed = sweepStaleModeFiles();
    assert.strictEqual(removed, 2, "stale effort file + tmp orphan removed");
    assert.strictEqual(fs.existsSync(freshEffort), true, "fresh effort kept");
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
