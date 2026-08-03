// proc-lock.js — unit tests for cross-platform single-instance lock.
// Run with: node --test hooks/lib/proc-lock.test.js

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-proclock-test-"));
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
  delete require.cache[require.resolve("./proc-lock")];
  return require("./proc-lock");
}

test("acquire writes lock file with current pid", () => {
  withTempStateDir((dir) => {
    const { tryAcquire, lockPath, SCHEMA_VERSION } = freshRequire();
    const r = tryAcquire("test-cmd", { maxAgeMs: 60_000, cmd: "test-cmd run" });
    assert.equal(r.acquired, true);
    assert.equal(r.holder.pid, process.pid);
    assert.equal(r.holder.v, SCHEMA_VERSION);

    const file = lockPath("test-cmd");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.cmd, "test-cmd run");
    r.release();
    assert.equal(fs.existsSync(file), false);
  });
});

test("second acquire blocks while first holds the lock", () => {
  withTempStateDir(() => {
    const { tryAcquire } = freshRequire();
    const a = tryAcquire("singleton", { maxAgeMs: 60_000 });
    assert.equal(a.acquired, true);

    const b = tryAcquire("singleton", { maxAgeMs: 60_000 });
    assert.equal(b.acquired, false);
    assert.equal(b.holder.pid, process.pid);

    a.release();
    const c = tryAcquire("singleton", { maxAgeMs: 60_000 });
    assert.equal(c.acquired, true);
    c.release();
  });
});

test("stale-by-age lock is reclaimed", () => {
  withTempStateDir((dir) => {
    const { tryAcquire, lockPath } = freshRequire();
    fs.mkdirSync(path.join(dir, "locks"), { recursive: true });
    const file = lockPath("aged");
    fs.writeFileSync(file, JSON.stringify({
      v: 1,
      pid: process.pid, // alive — only age triggers reclaim
      ts: Date.now() - 10 * 60_000,
      cmd: "old",
      host: "host",
    }));

    const r = tryAcquire("aged", { maxAgeMs: 60_000 });
    assert.equal(r.acquired, true);
    r.release();
  });
});

test("stale-by-dead-pid lock is reclaimed", () => {
  withTempStateDir((dir) => {
    const { tryAcquire, lockPath } = freshRequire();
    fs.mkdirSync(path.join(dir, "locks"), { recursive: true });
    const file = lockPath("deadpid");
    // PID guaranteed dead: 999_999_999 > Linux PID_MAX (4_194_303) and far above
    // Windows practical PID range. process.kill(pid, 0) returns ESRCH.
    fs.writeFileSync(file, JSON.stringify({
      v: 1,
      pid: 999_999_999,
      ts: Date.now(),
      cmd: "old",
      host: "host",
    }));

    const r = tryAcquire("deadpid", { maxAgeMs: 60_000 });
    assert.equal(r.acquired, true);
    r.release();
  });
});

test("corrupt lock file is treated as stale", () => {
  withTempStateDir((dir) => {
    const { tryAcquire, lockPath } = freshRequire();
    fs.mkdirSync(path.join(dir, "locks"), { recursive: true });
    fs.writeFileSync(lockPath("corrupt"), "}}}NOT JSON{{{");

    const r = tryAcquire("corrupt", { maxAgeMs: 60_000 });
    assert.equal(r.acquired, true);
    r.release();
  });
});

test("isStale: dead pid", () => {
  withTempStateDir(() => {
    const { isStale } = freshRequire();
    assert.equal(isStale({ pid: 999_999_999, ts: Date.now() }, 60_000), true);
  });
});

test("isStale: live pid within age", () => {
  withTempStateDir(() => {
    const { isStale } = freshRequire();
    assert.equal(isStale({ pid: process.pid, ts: Date.now() }, 60_000), false);
  });
});

test("isStale: live pid past age", () => {
  withTempStateDir(() => {
    const { isStale } = freshRequire();
    assert.equal(
      isStale({ pid: process.pid, ts: Date.now() - 120_000 }, 60_000),
      true,
    );
  });
});

test("withLock skips fn when lock held", async () => {
  await withTempStateDir(async () => {
    const { tryAcquire, withLock } = freshRequire();
    const a = tryAcquire("wl", { maxAgeMs: 60_000 });
    assert.equal(a.acquired, true);

    let ran = false;
    const r = await withLock("wl", { maxAgeMs: 60_000 }, () => { ran = true; });
    assert.equal(r.skipped, true);
    assert.equal(ran, false);

    a.release();
  });
});

test("withLock runs fn and releases lock on success", async () => {
  await withTempStateDir(() => {
    const { withLock, tryAcquire } = freshRequire();
    const r = withLock("wl-ok", { maxAgeMs: 60_000 }, () => 42);
    return r.then((res) => {
      assert.equal(res.skipped, false);
      assert.equal(res.value, 42);
      // Lock should be released — next acquire succeeds
      const a = tryAcquire("wl-ok", { maxAgeMs: 60_000 });
      assert.equal(a.acquired, true);
      a.release();
    });
  });
});

test("withLock releases lock on fn throw", async () => {
  await withTempStateDir(() => {
    const { withLock, tryAcquire } = freshRequire();
    return withLock("wl-throw", { maxAgeMs: 60_000 }, () => {
      throw new Error("boom");
    }).then(
      () => assert.fail("should have rejected"),
      () => {
        const a = tryAcquire("wl-throw", { maxAgeMs: 60_000 });
        assert.equal(a.acquired, true);
        a.release();
      },
    );
  });
});

test("release is idempotent", () => {
  withTempStateDir(() => {
    const { tryAcquire } = freshRequire();
    const r = tryAcquire("idem", { maxAgeMs: 60_000 });
    r.release();
    r.release(); // no throw
    const r2 = tryAcquire("idem", { maxAgeMs: 60_000 });
    assert.equal(r2.acquired, true);
    r2.release();
  });
});
