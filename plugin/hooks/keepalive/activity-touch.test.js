#!/usr/bin/env node
// Tests for hooks/keepalive/activity-touch.sh — single-fire correctness
// guards (INV-024). The keepalive wake's own continuation turn re-enters
// UserPromptSubmit; if treated as user activity it resets the idle clock
// and deletes fired-at every cycle, re-arming the watcher forever
// (observed: 18–21 fires per overnight session instead of 1). These tests
// pin both guards: content (wake sentinel) and recency (fresh fired-at).
//
// Run: node --test hooks/keepalive/activity-touch.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.join(__dirname, "activity-touch.sh");

// Resolve a bash. Skip the whole suite if none is available (e.g. a
// Windows runner without git-bash) — the hook only ever runs under bash.
function findBash() {
  const probe = spawnSync("bash", ["-c", "exit 0"]);
  if (!probe.error) return "bash";
  return null;
}
const BASH = findBash();

function run(stdin, { stateDir, sid = "testsid", env = {}, cwd } = {}) {
  return spawnSync(BASH, [HOOK], {
    input: stdin,
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      TKR_STATE_DIR: stateDir,
      TKR_SESSION_ID: sid,
      ...env,
    },
  });
}

function mkState(sid = "testsid") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ka-touch-"));
  const dir = path.join(root, "keepalive", sid);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const wakePrompt = (extra = "") =>
  JSON.stringify({
    session_id: "testsid",
    prompt:
      "INTENTIONAL keepalive wake (not an error). Session idle..." + extra,
  });

test("content guard: wake continuation does not reset activity or clear fired-at", { skip: !BASH }, () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), "999");

  run(wakePrompt(), { stateDir: root });

  assert.equal(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), "100", "activity unchanged");
  assert.equal(fs.readFileSync(path.join(dir, "fired-at"), "utf8").trim(), "999", "fired-at preserved");
  fs.rmSync(root, { recursive: true, force: true });
});

test("recency guard: fresh fired-at suppresses bump even without sentinel", { skip: !BASH }, () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(Math.floor(Date.now() / 1000)));

  run(JSON.stringify({ session_id: "testsid", prompt: "some skill invocation" }), { stateDir: root });

  assert.equal(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), "100", "activity unchanged");
  assert.ok(fs.existsSync(path.join(dir, "fired-at")), "fired-at preserved (recent)");
  fs.rmSync(root, { recursive: true, force: true });
});

test("genuine prompt with no fired-at re-arms: activity bumped to now", { skip: !BASH }, () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");

  run(JSON.stringify({ session_id: "testsid", prompt: "fix the login bug" }), { stateDir: root });

  const a = parseInt(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 5, "activity bumped to ~now");
  fs.rmSync(root, { recursive: true, force: true });
});

test("genuine prompt with stale fired-at (>grace) clears gate and bumps activity", { skip: !BASH }, () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(Math.floor(Date.now() / 1000) - 600));

  run(JSON.stringify({ session_id: "testsid", prompt: "real work" }), {
    stateDir: root,
    env: { TKR_KEEPALIVE_REARM_GRACE_SEC: "180" },
  });

  assert.ok(!fs.existsSync(path.join(dir, "fired-at")), "fired-at cleared");
  const a = parseInt(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 5, "activity bumped");
  fs.rmSync(root, { recursive: true, force: true });
});

// --- KEEP-006: project-scoped activity + cross-session recency guard ---

function projectKey(p) {
  const script =
    `. "${path.join(__dirname, "resolve-project.sh").replace(/\\/g, "/")}"; ` +
    `tkr_keepalive_project_key "${p.replace(/\\/g, "/")}"`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim();
}

// Ask bash for ITS spelling of the cwd first — git-bash renders the
// Windows temp dir as /tmp/..., and mount aliases are deliberately not
// resolved by the key function (see watcher.test.js bashCwdKey).
function bashCwdKey(dir) {
  const r = spawnSync(BASH, ["-c", 'echo "$PWD"'], { cwd: dir, encoding: "utf8", timeout: 5000 });
  return projectKey((r.stdout || "").trim());
}

test("genuine prompt stamps project last-activity (cross-session idle reset)", { skip: !BASH }, () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");

  run(JSON.stringify({ session_id: "testsid", prompt: "real work" }), {
    stateDir: root,
    cwd: root,
  });

  const key = bashCwdKey(root);
  assert.ok(key, "test cwd must resolve to a non-empty key");
  const la = path.join(root, "keepalive-projects", key, "last-activity");
  assert.ok(fs.existsSync(la), "project last-activity must be stamped");
  const a = parseInt(fs.readFileSync(la, "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 5, "project last-activity ~now");
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard 2b: fresh PROJECT last-fired suppresses bump even with no per-sid fired-at (cross-session wake)", { skip: !BASH }, () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  // A watcher of a DIFFERENT session in this project fired moments ago —
  // guard 2's per-sid fired-at doesn't exist for this sid (HAND-004
  // shape), so the project marker is the only recency signal.
  const key = bashCwdKey(root);
  const projDir = path.join(root, "keepalive-projects", key);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "last-fired"), String(Math.floor(Date.now() / 1000)));
  fs.writeFileSync(path.join(projDir, "last-activity"), "100");

  run(JSON.stringify({ session_id: "testsid", prompt: "some skill invocation" }), {
    stateDir: root,
    cwd: root,
  });

  assert.equal(
    fs.readFileSync(path.join(dir, "activity"), "utf8").trim(),
    "100",
    "per-sid activity unchanged",
  );
  assert.equal(
    fs.readFileSync(path.join(projDir, "last-activity"), "utf8").trim(),
    "100",
    "project last-activity unchanged (fire gate stays closed for the firing watcher's sid)",
  );
  fs.rmSync(root, { recursive: true, force: true });
});
