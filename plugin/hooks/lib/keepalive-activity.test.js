#!/usr/bin/env node
// Tests for hooks/lib/keepalive-activity.js — the JS port of the former
// hooks/keepalive/activity-touch.sh (issue #129).
//
// Single-fire correctness guards (INV-024): the keepalive wake's own
// continuation turn re-enters UserPromptSubmit; if treated as user
// activity it resets the idle clock and deletes fired-at every cycle,
// re-arming the watcher forever (observed: 18–21 fires per overnight
// session instead of 1). These tests pin all three guards: content (wake
// sentinel), per-sid recency (fresh fired-at), and cross-session recency
// (project last-fired, KEEP-006/HAND-004).
//
// Also pins byte parity between keepaliveProjectKey() and the bash
// tkr_keepalive_project_key (resolve-project.sh) — watcher.sh still
// computes the key in bash, so a divergence silently splits the project
// gate per writer.
//
// Run: node --test hooks/lib/keepalive-activity.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  activityTouch,
  keepaliveProjectKey,
  WAKE_SENTINEL,
} = require("./keepalive-activity");

const UPS_HOOK = path.join(__dirname, "..", "user-prompt-submit.js");
const RESOLVE_PROJECT = path.join(__dirname, "..", "keepalive", "resolve-project.sh");

// Resolve a bash for the parity suite. Skip when unavailable (e.g. a
// Windows runner without git-bash) — the JS side is still fully covered.
function findBash() {
  const probe = spawnSync("bash", ["-c", "exit 0"]);
  if (!probe.error) return "bash";
  return null;
}
const BASH = findBash();

function mkState(sid = "testsid") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ka-touch-"));
  const dir = path.join(root, "keepalive", sid);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

// Drive activityTouch with a temp TKR_STATE_DIR, restoring env after.
function touch(data, { stateDir, sid = "testsid", env = {} } = {}) {
  const saved = {};
  const overrides = { TKR_STATE_DIR: stateDir, ...env };
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const rawInput = JSON.stringify(data);
    activityTouch({ rawInput, data, sid });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const wakePrompt = (extra = "") => ({
  session_id: "testsid",
  prompt: `${WAKE_SENTINEL} (not an error). Session idle...` + extra,
});

test("content guard: wake continuation does not reset activity or clear fired-at", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), "999");

  touch(wakePrompt(), { stateDir: root });

  assert.equal(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), "100", "activity unchanged");
  assert.equal(fs.readFileSync(path.join(dir, "fired-at"), "utf8").trim(), "999", "fired-at preserved");
  fs.rmSync(root, { recursive: true, force: true });
});

test("recency guard: fresh fired-at suppresses bump even without sentinel", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(Math.floor(Date.now() / 1000)));

  touch({ session_id: "testsid", prompt: "some skill invocation" }, { stateDir: root });

  assert.equal(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), "100", "activity unchanged");
  assert.ok(fs.existsSync(path.join(dir, "fired-at")), "fired-at preserved (recent)");
  fs.rmSync(root, { recursive: true, force: true });
});

test("genuine prompt with no fired-at re-arms: activity bumped to now", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");

  touch({ session_id: "testsid", prompt: "fix the login bug" }, { stateDir: root });

  const a = parseInt(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 5, "activity bumped to ~now");
  fs.rmSync(root, { recursive: true, force: true });
});

test("genuine prompt with stale fired-at (>grace) clears gate and bumps activity", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(Math.floor(Date.now() / 1000) - 600));

  touch({ session_id: "testsid", prompt: "real work" }, {
    stateDir: root,
    env: { TKR_KEEPALIVE_REARM_GRACE_SEC: "180" },
  });

  assert.ok(!fs.existsSync(path.join(dir, "fired-at")), "fired-at cleared");
  const a = parseInt(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 5, "activity bumped");
  fs.rmSync(root, { recursive: true, force: true });
});

// --- KEEP-006: project-scoped activity + cross-session recency guard ---

