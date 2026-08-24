// Tests for tryFilterStdin's exit-code threading (#381 item 4 / #337 item 4).
//
// The host only gives PostToolUse a boolean (tool_response.is_error), not a
// numeric exit code. tryFilterStdin turns that into exitCode 0/1 and must
// thread it identically down BOTH paths — the resident call and the
// tkrSpawnSync fallback — per the invariant documented in bash-filter.js:
// the two paths must never disagree about identical input.
//
// resident-client and tkr-spawn are swapped for fakes via require.cache so
// this exercises only the threading logic, not a real socket or subprocess.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const RESIDENT_PATH = require.resolve("../resident-client.js");
const SPAWN_PATH = require.resolve("./tkr-spawn.js");
const MODULE_PATH = require.resolve("./bash-filter.js");

function freshBashFilter({ residentCall, spawnSync }) {
  delete require.cache[MODULE_PATH];
  require.cache[RESIDENT_PATH] = {
    id: RESIDENT_PATH,
    filename: RESIDENT_PATH,
    loaded: true,
    exports: { call: residentCall },
  };
  require.cache[SPAWN_PATH] = {
    id: SPAWN_PATH,
    filename: SPAWN_PATH,
    loaded: true,
    exports: { tkrSpawnSync: spawnSync },
  };
  return require(MODULE_PATH);
}

test.afterEach(() => {
  delete require.cache[MODULE_PATH];
  delete require.cache[RESIDENT_PATH];
  delete require.cache[SPAWN_PATH];
});

test("isError:true threads exitCode 1 into the resident call's opts", async () => {
  let capturedOpts;
  const { tryFilterStdin } = freshBashFilter({
    residentCall: async (op, cmd, body, opts) => {
      capturedOpts = opts;
      return { exit: 0, body: Buffer.from("filtered") };
    },
    spawnSync: () => {
      throw new Error("must not spawn — the resident already served this");
    },
  });

  const out = await tryFilterStdin("some-cmd", "raw", { isError: true });
  assert.equal(out, "filtered");
  assert.equal(capturedOpts.exitCode, 1);
});

test("no isError threads exitCode 0 into the resident call's opts", async () => {
  let capturedOpts;
  const { tryFilterStdin } = freshBashFilter({
    residentCall: async (op, cmd, body, opts) => {
      capturedOpts = opts;
      return { exit: 0, body: Buffer.from("filtered") };
    },
    spawnSync: () => {
      throw new Error("must not spawn — the resident already served this");
    },
  });

  await tryFilterStdin("some-cmd", "raw", {});
  assert.equal(capturedOpts.exitCode, 0);
});

test("resident unavailable + isError:true: spawn fallback carries --exit-code=1", async () => {
  let capturedArgs;
  const { tryFilterStdin } = freshBashFilter({
    residentCall: async () => null,
    spawnSync: (args) => {
      capturedArgs = args;
      return "filtered";
    },
  });

  const out = await tryFilterStdin("git status", "raw", { isError: true });
  assert.equal(out, "filtered");
  assert.deepEqual(capturedArgs, ["filter-stdin", "--exit-code=1", "git status"]);
});

test("resident unavailable + no isError: spawn fallback carries no exit-code flag", async () => {
  let capturedArgs;
  const { tryFilterStdin } = freshBashFilter({
    residentCall: async () => null,
    spawnSync: (args) => {
      capturedArgs = args;
      return "filtered";
    },
  });

  await tryFilterStdin("git status", "raw", {});
  assert.deepEqual(capturedArgs, ["filter-stdin", "git status"]);
});
