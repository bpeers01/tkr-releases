// Tests for the SessionStart resident warm-up (#287).
//
// The lifecycle rules themselves are tested against resident-client.warm() in
// hooks/lib/resident-client.test.js. What is under test here is the SessionStart
// policy layer: which kill switches short-circuit before warm() is reached, that
// the project root handed over is the one the request path will look under, and
// that nothing in this module can fail a session start.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..", "..");
const WIN = process.platform === "win32";
// Absolute path to a binary that exits immediately; resolveTkrExe realpaths
// TKR_BIN, so a bare name resolves against cwd and fails identity verification.
// Candidates rather than a /bin/true hardcode because macOS 26 ships no
// /bin/true (#365) — same resolver as hooks/lib/resident-client.test.js; a
// divergence between the two fails loudly on the platform missing the path,
// which is the bug this replaced.
const STUB_BIN = (() => {
  if (WIN) return process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  const candidates = ["/usr/bin/true", "/bin/true"];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    `no no-op stub binary found (tried ${candidates.join(", ")}) — ` +
      "this suite needs one absolute, immediately-exiting executable",
  );
})();

function tmpState(name) {
  // Short by necessity: a Unix socket under this dir cannot exceed ~100 bytes.
  return fs.mkdtempSync(path.join(os.tmpdir(), `tkrwarm-${name}-`));
}

// stateDir() is resolved per call but reads process.env, so the env has to be
// set before the modules are (re-)required.
function freshWarm(stateDir) {
  process.env.TKR_STATE_DIR = stateDir;
  delete require.cache[require.resolve("./resident-warm.js")];
  delete require.cache[require.resolve("../resident-client.js")];
  delete require.cache[require.resolve("../state-dir.js")];
  return {
    warm: require("./resident-warm.js").warmResidentRuntime,
    client: require("../resident-client.js"),
  };
}

function markerFor(client, root) {
  return path.join(client.runDir(), `${client.keyFor(client.projectRootFor(root))}.start`);
}

const ENV_ON = { TKR_RESIDENT_ENABLED: "1", TKR_BIN: STUB_BIN };

test("warm-up is off unless the runtime is opted in", () => {
  const dir = tmpState("off");
  const { warm, client } = freshWarm(dir);
  const v = warm({ env: { TKR_BIN: STUB_BIN }, cwd: dir });
  assert.equal(v.reason, "disabled");
  assert.equal(fs.existsSync(markerFor(client, dir)), false);
});

test("TKR_HOOKS_DISABLED=1 short-circuits before any resident work", () => {
  const dir = tmpState("hooksoff");
  const { warm, client } = freshWarm(dir);
  const v = warm({ env: { ...ENV_ON, TKR_HOOKS_DISABLED: "1" }, cwd: dir });
  assert.deepEqual(v, { started: false, reason: "hooks_disabled" });
  assert.equal(fs.existsSync(markerFor(client, dir)), false);
});

// TKR_DISABLED=1 turns tkr's hook rewrites off. Conjuring a background process
// whose only job is serving those rewrites would be the opposite of what the
// user asked for.
test("TKR_DISABLED=1 declines to start a runtime", () => {
  const dir = tmpState("tkroff");
  const { warm, client } = freshWarm(dir);
  const v = warm({ env: { ...ENV_ON, TKR_DISABLED: "1" }, cwd: dir });
  assert.deepEqual(v, { started: false, reason: "tkr_disabled" });
  assert.equal(fs.existsSync(markerFor(client, dir)), false);
});

test("TKR_RESIDENT_DISABLED=1 wins over TKR_RESIDENT_ENABLED=1", () => {
  const dir = tmpState("resoff");
  const { warm, client } = freshWarm(dir);
  const v = warm({ env: { ...ENV_ON, TKR_RESIDENT_DISABLED: "1" }, cwd: dir });
  assert.equal(v.reason, "disabled");
  assert.equal(fs.existsSync(markerFor(client, dir)), false);
});

test("an opted-in session start launches a runtime for its project root", () => {
  const dir = tmpState("on");
  const proj = path.join(dir, "proj");
  fs.mkdirSync(path.join(proj, ".tkr"), { recursive: true });
  const { warm, client } = freshWarm(dir);

  const v = warm({ env: ENV_ON, cwd: proj });
  assert.equal(v.reason, "started");
  assert.equal(v.started, true);
  // The key must be the one the request path derives from the same directory,
  // or the warm-up starts a runtime no Bash call ever finds.
  assert.equal(v.key, client.keyFor(client.projectRootFor(proj)));
  assert.ok(fs.existsSync(markerFor(client, proj)));
});

