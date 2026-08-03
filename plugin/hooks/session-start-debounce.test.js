// Hook-side debounce regression test for v3.9.0 process pile-up.
//
// shouldFireSearchRefresh writes a timestamp to
// $TKR_STATE_DIR/last-search-refresh-fire.ms and returns false on
// subsequent calls within REFRESH_DEBOUNCE_MS. This bounds redundant
// search-refresh spawns when SessionStart re-fires for /resume,
// /clear, IDE reload, etc.
//
// Run: node --test hooks/session-start-debounce.test.js

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ssdeb-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function freshRequire() {
  delete require.cache[require.resolve("./session-start.js")];
  return require("./session-start.js");
}

test("first call fires and writes the debounce timestamp", () => {
  withTempStateDir((dir) => {
    const { shouldFireSearchRefresh } = freshRequire();
    const fired = shouldFireSearchRefresh();
    assert.equal(fired, true, "first call should fire");

    const tsPath = path.join(dir, "last-search-refresh-fire.ms");
    assert.ok(fs.existsSync(tsPath), "debounce timestamp file written");
    const ts = Number(fs.readFileSync(tsPath, "utf8").trim());
    assert.ok(Number.isFinite(ts) && ts > 0, "timestamp parses");
    assert.ok(Math.abs(Date.now() - ts) < 5000, "timestamp recent (within 5s)");
  });
});

test("second call within debounce window is suppressed", () => {
  withTempStateDir(() => {
    const { shouldFireSearchRefresh } = freshRequire();
    assert.equal(shouldFireSearchRefresh(), true, "first fires");
    assert.equal(shouldFireSearchRefresh(), false, "second within window suppressed");
    assert.equal(shouldFireSearchRefresh(), false, "third within window suppressed");
  });
});

test("call after debounce window expires re-fires", () => {
  withTempStateDir((dir) => {
    const { shouldFireSearchRefresh, REFRESH_DEBOUNCE_MS } = freshRequire();
    assert.equal(shouldFireSearchRefresh(), true, "first fires");

    // Backdate the timestamp file past the debounce window.
    const tsPath = path.join(dir, "last-search-refresh-fire.ms");
    fs.writeFileSync(tsPath, String(Date.now() - REFRESH_DEBOUNCE_MS - 1000));

    assert.equal(shouldFireSearchRefresh(), true, "post-window call should re-fire");
  });
});

test("malformed timestamp file is treated as no prior fire", () => {
  withTempStateDir((dir) => {
    const tsPath = path.join(dir, "last-search-refresh-fire.ms");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tsPath, "not-a-number");
    const { shouldFireSearchRefresh } = freshRequire();
    assert.equal(shouldFireSearchRefresh(), true, "malformed → fire");
  });
});

test("3 rapid calls produce exactly 1 fire (pile-up regression)", () => {
  withTempStateDir(() => {
    const { shouldFireSearchRefresh } = freshRequire();
    const fires = [
      shouldFireSearchRefresh(),
      shouldFireSearchRefresh(),
      shouldFireSearchRefresh(),
    ].filter(Boolean);
    assert.equal(
      fires.length,
      1,
      `3 rapid calls should debounce to 1 fire (got ${fires.length}). ` +
        "v3.9.0 had no debounce — every cold-boot session fired its own refresh.",
    );
  });
});
