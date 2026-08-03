#!/usr/bin/env node
// Observe mode injects nothing (native-work-routing PR 2 acceptance).
//
// PR 2 makes work plans VISIBLE — on the statusline, in the decision
// ledger, through `tkr route stats`. It must not make them AUDIBLE: no
// part of a plan may reach the model's context. The coordinator directive
// is PR 3's job, behind mode=advisory.
//
// So this file asserts an absence, which is exactly the kind of property
// that rots silently. It is written so PR 3 has to change it deliberately:
// when advisory ships, the advisory cases below flip and the observe cases
// must keep passing unchanged.
//
// Run: node hooks/user-prompt-submit.work-observe.test.js

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// Must precede the hook require: user-prompt-submit.js resolves its state
// dir once at module init.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-work-observe-test-"));
process.env.TKR_STATE_DIR = STATE_DIR;

const test = require("node:test");
const assert = require("node:assert");

const {
  routeInjectContext,
  shapeNudgeContext,
} = require("./user-prompt-submit.js");
const routeState = require("./lib/route-state.js");

const SID = "sess-work-observe";
const PROMPT = "Summarize the release notes in CHANGELOG.md";

// Tokens that would mean a plan leaked into the model's context. Any of
// these appearing is the failure, whichever channel produced it.
const WORK_TOKENS = [
  "tkr:explore-haiku",
  "tkr:implement-sonnet",
  "tkr:debug-sonnet",
  "native_subagent",
  "work_plan",
  "worker",
  "wr-",
  "WRK:",
];

function assertSilent(text, label) {
  const s = String(text || "");
  for (const token of WORK_TOKENS) {
    assert.ok(
      !s.includes(token),
      `${label}: work-routing token ${JSON.stringify(token)} reached the context: ${JSON.stringify(s)}`,
    );
  }
}

// writeState plants the state doc internal/route/state.go persists,
// carrying a NATIVE work plan. Without the plan the silence assertions
// would pass vacuously.
function writeState(mode) {
  const doc = {
    schema_version: routeState.STATE_SCHEMA_VERSION,
    session_id: SID,
    prompt_hash: crypto.createHash("sha1").update(PROMPT).digest("hex"),
    active_model: "claude-opus-5",
    written_at: new Date().toISOString(),
    plan_id: "wr-1770000000-abc123",
    classification: {
      active_model: "claude-opus-5",
      model: "claude-opus-5",
      effort: "low",
      confidence: "high",
      why: "task-class=summarization_docs",
      scope: "main",
      task_class: "summarization_docs",
    },
    shape: {
      shape: "narrow_reversible",
      high_stakes: false,
      confidence: "high",
      read_only: true,
      recommendation: { effort: "low" },
    },
    work_plan: {
      schema_version: 1,
      plan_id: "wr-1770000000-abc123",
      disposition: "native_subagent",
      trigger: "task_shape",
      agent_profile: "tkr:explore-haiku",
      worker_model: "haiku",
      worker_effort: "none",
      max_turns: 8,
      main_role: "review",
      verification: "evidence_only",
      confidence: "high",
      reason: "premium_main_bounded_reversible",
      mode,
    },
  };
  const fp = routeState.routeStatePath(SID);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(doc));
  return fp;
}

function hookInput() {
  return { prompt: PROMPT, session_id: SID, cwd: process.cwd() };
}

// Env shared by every case. TKR_ROUTE_SYNC=0 keeps the planted state
// intact: the sync path re-runs `tkr route classify`, which would
// overwrite it with whatever the installed binary decides (or nothing, if
// tkr is not on PATH). The property under test is about what the hook
// EMITS from a plan, not about how the plan got there.
function baseEnv(mode) {
  return {
    ...process.env,
    TKR_STATE_DIR: STATE_DIR,
    TKR_SESSION_ID: SID,
    TKR_ROUTE_SYNC: "0",
    TKR_WORK_ROUTE_MODE: mode,
    CLAUDE_MODEL: "claude-opus-5",
  };
}

function withEnv(mode, fn) {
  const saved = {};
  const env = baseEnv(mode);
  for (const k of ["TKR_SESSION_ID", "TKR_ROUTE_SYNC", "TKR_WORK_ROUTE_MODE", "CLAUDE_MODEL"]) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── The injection functions ─────────────────────────────────────────────────

test("observe: routeInjectContext says nothing about the work plan", () => {
  writeState("observe");
  withEnv("observe", () => {
    assertSilent(routeInjectContext(hookInput(), {}), "routeInjectContext");
  });
});

test("observe: shapeNudgeContext says nothing about the work plan", () => {
  writeState("observe");
  withEnv("observe", () => {
    assertSilent(shapeNudgeContext(hookInput(), {}), "shapeNudgeContext");
  });
});

// PR 3 shipped, and this case changed deliberately — which is what the
// header above asked for.
//
// What did NOT change: routeInjectContext and shapeNudgeContext still say
// nothing about work plans in ANY mode. Those two own the main session's
// effort and model, and the directive is a separate channel
// (workRouteContext) precisely so that acting on a plan can never be
// mistaken for changing the main session's standing preferences. The
// plan's §10.3 requires exactly that separation.
//
// The directive's own advisory behavior lives in
// user-prompt-submit.work-advisory.test.js.
test("advisory: the effort/model channels still say nothing about work", () => {
  writeState("advisory");
  withEnv("advisory", () => {
    assertSilent(routeInjectContext(hookInput(), {}), "routeInjectContext/advisory");
    assertSilent(shapeNudgeContext(hookInput(), {}), "shapeNudgeContext/advisory");
  });
});

// ── The whole hook ──────────────────────────────────────────────────────────

// The function-level tests above only cover the two channels that exist
// today. This one covers everything the hook can emit, so a plan leaking
// through some future third channel fails here even if nobody remembers to
// extend WORK_TOKENS' callers.
test("observe: the full hook response carries no plan", () => {
  writeState("observe");
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, "user-prompt-submit.js")],
    {
      input: JSON.stringify(hookInput()),
      env: baseEnv("observe"),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  assertSilent(res.stdout, "hook stdout");

  // And the response is still well-formed JSON — silence must come from
  // emitting nothing about work routing, not from the hook falling over.
  const parsed = JSON.parse(res.stdout || "{}");
  assert.strictEqual(typeof parsed, "object");
});

// ── The plant itself ────────────────────────────────────────────────────────

// Guards the guard: if the state stops carrying a native plan, every
// assertion above passes for the wrong reason.
test("the fixture really does carry a native plan", () => {
  const fp = writeState("observe");
  const doc = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.strictEqual(doc.work_plan.disposition, "native_subagent");
  assert.strictEqual(doc.work_plan.agent_profile, "tkr:explore-haiku");

  // And the hook's own reader accepts it — a doc the validator rejects
  // would make the silence tests vacuous in a way inspecting the file
  // cannot reveal.
  const read = routeState.readRouteState(SID, {
    promptHash: crypto.createHash("sha1").update(PROMPT).digest("hex"),
    model: "claude-opus-5",
  });
  assert.ok(read, "route-state reader rejected the fixture");
  assert.strictEqual(read.work_plan.disposition, "native_subagent");
});

test.after(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
});