// SessionStart already trusts CLAUDE_PROJECT_DIR for every other project-scoped
// decision; warm-up must agree with it rather than with the hook's cwd.
test("CLAUDE_PROJECT_DIR selects the project root when no cwd is passed", () => {
  const dir = tmpState("cpd");
  const proj = path.join(dir, "proj");
  fs.mkdirSync(path.join(proj, ".tkr"), { recursive: true });
  const { warm, client } = freshWarm(dir);

  const v = warm({ env: { ...ENV_ON, CLAUDE_PROJECT_DIR: proj } });
  assert.equal(v.key, client.keyFor(client.projectRootFor(proj)));
});

// SessionStart is the first hook to fire; a throw here is a session that fails
// to start before the user has typed anything.
test("warm-up returns a verdict rather than throwing", () => {
  const dir = tmpState("throw");
  const { warm } = freshWarm(dir);
  for (const opts of [
    undefined,
    {},
    { env: { ...ENV_ON, TKR_BIN: "\u0000bad" }, cwd: dir },
    { env: ENV_ON, cwd: path.join(dir, "does", "not", "exist") },
  ]) {
    const v = warm(opts);
    assert.equal(typeof v.reason, "string");
    assert.equal(typeof v.started, "boolean");
  }
});

// End to end through the real hook file: an opted-in SessionStart must warm the
// runtime, must still emit its guidance, and must not wait on the runtime.
test("the real SessionStart hook warms the runtime without blocking", () => {
  const dir = tmpState("e2e");
  const proj = path.join(dir, "proj");
  fs.mkdirSync(path.join(proj, ".tkr"), { recursive: true });
  const { client } = freshWarm(dir);
  const marker = markerFor(client, proj);

  const env = {
    ...process.env,
    TKR_STATE_DIR: dir,
    TKR_RESIDENT_ENABLED: "1",
    TKR_BIN: STUB_BIN,
    CLAUDE_PROJECT_DIR: proj,
  };
  delete env.TKR_RESIDENT_DISABLED;
  delete env.TKR_HOOKS_DISABLED;
  delete env.TKR_DISABLED;

  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO, "hooks", "session-start.js")], {
    input: JSON.stringify({ session_id: "warm-e2e", source: "startup", cwd: proj }),
    encoding: "utf8",
    env,
    cwd: proj,
    timeout: 20000,
  });
  const elapsed = Date.now() - t0;

  assert.equal(r.status, 0, `session-start exited ${r.status}: ${r.stderr}`);
  assert.ok(fs.existsSync(marker), "SessionStart must have attempted a warm start");
  // The runtime's own cold start is ~50ms+ and the stub binary exits at once;
  // either way SessionStart must not have waited on it. This bound is loose on
  // purpose — it is a "did not block on a process" assertion, not a budget.
  assert.ok(elapsed < 15000, `session-start took ${elapsed}ms — it waited on something`);
});

// The same hook, opted out, must leave no resident footprint at all. This is
// the guard on #288 staying a separate decision.
test("the real SessionStart hook starts nothing when not opted in", () => {
  const dir = tmpState("e2eoff");
  const proj = path.join(dir, "proj");
  fs.mkdirSync(path.join(proj, ".tkr"), { recursive: true });
  const { client } = freshWarm(dir);

  const env = { ...process.env, TKR_STATE_DIR: dir, TKR_BIN: STUB_BIN, CLAUDE_PROJECT_DIR: proj };
  delete env.TKR_RESIDENT_ENABLED;
  delete env.TKR_HOOKS_DISABLED;

  const r = spawnSync(process.execPath, [path.join(REPO, "hooks", "session-start.js")], {
    input: JSON.stringify({ session_id: "warm-e2e-off", source: "startup", cwd: proj }),
    encoding: "utf8",
    env,
    cwd: proj,
    timeout: 20000,
  });
  assert.equal(r.status, 0, `session-start exited ${r.status}: ${r.stderr}`);
  assert.equal(
    fs.existsSync(markerFor(client, proj)),
    false,
    "an install that has not opted in must see no resident activity",
  );
});
