// hooks/tkr-rewrite.fastpath.test.js
//
// HOOK-003: the rewrite-heads fast-path must skip the tkr subprocess exactly
// when a command cannot reach any rewrite rule/filter, and must fall back to
// spawning on every doubt (missing/incomplete/stale manifest, TKR_DISABLED).
// Drives the real hook via stdin spawn with TKR_BIN pointed at a shim that
// records invocations, so "did it spawn" is observable.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.join(__dirname, "tkr-rewrite.js");

// Windows: every test below observes "did it spawn" through a shim that is
// an extensionless `#!/bin/sh` file. Windows has no shebang dispatch and
// child_process resolves a bare name only to .exe/.com, so the shim never
// executes, spawns.log is never written, and every spawn-expecting
// assertion sees []. Skip the file rather than fail it — and skip it
// WHOLESALE, including the one test that expects no spawn: that test
// passes on Windows for the wrong reason (nothing can spawn there), so
// leaving it enabled reports green for a fast-path that could be entirely
// broken. A skip says "unverified here"; a vacuous pass lies.
// CI runs `node --test` on ubuntu-latest only (ci.yml lint-scripts), which
// is where these actually gate.
if (process.platform === "win32") {
  test("tkr-rewrite fast-path (POSIX-only shim)", {
    skip: "POSIX-only: shim is an extensionless #!/bin/sh file; gated on ubuntu-latest in CI",
  }, () => {});
  return;
}

function setup(t, { manifest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-fastpath-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const spawnLog = path.join(dir, "spawns.log");
  const shim = path.join(dir, "tkr-shim");
  fs.writeFileSync(shim, `#!/bin/sh\necho "$2" >> "${spawnLog}"\nexit 1\n`);
  fs.chmodSync(shim, 0o755);

  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, "rewrite-heads.json"), JSON.stringify(manifest));
  }
  return { dir, shim, spawnLog };
}

function runHook(cmd, { dir, shim }, extraEnv = {}) {
  const env = {
    ...process.env,
    TKR_STATE_DIR: dir,
    TKR_BIN: shim,
    TKR_HOOK_TIMINGS: "0",
  };
  delete env.TKR_DISABLED;
  delete env.TKR_HOOKS_DISABLED;
  Object.assign(env, extraEnv);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: "sid-fastpath", tool_input: { command: cmd } }),
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.strictEqual(res.status, 0, `hook exit ${res.status}, stderr: ${res.stderr}`);
  return res;
}

function spawnedCommands(spawnLog) {
  try {
    return fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function freshManifest(heads, overrides = {}) {
  return {
    schema: 1,
    binary_version: "v-test",
    generated_unix: Math.floor(Date.now() / 1000),
    complete: true,
    heads,
    ...overrides,
  };
}

const HEADS = ["git", "ls", "python", "pipx", "./"];

test("ineligible command with valid manifest skips the spawn", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  const res = runHook("cd /tmp && echo done && mkdir -p x", ctx);
  assert.deepStrictEqual(spawnedCommands(ctx.spawnLog), []);
  assert.strictEqual(res.stdout, "");
});

test("eligible command spawns", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("git status", ctx);
  assert.deepStrictEqual(spawnedCommands(ctx.spawnLog), ["git status"]);
});

test("eligible segment inside a compound command spawns", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("cd /x && git pull", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("head is a prefix: python covers python3", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("python3 script.py", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("wrapper head: pipx run tsc spawns", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("pipx run tsc --noEmit", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("quoted head and command substitution both spawn", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook('"git" status', ctx);
  runHook("REV=$(git rev-parse HEAD) printenv REV", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 2);
});

test("./ head covers relative-path invocations", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("./gradlew build", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("missing manifest spawns even for ineligible commands", (t) => {
  const ctx = setup(t); // no manifest
  runHook("cd /tmp", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("incomplete manifest disables the fast-path", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS, { complete: false }) });
  runHook("cd /tmp", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("stale manifest disables the fast-path", (t) => {
  const stale = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
  const ctx = setup(t, { manifest: freshManifest(HEADS, { generated_unix: stale }) });
  runHook("cd /tmp", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("wrong schema disables the fast-path", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS, { schema: 2 }) });
  runHook("cd /tmp", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("TKR_DISABLED-prefixed command still spawns for telemetry", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("TKR_DISABLED=1 mkdir -p /tmp/x", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("TKR_DISABLED env still spawns for telemetry", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("mkdir -p /tmp/x", ctx, { TKR_DISABLED: "1" });
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});

test("head appearing as an argument over-matches to a spawn (documented)", (t) => {
  const ctx = setup(t, { manifest: freshManifest(HEADS) });
  runHook("echo git", ctx);
  assert.strictEqual(spawnedCommands(ctx.spawnLog).length, 1);
});
