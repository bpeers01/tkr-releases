#!/usr/bin/env node
// Tests for the keepalive interactive-answer touch — issue #152 item 2.
//
// The bug: `activityTouch` had exactly one caller (UserPromptSubmit). An
// AskUserQuestion answer arrives as a tool_result, so on answer the activity
// marker was never advanced and the per-session `fired-at` file was never
// cleared — the watcher stayed disarmed-but-fired until the next TYPED
// prompt, and a later fire could stack on a session the human was actively
// working in.
//
// Two things are pinned here, and they pull in opposite directions:
//
//   1. The answer DOES re-arm — including when `fired-at` is seconds old,
//      which is the reported failure and the case activityTouch's recency
//      guard (guard 2/2b) declines by design.
//   2. Nothing else re-arms. The invariant is "only a human can advance the
//      marker", so every non-human route into this path — a subagent
//      sidechain, an ordinary tool result, a PreToolUse, a call with no
//      response — must be a no-op.
//
// Run: node --test hooks/lib/keepalive-interactive-answer.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  interactiveAnswerTouch,
  isInteractiveHumanAnswer,
  keepaliveProjectKey,
  INTERACTIVE_TOOLS,
  WAKE_SENTINEL,
} = require("./keepalive-activity");

const POSTTOOL_HOOK = path.join(__dirname, "..", "post-tool-call.js");
const SID = "testsid";

function mkState(sid = SID) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ka-answer-"));
  const dir = path.join(root, "keepalive", sid);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

const now = () => Math.floor(Date.now() / 1000);

// A PostToolUse payload for an answered AskUserQuestion, as the plugin's
// unmatched PostToolUse entry receives it.
function answerEvent(overrides = {}) {
  return {
    hook_event_name: "PostToolUse",
    session_id: SID,
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which client_code for prod?" }] },
    tool_response: { answers: { "Which client_code for prod?": "acme" } },
    ...overrides,
  };
}

// Drive the touch with a temp TKR_STATE_DIR, restoring env after.
function touch(data, { stateDir, sid = SID, rawInput } = {}) {
  const saved = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = stateDir;
  try {
    return interactiveAnswerTouch({
      rawInput: rawInput === undefined ? JSON.stringify(data) : rawInput,
      data,
      sid,
    });
  } finally {
    if (saved === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = saved;
  }
}

function assertRearmed(dir, label) {
  const a = parseInt(fs.readFileSync(path.join(dir, "activity"), "utf8").trim(), 10);
  assert.ok(Math.abs(now() - a) <= 10, `${label}: activity bumped to ~now (got ${a})`);
  assert.ok(!fs.existsSync(path.join(dir, "fired-at")), `${label}: fired-at cleared`);
}

function assertUntouched(dir, label) {
  assert.equal(
    fs.readFileSync(path.join(dir, "activity"), "utf8").trim(),
    "100",
    `${label}: activity unchanged`,
  );
  assert.ok(fs.existsSync(path.join(dir, "fired-at")), `${label}: fired-at preserved`);
}

// --- The fix: an answer re-arms, even inside the re-arm grace window ---

test("the reported failure: answer seconds after a fire clears fired-at and bumps activity", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  // Fired 5s ago — well inside DEFAULT_REARM_GRACE_SEC (180). This is the
  // exact state the live session was left in.
  fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));

  assert.equal(touch(answerEvent(), { stateDir: root }), true, "touch reports it fired");
  assertRearmed(dir, "fresh fired-at");
  fs.rmSync(root, { recursive: true, force: true });
});

test("ExitPlanMode approval counts too (same list as transcript-activity.py)", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));

  const ev = answerEvent({
    tool_name: "ExitPlanMode",
    tool_input: { plan: "1. do the thing" },
    tool_response: "The user has approved your plan.",
  });
  assert.equal(touch(ev, { stateDir: root }), true);
  assertRearmed(dir, "ExitPlanMode");
  fs.rmSync(root, { recursive: true, force: true });
});

test("INTERACTIVE_TOOLS matches the python side's tuple exactly", () => {
  const py = fs.readFileSync(
    path.join(__dirname, "..", "keepalive", "transcript-activity.py"),
    "utf8",
  );
  const m = py.match(/^INTERACTIVE_TOOLS\s*=\s*\(([^)]*)\)/m);
  assert.ok(m, "transcript-activity.py must declare INTERACTIVE_TOOLS");
  const pyTools = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(
    [...INTERACTIVE_TOOLS].sort(),
    pyTools.sort(),
    "item 1 (suppress while pending) and item 2 (re-arm on answer) must cover the same tools",
  );
});

test("answer stamps project last-activity (cross-session idle reset, KEEP-006)", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");

  assert.equal(touch(answerEvent({ cwd: root }), { stateDir: root }), true);

  const key = keepaliveProjectKey(root);
  assert.ok(key, "test cwd must resolve to a non-empty key");
  const la = path.join(root, "keepalive-projects", key, "last-activity");
  assert.ok(fs.existsSync(la), "project last-activity must be stamped");
  const a = parseInt(fs.readFileSync(la, "utf8").trim(), 10);
  assert.ok(Math.abs(now() - a) <= 10, "project last-activity ~now");
  fs.rmSync(root, { recursive: true, force: true });
});

// --- The invariant: only a human advances the marker ---

