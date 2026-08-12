#!/usr/bin/env node
// Tests for hooks/keepalive/idle-decision.sh — the keepalive watcher's
// per-tick decision, factored out of watcher.sh so it is testable without
// the polling loop's eligibility shell-out, parent-alive watchdog, infinite
// sleep, or a Python interpreter (all of which made a full-script spawn
// flaky/unrunnable on Windows git-bash).
//
// Regression (the resume bug): a missing/empty/garbage `activity` value used
// to be read as 0, so idle = now - 0 ≈ 1.78e9s, which cleared any threshold
// and fired on EVERY tick (observed: bogus ~56yr idle in the wake message).
// The decision now returns RESEED for unknown activity (caller re-seeds to
// now and waits) instead of FIRE, while still firing on genuinely stale
// activity and waiting when recently active.
//
// Run: node --test hooks/keepalive/watcher.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DECISION = path.join(__dirname, "idle-decision.sh");
const WATCHER = path.join(__dirname, "watcher.sh");

// Resolve a bash; skip the suite if none (the hook only runs under bash).
function findBash() {
  const probe = spawnSync("bash", ["-c", "exit 0"]);
  if (!probe.error) return "bash";
  return null;
}
const BASH = findBash();

// Source idle-decision.sh and invoke keepalive_idle_decision with the given
// args; return its stdout word (RESEED | FIRE | WAIT). No state, no PATH or
// interpreter dependency — pure function under test.
function decide(activity, now, threshold) {
  const script =
    `. "${DECISION.replace(/\\/g, "/")}"; ` +
    `keepalive_idle_decision "${activity}" "${now}" "${threshold}"`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim();
}

const NOW = 1780369000; // fixed epoch so cases are deterministic
const THRESH = 3300; // 55 min

test("missing/empty activity → RESEED (the resume bug)", { skip: !BASH }, () => {
  assert.equal(decide("", NOW, THRESH), "RESEED");
});

test("literal 0 activity → RESEED", { skip: !BASH }, () => {
  assert.equal(decide("0", NOW, THRESH), "RESEED");
});

test("garbage/non-numeric activity → RESEED", { skip: !BASH }, () => {
  assert.equal(decide("not-a-number", NOW, THRESH), "RESEED");
});

test("genuinely idle (activity 2h old) → FIRE", { skip: !BASH }, () => {
  assert.equal(decide(NOW - 7200, NOW, THRESH), "FIRE");
});

test("idle exactly at threshold → FIRE (boundary)", { skip: !BASH }, () => {
  assert.equal(decide(NOW - THRESH, NOW, THRESH), "FIRE");
});

test("recently active (60s) → WAIT", { skip: !BASH }, () => {
  assert.equal(decide(NOW - 60, NOW, THRESH), "WAIT");
});

test("one second under threshold → WAIT (boundary)", { skip: !BASH }, () => {
  assert.equal(decide(NOW - (THRESH - 1), NOW, THRESH), "WAIT");
});

// --- keepalive_fire_gate (INV-063 no-activity-since-last-fire guard) ---

// Source idle-decision.sh and invoke keepalive_fire_gate with the given
// args; return its stdout word (PROCEED | SUPPRESS).
function gate(activity, firedAt) {
  const script =
    `. "${DECISION.replace(/\\/g, "/")}"; ` +
    `keepalive_fire_gate "${activity}" "${firedAt}"`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim();
}

test("first fire (fired_at unset) → PROCEED, never suppressed", { skip: !BASH }, () => {
  assert.equal(gate(0, 0), "PROCEED");
  assert.equal(gate(NOW, 0), "PROCEED");
  assert.equal(gate("", ""), "PROCEED");
});

test("activity strictly after fired_at → PROCEED (next fire allowed)", { skip: !BASH }, () => {
  assert.equal(gate(NOW - 100, NOW - 200), "PROCEED");
});

test("no activity since fired_at → SUPPRESS", { skip: !BASH }, () => {
  assert.equal(gate(NOW - 200, NOW - 100), "SUPPRESS");
});

test("activity exactly equal to fired_at (clock skew) → SUPPRESS", { skip: !BASH }, () => {
  assert.equal(gate(NOW, NOW), "SUPPRESS");
});

