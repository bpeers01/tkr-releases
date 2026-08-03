// Self-heal + kill switch tests for shouldFireSearchRefresh.
//
// Run: node --test hooks/session-start-selfheal.test.js

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sselfh-"));
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

function writeTimings(dir, entries) {
  const file = path.join(dir, "hook-timings.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function refreshTimeoutEntry(ageMs) {
  return {
    kind: "spawn_timeout_kill",
    cmd: "tkr",
    args: ["search", "--refresh"],
    timeout_ms: 60000,
    ts: new Date(Date.now() - ageMs).toISOString(),
  };
}

test("TKR_SESSION_REFRESH_DISABLED=1 forces skip", () => {
  withTempStateDir(() => {
    const prev = process.env.TKR_SESSION_REFRESH_DISABLED;
    process.env.TKR_SESSION_REFRESH_DISABLED = "1";
    try {
      const { shouldFireSearchRefresh } = freshRequire();
      assert.equal(shouldFireSearchRefresh(), false, "kill switch skips");
    } finally {
      if (prev === undefined) delete process.env.TKR_SESSION_REFRESH_DISABLED;
      else process.env.TKR_SESSION_REFRESH_DISABLED = prev;
    }
  });
});

test("3+ recent timeouts disable auto-refresh", () => {
  withTempStateDir((dir) => {
    writeTimings(dir, [
      refreshTimeoutEntry(1000 * 60 * 60), // 1h ago
      refreshTimeoutEntry(1000 * 60 * 30),
      refreshTimeoutEntry(1000 * 60 * 5),
    ]);
    const { shouldFireSearchRefresh } = freshRequire();
    assert.equal(shouldFireSearchRefresh(), false, "self-heal disabled fire");
  });
});

test("old timeouts (>24h) do not count", () => {
  withTempStateDir((dir) => {
    writeTimings(dir, [
      refreshTimeoutEntry(1000 * 60 * 60 * 48),
      refreshTimeoutEntry(1000 * 60 * 60 * 30),
      refreshTimeoutEntry(1000 * 60 * 60 * 25),
    ]);
    const { shouldFireSearchRefresh } = freshRequire();
    assert.equal(shouldFireSearchRefresh(), true, "stale timeouts ignored");
  });
});

test("countRecentRefreshTimeouts returns N within window", () => {
  withTempStateDir((dir) => {
    writeTimings(dir, [
      refreshTimeoutEntry(1000 * 60),
      refreshTimeoutEntry(1000 * 60 * 60),
      refreshTimeoutEntry(1000 * 60 * 60 * 25), // out of window
    ]);
    const { countRecentRefreshTimeouts } = freshRequire();
    assert.equal(countRecentRefreshTimeouts(), 2);
  });
});

test("TKR_SESSION_REFRESH_ENABLED=1 overrides self-heal", () => {
  withTempStateDir((dir) => {
    writeTimings(dir, [
      refreshTimeoutEntry(1000 * 60 * 60),
      refreshTimeoutEntry(1000 * 60 * 30),
      refreshTimeoutEntry(1000 * 60 * 5),
    ]);
    const prev = process.env.TKR_SESSION_REFRESH_ENABLED;
    process.env.TKR_SESSION_REFRESH_ENABLED = "1";
    try {
      const { shouldFireSearchRefresh } = freshRequire();
      assert.equal(shouldFireSearchRefresh(), true, "override re-enables");
    } finally {
      if (prev === undefined) delete process.env.TKR_SESSION_REFRESH_ENABLED;
      else process.env.TKR_SESSION_REFRESH_ENABLED = prev;
    }
  });
});

test("no timings file → fire normally", () => {
  withTempStateDir(() => {
    const { shouldFireSearchRefresh, countRecentRefreshTimeouts } = freshRequire();
    assert.equal(countRecentRefreshTimeouts(), 0);
    assert.equal(shouldFireSearchRefresh(), true);
  });
});