test("ordinary agentic tool results do not advance the marker", () => {
  const { root, dir } = mkState();
  for (const toolName of ["Bash", "Read", "Edit", "Agent", "Task", "Skill"]) {
    fs.writeFileSync(path.join(dir, "activity"), "100");
    fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));
    assert.equal(
      touch(answerEvent({ tool_name: toolName }), { stateDir: root }),
      false,
      `${toolName} must not touch`,
    );
    assertUntouched(dir, toolName);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("subagent sidechain traffic does not advance the coordinator's marker", () => {
  const { root, dir } = mkState();
  // A sidechain shares the coordinator's session_id, so the marker it would
  // reach is the human's own. Each documented marker must be sufficient on
  // its own.
  const markers = [
    { agent_id: "a6b3234fa669e5d3b" },
    { agent_type: "Explore" },
    { scope: "subagent" },
    { subagent_type: "tkr:explore-haiku" },
  ];
  for (const marker of markers) {
    fs.writeFileSync(path.join(dir, "activity"), "100");
    fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));
    assert.equal(
      touch(answerEvent(marker), { stateDir: root }),
      false,
      `${JSON.stringify(marker)} must not touch`,
    );
    assertUntouched(dir, JSON.stringify(marker));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a coordinator dispatching a worker is main-session traffic (tool_input.subagent_type ignored)", () => {
  // The SPAWN TARGET is not a subagent marker — but the tool is Agent, so
  // this is rejected on the tool name, not mistaken for an answer.
  assert.equal(
    isInteractiveHumanAnswer({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore" },
      tool_response: { ok: true },
    }),
    false,
  );
});

test("PreToolUse is not an answer — the question has not been asked yet", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));

  // The realistic shape: PreToolUse carries no tool_response.
  assert.equal(
    touch(answerEvent({ hook_event_name: "PreToolUse", tool_response: undefined }), {
      stateDir: root,
    }),
    false,
  );
  assertUntouched(dir, "PreToolUse");

  // And the event name alone is disqualifying, so a future payload that
  // carries something response-shaped before the human has acted still
  // cannot re-arm — the response-evidence check is not the only thing
  // standing between a mis-wiring and a false re-arm.
  assert.equal(
    touch(answerEvent({ hook_event_name: "PreToolUse" }), { stateDir: root }),
    false,
  );
  assertUntouched(dir, "PreToolUse with a response");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a call that never reached a human (no/empty/errored response) does not re-arm", () => {
  const { root, dir } = mkState();
  const cases = [
    ["absent", undefined],
    ["null", null],
    ["empty string", "   "],
    ["empty object", {}],
    ["empty array", []],
    ["error object", { error: "user interrupted before answering" }],
    ["is_error flag", { is_error: true, content: "tool cancelled" }],
  ];
  for (const [label, resp] of cases) {
    fs.writeFileSync(path.join(dir, "activity"), "100");
    fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));
    assert.equal(
      touch(answerEvent({ tool_response: resp }), { stateDir: root }),
      false,
      `${label} must not touch`,
    );
    assertUntouched(dir, label);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard 1 survives: a payload carrying the wake sentinel never re-arms", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));

  const ev = answerEvent();
  assert.equal(
    touch(ev, { stateDir: root, rawInput: `${WAKE_SENTINEL} ${JSON.stringify(ev)}` }),
    false,
  );
  assertUntouched(dir, "wake sentinel");
  fs.rmSync(root, { recursive: true, force: true });
});

// --- e2e: the touch actually fires from post-tool-call.js ---
//
// The wiring half of the fix. Without a registered caller the module change
// above is inert — which was the whole bug — so this must be driven through
// the real hook process, not the exported function.

function runPostTool(data, { stateDir, env = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ka-pt-"));
  const r = spawnSync(process.execPath, [POSTTOOL_HOOK], {
    input: JSON.stringify(data),
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      TKR_STATE_DIR: stateDir,
      TKR_STATUSLINE_PATH: path.join(tmp, "claude-statusline.json"),
      ...env,
    },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

test("e2e: post-tool-call.js performs the touch on an AskUserQuestion answer", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));

  const r = runPostTool(answerEvent({ cwd: root }), { stateDir: root });
  assert.equal(r.status, 0, `hook exited 0 (stderr: ${r.stderr})`);
  assertRearmed(dir, "e2e");
  fs.rmSync(root, { recursive: true, force: true });
});

test("e2e: an ordinary Bash tool result leaves the marker alone", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));

  const r = runPostTool(
    {
      hook_event_name: "PostToolUse",
      session_id: SID,
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "hi\n" },
    },
    { stateDir: root },
  );
  assert.equal(r.status, 0, `hook exited 0 (stderr: ${r.stderr})`);
  assertUntouched(dir, "e2e Bash");
  fs.rmSync(root, { recursive: true, force: true });
});

test("e2e: TKR_KEEPALIVE_DISABLE=1 suppresses the touch", () => {
  const { root, dir } = mkState();
  fs.writeFileSync(path.join(dir, "activity"), "100");
  fs.writeFileSync(path.join(dir, "fired-at"), String(now() - 5));

  const r = runPostTool(answerEvent({ cwd: root }), {
    stateDir: root,
    env: { TKR_KEEPALIVE_DISABLE: "1" },
  });
  assert.equal(r.status, 0, `hook exited 0 (stderr: ${r.stderr})`);
  assertUntouched(dir, "kill switch");
  fs.rmSync(root, { recursive: true, force: true });
});