// --- watcher.sh end-to-end: suppression emits a ledger event ---
//
// Deliberately does NOT pre-resolve/execute a python candidate from JS (see
// resolve-python.test.js) — probing `python3 --version` directly risks
// hanging on the Windows Store "App Execution Alias" stub. watcher.sh's own
// resolve-python.sh already handles stub-skipping; we just let it. `input:
// ""` guarantees stdin is provided and immediately closed, so even a
// worst-case fallback-to-stub selection can't block on an open inherited
// pipe.

test("watcher.sh suppresses a respawned watcher with no activity since last fire, emitting keepalive_suppressed", { skip: !BASH }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-keepalive-gate-"));
  try {
    const sid = "gate-test-sid";
    const dir = path.join(stateDir, "keepalive", sid);
    fs.mkdirSync(dir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    // Fired 5 minutes ago; the recorded activity predates the fire (15
    // minutes ago) — no real user activity has happened since — must
    // suppress rather than silently exit.
    fs.writeFileSync(path.join(dir, "fired-at"), String(now - 300));
    fs.writeFileSync(path.join(dir, "activity"), String(now - 900));

    const r = spawnSync(BASH, [WATCHER.replace(/\\/g, "/")], {
      encoding: "utf8",
      timeout: 30000,
      input: "",
      env: {
        ...process.env,
        TKR_KEEPALIVE_SKIP_ELIGIBILITY: "1",
        TKR_SESSION_ID: sid,
        TKR_STATE_DIR: stateDir,
      },
    });

    assert.equal(r.status, 0, `watcher.sh exited ${r.status}, stderr: ${r.stderr}`);

    const ledgerPath = path.join(stateDir, "keepalive-events.jsonl");
    assert.ok(fs.existsSync(ledgerPath), "expected keepalive-events.jsonl to be written");
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    const suppressed = events.find((e) => e.event === "keepalive_suppressed");
    assert.ok(suppressed, `expected a keepalive_suppressed event, got: ${JSON.stringify(events)}`);
    assert.equal(suppressed.session_id, sid);
    assert.equal(suppressed.schema_version, 2);
    assert.equal(suppressed.trigger_state.reason, "no_activity_since_last_fire");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- INV-098: TKR_KEEPALIVE_DISABLE stops the watcher itself ---
//
// The documented keepalive kill switch used to reach only the PostToolUse
// interactive-answer touch; the watcher ignored it. It must now exit
// before any state I/O — no ledger row, no lock, no fire — even from a
// state that would otherwise suppress or fire.

test("watcher.sh honors TKR_KEEPALIVE_DISABLE=1 (exit 0, no state writes, no ledger)", { skip: !BASH }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-keepalive-disable-"));
  try {
    const sid = "disable-test-sid";
    const dir = path.join(stateDir, "keepalive", sid);
    fs.mkdirSync(dir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    // Same suppress-shaped state as the gate test: without the kill switch
    // this run would emit a keepalive_suppressed ledger row.
    fs.writeFileSync(path.join(dir, "fired-at"), String(now - 300));
    fs.writeFileSync(path.join(dir, "activity"), String(now - 900));

    const r = spawnSync(BASH, [WATCHER.replace(/\\/g, "/")], {
      encoding: "utf8",
      timeout: 30000,
      input: "",
      env: {
        ...process.env,
        TKR_KEEPALIVE_DISABLE: "1",
        TKR_KEEPALIVE_SKIP_ELIGIBILITY: "1",
        TKR_SESSION_ID: sid,
        TKR_STATE_DIR: stateDir,
      },
    });

    assert.equal(r.status, 0, `watcher.sh exited ${r.status}, stderr: ${r.stderr}`);
    assert.ok(
      !fs.existsSync(path.join(stateDir, "keepalive-events.jsonl")),
      "disabled watcher must emit no ledger rows",
    );
    assert.ok(
      !fs.existsSync(path.join(dir, "watcher.pid")),
      "disabled watcher must not take the pid lock",
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- keepalive_effective_activity: transcript activity counts as activity ---
//
// Regression (2026-08-02): `activity` is written only by the activity touch on
// UserPromptSubmit, so idle was really "seconds since the last user prompt".
// An agentic turn runs for an hour with no UserPromptSubmit, so a session that
// was flat-out working looked abandoned and the watcher fired mid-task
// (observed: idle_seconds=3343 while the transcript had 231 rows that hour and
// its last append was 0.0 min before the fire).

function effective(marker, mtime) {
  const script =
    `. "${DECISION.replace(/\\/g, "/")}"; ` +
    `keepalive_effective_activity "${marker}" "${mtime}"`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim();
}

test("keepalive_effective_activity takes the later of marker and transcript", { skip: !BASH }, () => {
  assert.equal(effective(1000, 2000), "2000", "fresh transcript wins over stale prompt marker");
  assert.equal(effective(2000, 1000), "2000", "fresh prompt marker wins over stale transcript");
  assert.equal(effective(1500, 1500), "1500", "equal timestamps are stable");
});

test("keepalive_effective_activity treats missing/garbage as 0", { skip: !BASH }, () => {
  assert.equal(effective("", 1200), "1200", "missing marker falls back to transcript");
  assert.equal(effective(1200, ""), "1200", "missing transcript falls back to marker");
  assert.equal(effective("abc", "def"), "0", "garbage on both sides yields 0 (caller RESEEDs)");
  assert.equal(effective("abc", 900), "900", "garbage marker does not mask a real transcript");
});

test("a busy agentic turn no longer reads as idle", { skip: !BASH }, () => {
  const now = 1800000000;
  const threshold = 3300; // 55 min
  const marker = now - 3343; // last user prompt 55.7 min ago -> would FIRE
  const transcript = now - 5; // but the transcript was appended 5s ago
  assert.equal(decide(marker, now, threshold), "FIRE", "marker alone still fires (the bug)");
  assert.equal(
    decide(effective(marker, transcript), now, threshold),
    "WAIT",
    "effective activity keeps a working session out of the fire path",
  );
});

// --- KEEP-005: newest watcher wins the pid lock ---
//
// CC hard-kills an asyncRewake hook at spawn+3600s without running the
// EXIT trap, so the old yield-to-existing rule kept the OLDEST watcher
// (earliest kill clock) while idle restarted from the newest activity —
// an abandoned session could never fire. A spawning watcher must now take
// the lock even when the recorded pid is alive.

test("watcher.sh takes over a lock held by another (live) pid instead of yielding", { skip: !BASH }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-keepalive-lock-"));
  try {
    const sid = "takeover-test-sid";
    const dir = path.join(stateDir, "keepalive", sid);
    fs.mkdirSync(dir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    // Suppression preconditions so the watcher exits quickly AFTER the
    // lock section — reaching the keepalive_suppressed emit proves it
    // did not yield at the lock. process.pid is a genuinely live pid.
    fs.writeFileSync(path.join(dir, "fired-at"), String(now - 300));
    fs.writeFileSync(path.join(dir, "activity"), String(now - 900));
    fs.writeFileSync(path.join(dir, "watcher.pid"), String(process.pid));

    const r = spawnSync(BASH, [WATCHER.replace(/\\/g, "/")], {
      encoding: "utf8",
      timeout: 30000,
      input: "",
      env: {
        ...process.env,
        TKR_KEEPALIVE_SKIP_ELIGIBILITY: "1",
        TKR_SESSION_ID: sid,
        TKR_STATE_DIR: stateDir,
      },
    });

    assert.equal(r.status, 0, `watcher.sh exited ${r.status}, stderr: ${r.stderr}`);
    const ledgerPath = path.join(stateDir, "keepalive-events.jsonl");
    assert.ok(
      fs.existsSync(ledgerPath),
      "expected a ledger write — pre-KEEP-005 the watcher yielded at the lock and exited silently",
    );
    const events = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(
      events.find((e) => e.event === "keepalive_suppressed"),
      `expected keepalive_suppressed past the lock section, got: ${JSON.stringify(events)}`,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- KEEP-005: transcript activity ignores CC bookkeeping rows ---
//
// Resolve a python the same way watcher.sh does (resolve-python.sh handles
// the Windows Store stub hazard); skip if none resolves.

const TS_PY = path.join(__dirname, "transcript-activity.py");

function resolvePython() {
  if (!BASH) return null;
  const script =
    `. "${path.join(__dirname, "resolve-python.sh").replace(/\\/g, "/")}"; ` +
    `tkr_resolve_python`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", timeout: 30000, input: "" });
  const bin = (r.stdout || "").trim();
  return bin || null;
}
const PYBIN = resolvePython();

function transcriptActivity(rows) {
  const tmp = path.join(os.tmpdir(), `tkr-ts-fixture-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    const r = spawnSync(PYBIN, [TS_PY, tmp], { encoding: "utf8", timeout: 30000, input: "" });
    assert.equal(r.status, 0, `transcript-activity.py exited ${r.status}, stderr: ${r.stderr}`);
    return (r.stdout || "").trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// 2026-08-02T17:19:36Z / 17:22:40Z — the observed away_summary sequence.
const T_TURN = "2026-08-02T17:19:36Z";
const T_TURN_EPOCH = String(Math.floor(Date.parse("2026-08-02T17:19:36Z") / 1000));
const T_BOOKKEEPING = "2026-08-02T17:22:40.123Z";

test("transcript activity keys on the last user/assistant row, not bookkeeping", { skip: !BASH || !PYBIN }, () => {
  const got = transcriptActivity([
    { type: "user", timestamp: "2026-08-02T17:19:26Z" },
    { type: "assistant", timestamp: T_TURN },
    { type: "system", subtype: "stop_hook_summary", timestamp: "2026-08-02T17:19:36Z" },
    { type: "system", subtype: "away_summary", timestamp: T_BOOKKEEPING },
    { type: "file-history-snapshot" },
  ]);
  assert.equal(got, T_TURN_EPOCH, "away_summary must not advance the activity signal");
});

test("transcript activity survives junk lines and missing timestamps", { skip: !BASH || !PYBIN }, () => {
  const tmp = path.join(os.tmpdir(), `tkr-ts-junk-${process.pid}.jsonl`);
  fs.writeFileSync(
    tmp,
    'not json at all\n{"type":"assistant"}\n' +
      `{"type":"assistant","timestamp":"${T_TURN}"}\n`,
  );
  try {
    const r = spawnSync(PYBIN, [TS_PY, tmp], { encoding: "utf8", timeout: 30000, input: "" });
    assert.equal(r.status, 0);
    assert.equal((r.stdout || "").trim(), T_TURN_EPOCH);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("a genuinely idle session still fires", { skip: !BASH }, () => {
  const now = 1800000000;
  const threshold = 3300;
  const marker = now - 4000;
  const transcript = now - 3900; // nothing appended for 65 min either
  assert.equal(
    decide(effective(marker, transcript), now, threshold),
    "FIRE",
    "no activity from either signal must still fire",
  );
});

// --- KEEP-006: cross-session project scope ---
//
// All keepalive state was per-sid, so a watcher armed by an abandoned
// session (/clear'd — SessionEnd never fires) kept its own idle clock and
// fired while the user was active in a NEWER session of the same project
// (observed 2026-08-02T21:12Z: sid 5b545fe3 fired anchored to its own
// transcript while sid 137f11f6 had real turns 15 min earlier). Fixes:
// project last-activity resets every watcher's idle clock; project
// last-fired makes fires single-shot per project idle window.

const RESOLVE_PROJECT = path.join(__dirname, "resolve-project.sh");

function projectKey(p) {
  const script =
    `. "${RESOLVE_PROJECT.replace(/\\/g, "/")}"; ` +
    `tkr_keepalive_project_key "${p.replace(/\\/g, "/")}"`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim();
}

// The key the hook itself derives when spawned with cwd=dir: git-bash
// renders some Windows dirs through msys mounts (the Windows temp dir
// becomes /tmp/...), so a test must ask bash for ITS spelling of the cwd
// rather than normalizing the Windows spelling — mount aliases are not
// (and deliberately not) resolved by tkr_keepalive_project_key. Real
// project cwds (/c/Users/... vs C:\Users\...) normalize identically; the
// alias only bites under the msys mount points, i.e. in tests.
function bashCwdKey(dir) {
  const r = spawnSync(BASH, ["-c", 'echo "$PWD"'], { cwd: dir, encoding: "utf8", timeout: 5000 });
  return projectKey((r.stdout || "").trim());
}

test("project key: CC payload spelling and git-bash spelling agree", { skip: !BASH }, () => {
  assert.equal(
    projectKey("C:\\Users\\Dev\\proj"),
    projectKey("/c/Users/Dev/proj"),
    "the two Windows spellings of one cwd must map to one key",
  );
  assert.equal(projectKey("/home/dev/proj"), projectKey("/home/dev/proj/"), "trailing slash is normalized");
  assert.notEqual(projectKey("/home/dev/proj"), projectKey("/home/dev/proj2"), "distinct projects stay distinct");
  assert.equal(projectKey(""), "", "empty cwd yields empty key (gate skipped, never a shared bucket)");
});

test("stale own signals + fresh project activity → WAIT (cross-session idle reset)", { skip: !BASH }, () => {
  const now = 1800000000;
  const threshold = 3300;
  const own = effective(now - 3400, now - 3400); // own session idle past threshold
  const project = now - 60; // but another session in this project just had a prompt
  assert.equal(decide(own, now, threshold), "FIRE", "own signals alone would fire (the bug)");
  assert.equal(
    decide(effective(own, project), now, threshold),
    "WAIT",
    "project activity keeps the stale watcher out of the fire path",
  );
});

test("watcher.sh fire stamps project last-fired and records project_key", { skip: !BASH }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-keepalive-projfire-"));
  try {
    const sid = "proj-fire-sid";
    const dir = path.join(stateDir, "keepalive", sid);
    fs.mkdirSync(dir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(dir, "activity"), String(now - 900));

    const r = spawnSync(BASH, [WATCHER.replace(/\\/g, "/")], {
      encoding: "utf8",
      timeout: 30000,
      input: "",
      cwd: stateDir,
      env: {
        ...process.env,
        TKR_KEEPALIVE_SKIP_ELIGIBILITY: "1",
        TKR_KEEPALIVE_IDLE_MIN: "0",
        TKR_KEEPALIVE_TRANSCRIPT: path.join(stateDir, "none.jsonl"),
        TKR_STATUSLINE_PATH: path.join(stateDir, "none.json"),
        TKR_SESSION_ID: sid,
        TKR_STATE_DIR: stateDir,
      },
    });

    assert.equal(r.status, 2, `expected wake exit 2, got ${r.status}, stderr: ${r.stderr}`);
    assert.match(r.stderr || "", /INTENTIONAL keepalive wake/);

    const key = bashCwdKey(stateDir);
    assert.ok(key, "test cwd must resolve to a non-empty key");
    const lastFired = path.join(stateDir, "keepalive-projects", key, "last-fired");
    assert.ok(fs.existsSync(lastFired), "fire must stamp keepalive-projects/<key>/last-fired");

    const events = fs
      .readFileSync(path.join(stateDir, "keepalive-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const fired = events.find((e) => e.event === "keepalive_fired");
    assert.ok(fired, `expected keepalive_fired, got: ${JSON.stringify(events)}`);
    assert.equal(fired.trigger_state.project_key, key, "fire event must carry the project key");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("watcher.sh suppresses when another watcher in the project already fired this idle window", { skip: !BASH }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-keepalive-projgate-"));
  try {
    const sid = "proj-gate-sid";
    const dir = path.join(stateDir, "keepalive", sid);
    fs.mkdirSync(dir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    // Own session: idle past threshold, never fired itself.
    fs.writeFileSync(path.join(dir, "activity"), String(now - 900));
    // Project: a sibling watcher fired 5 min ago; last genuine prompt
    // predates that fire — the idle window is already spent.
    const key = bashCwdKey(stateDir);
    const projDir = path.join(stateDir, "keepalive-projects", key);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "last-fired"), String(now - 300));
    fs.writeFileSync(path.join(projDir, "last-activity"), String(now - 900));

    const r = spawnSync(BASH, [WATCHER.replace(/\\/g, "/")], {
      encoding: "utf8",
      timeout: 30000,
      input: "",
      cwd: stateDir,
      env: {
        ...process.env,
        TKR_KEEPALIVE_SKIP_ELIGIBILITY: "1",
        TKR_KEEPALIVE_IDLE_MIN: "0",
        TKR_KEEPALIVE_TRANSCRIPT: path.join(stateDir, "none.jsonl"),
        TKR_STATUSLINE_PATH: path.join(stateDir, "none.json"),
        TKR_SESSION_ID: sid,
        TKR_STATE_DIR: stateDir,
      },
    });

    assert.equal(r.status, 0, `expected suppressed exit 0, got ${r.status}, stderr: ${r.stderr}`);
    assert.ok(
      !fs.existsSync(path.join(dir, "fired-at")),
      "suppressed watcher must not stamp its own fired-at",
    );
    const events = fs
      .readFileSync(path.join(stateDir, "keepalive-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const sup = events.find((e) => e.event === "keepalive_suppressed");
    assert.ok(sup, `expected keepalive_suppressed, got: ${JSON.stringify(events)}`);
    assert.equal(sup.trigger_state.reason, "project_fire_since_last_activity");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