test("genuine prompt stamps project last-activity (cross-session idle reset)", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");

  touch({ session_id: "testsid", prompt: "real work", cwd: root }, { stateDir: root });

  const key = keepaliveProjectKey(root);
  assert.ok(key, "test cwd must resolve to a non-empty key");
  const la = path.join(root, "keepalive-projects", key, "last-activity");
  assert.ok(fs.existsSync(la), "project last-activity must be stamped");
  const a = parseInt(fs.readFileSync(la, "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 5, "project last-activity ~now");
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard 2b: fresh PROJECT last-fired suppresses bump even with no per-sid fired-at (cross-session wake)", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  // A watcher of a DIFFERENT session in this project fired moments ago —
  // guard 2's per-sid fired-at doesn't exist for this sid (HAND-004
  // shape), so the project marker is the only recency signal.
  const key = keepaliveProjectKey(root);
  const projDir = path.join(root, "keepalive-projects", key);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "last-fired"), String(Math.floor(Date.now() / 1000)));
  fs.writeFileSync(path.join(projDir, "last-activity"), "100");

  touch({ session_id: "testsid", prompt: "some skill invocation", cwd: root }, { stateDir: root });

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

// --- keepaliveProjectKey: JS behavior + byte parity with resolve-project.sh ---

const KEY_CASES = [
  "C:\\Users\\Someone\\Projects\\tkr",
  "/c/Users/Someone/Projects/tkr",
  "c:/Users/Someone/Projects/tkr",
  "/home/user/work/app",
  "/home/user/work/app///",
  "/c",
  "/",
  "C:\\",
  "/tmp/ka-touch-xyz",
  "relative/path",
  "with spaces/and.dots",
];

test("keepaliveProjectKey: Windows and git-bash spellings of one cwd agree", () => {
  assert.equal(
    keepaliveProjectKey("C:\\Users\\Someone\\Projects\\tkr"),
    keepaliveProjectKey("/c/Users/Someone/Projects/tkr"),
  );
  assert.equal(keepaliveProjectKey(""), "", "empty cwd → empty key (skip project gate)");
  assert.equal(
    keepaliveProjectKey("/home/user/work/app///"),
    keepaliveProjectKey("/home/user/work/app"),
    "trailing slashes stripped",
  );
});

test("keepaliveProjectKey matches bash tkr_keepalive_project_key byte-for-byte", { skip: !BASH }, () => {
  // One bash spawn for ALL cases — process spawn on Windows can take
  // seconds under load (the very pathology behind issue #129), so a
  // per-case spawn flakes on its own timeout.
  const script =
    `. "${RESOLVE_PROJECT.replace(/\\/g, "/")}"; ` +
    `for p in "$@"; do tkr_keepalive_project_key "$p"; done`;
  const r = spawnSync(BASH, ["-c", script, "bash", ...KEY_CASES], {
    encoding: "utf8",
    timeout: 30000,
  });
  if (r.error || r.status === null) {
    // A bash that cannot complete one spawn in 30s is unusable for
    // testing (saturated Windows box) — same treatment as no bash at
    // all. CI still enforces parity: spawns there are milliseconds.
    console.log(`parity skipped: bash spawn unusable (${r.error || "timeout"})`);
    return;
  }
  assert.equal(r.status, 0, `bash exited 0 (stderr: ${r.stderr})`);
  const bashKeys = (r.stdout || "").split("\n");
  KEY_CASES.forEach((input, i) => {
    assert.equal(keepaliveProjectKey(input), bashKeys[i], `parity for ${JSON.stringify(input)}`);
  });
});

// --- e2e wiring: the touch fires from user-prompt-submit.js ---

function runUps(data, { stateDir }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ka-ups-"));
  const r = spawnSync(process.execPath, [UPS_HOOK], {
    input: JSON.stringify(data),
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      TKR_STATE_DIR: stateDir,
      TKR_STATUSLINE_PATH: path.join(tmp, "claude-statusline.json"),
      TKR_ROUTE_CACHE_DIR: tmp,
    },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

test("e2e: user-prompt-submit.js performs the activity touch", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(Math.floor(Date.now() / 1000) - 600));

  const r = runUps({ session_id: "testsid", prompt: "fix the login bug", cwd: root }, { stateDir: root });
  assert.equal(r.status, 0, `hook exited 0 (stderr: ${r.stderr})`);

  const a = parseInt(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 10, "activity bumped by the hook");
  assert.ok(!fs.existsSync(path.join(dir, "fired-at")), "stale fired-at cleared by the hook");
  fs.rmSync(root, { recursive: true, force: true });
});

test("e2e: touch fires on brevity turns too (early-return path)", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");

  const r = runUps({ session_id: "testsid", prompt: "/brevity ultra", cwd: root }, { stateDir: root });
  assert.equal(r.status, 0, `hook exited 0 (stderr: ${r.stderr})`);

  const a = parseInt(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), 10);
  assert.ok(Math.abs(Date.now() / 1000 - a) <= 10, "/brevity is genuine activity — clock reset");
  fs.rmSync(root, { recursive: true, force: true });
});
