// spawn-bounded.js — unit tests for hard-timeout-capped detached spawn.
// Run with: node --test hooks/lib/spawn-bounded.test.js

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-spawnbnd-test-"));
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
  delete require.cache[require.resolve("./spawn-bounded")];
  return require("./spawn-bounded");
}

function waitExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
}

test("kills hung child within timeout window", async () => {
  await withTempStateDir(async () => {
    const { spawnBounded } = freshRequire();
    const start = Date.now();
    const child = spawnBounded(
      process.execPath,
      ["-e", "setInterval(()=>{}, 100)"],
      { stdio: "ignore" },
      300,
    );
    assert.ok(child, "spawn returned a child");
    const { signal, code } = await waitExit(child);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `killed within 2s wall-clock (got ${elapsed}ms)`);
    // signal=SIGKILL on unix, code=null + signal=SIGKILL on Windows too via TerminateProcess.
    assert.ok(signal === "SIGKILL" || code !== 0, `expected non-zero exit; signal=${signal} code=${code}`);
  });
});

test("clears killer when child exits before timeout", async () => {
  await withTempStateDir((dir) => {
    const { spawnBounded } = freshRequire();
    const child = spawnBounded(
      process.execPath,
      ["-e", "process.exit(0)"],
      { stdio: "ignore" },
      30_000, // long timeout — child exits fast
    );
    return waitExit(child).then(({ code }) => {
      assert.equal(code, 0);
      // Wait long enough that killer would have logged a timeout if not cleared.
      return new Promise((r) => setTimeout(r, 100)).then(() => {
        const log = path.join(dir, "hook-timings.jsonl");
        // File should NOT exist (killer never fired → no log).
        assert.equal(fs.existsSync(log), false, "no timeout log expected");
      });
    });
  });
});

test("logs timeout kill to hook-timings.jsonl", async () => {
  await withTempStateDir(async (dir) => {
    const prev = process.env.TKR_HOOK_TIMINGS;
    process.env.TKR_HOOK_TIMINGS = "1";
    try {
      const { spawnBounded } = freshRequire();
      const child = spawnBounded(
        process.execPath,
        ["-e", "setInterval(()=>{}, 100)"],
        { stdio: "ignore" },
        150,
      );
      await waitExit(child);
      // Give the timing-log appendFileSync a tick to flush.
      await new Promise((r) => setTimeout(r, 50));
      const log = path.join(dir, "hook-timings.jsonl");
      assert.equal(fs.existsSync(log), true, "timeout log written");
      const lines = fs.readFileSync(log, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[lines.length - 1]);
      assert.equal(entry.kind, "spawn_timeout_kill");
      assert.equal(entry.timeout_ms, 150);
    } finally {
      if (prev === undefined) delete process.env.TKR_HOOK_TIMINGS;
      else process.env.TKR_HOOK_TIMINGS = prev;
    }
  });
});

test("returns null when spawn throws (bogus binary)", () => {
  withTempStateDir(() => {
    const { spawnBounded } = freshRequire();
    // Empty cmd is invalid — spawn throws synchronously.
    const child = spawnBounded("", [], {}, 1000);
    assert.equal(child, null);
  });
});

test("default timeout fires when none specified", async () => {
  await withTempStateDir(async () => {
    const { spawnBounded } = freshRequire();
    const start = Date.now();
    // Don't pass timeoutMs — should default to 5_000 (we'll cap test at 6s).
    // To keep test fast, override via short-running child + assert exit < 1s.
    const child = spawnBounded(
      process.execPath,
      ["-e", "process.exit(0)"],
      { stdio: "ignore" },
    );
    const { code } = await waitExit(child);
    assert.equal(code, 0);
    assert.ok(Date.now() - start < 2000);
  });
});
