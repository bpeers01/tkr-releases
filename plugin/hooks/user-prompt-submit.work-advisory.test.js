#!/usr/bin/env node
// Advisory mode: the same-turn coordinator directive (native-work-routing
// PR 3 §10).
//
// The sibling file user-prompt-submit.work-observe.test.js asserts an
// ABSENCE — no work plan reaches the model below advisory. This file
// asserts the presence, and then spends most of its length re-asserting
// absence under every condition plan §10.3 says must stay silent. That
// ratio is deliberate: a directive that fires when it should is one test,
// and a directive that fires when it should NOT is the failure mode with a
// cost.
//
// Run: node --test hooks/user-prompt-submit.work-advisory.test.js

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// Must precede the hook require: user-prompt-submit.js resolves its state
// dir once at module init.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-work-advisory-test-"));
process.env.TKR_STATE_DIR = STATE_DIR;

const test = require("node:test");
const assert = require("node:assert");

const {
  workRouteContext,
  workProfileInstalled,
  routeInjectContext,
  shapeNudgeContext,
} = require("./user-prompt-submit.js");
const routeState = require("./lib/route-state.js");

const SID = "sess-work-advisory";
const PROMPT = "Summarize the release notes in CHANGELOG.md";
const PLAN_ID = "wr-1770000000-abc123";
const PROFILE = "tkr:explore-haiku";

// An agents/ directory with the one profile today's policy can name.
// Without this the directive is silent by rule 8, which is correct but
// would make every positive case below vacuous.
const AGENTS_DIR = path.join(STATE_DIR, "agents");
fs.mkdirSync(AGENTS_DIR, { recursive: true });
fs.writeFileSync(path.join(AGENTS_DIR, "explore-haiku.md"), "# explore-haiku\n");

// writeState plants the doc internal/route/state.go persists. overrides is
// shallow-merged into work_plan so each case states only what it changes.
function writeState(mode, overrides, stateOverrides) {
  const doc = {
    schema_version: routeState.STATE_SCHEMA_VERSION,
    session_id: SID,
    prompt_hash: crypto.createHash("sha1").update(PROMPT).digest("hex"),
    active_model: "claude-opus-5",
    written_at: new Date().toISOString(),
    plan_id: PLAN_ID,
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
      plan_id: PLAN_ID,
      disposition: "native_subagent",
      trigger: "task_shape",
      agent_profile: PROFILE,
      worker_model: "haiku",
      worker_effort: "none",
      max_turns: 8,
      main_role: "review",
      verification: "evidence_only",
      confidence: "high",
      reason: "premium_main_bounded_reversible",
      mode,
      ...(overrides || {}),
    },
    ...(stateOverrides || {}),
  };
  const fp = routeState.routeStatePath(SID);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(doc));
  return fp;
}

function hookInput(extra) {
  return { prompt: PROMPT, session_id: SID, cwd: process.cwd(), ...(extra || {}) };
}

const TEL = { model_id: "claude-opus-5" };

// withEnv sets env for one call and restores it, so a failing assertion
// cannot leak state into the next test.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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

function advisoryEnv(extra) {
  return {
    TKR_SESSION_ID: SID,
    TKR_WORK_AGENTS_DIR: AGENTS_DIR,
    TKR_HOOKS_DISABLED: undefined,
    TKR_ROUTE_DISABLED: undefined,
    TKR_WORK_ROUTE_DISABLED: undefined,
    ...(extra || {}),
  };
}

// directive runs workRouteContext under advisory-shaped env.
function directive(input, envExtra) {
  return withEnv(advisoryEnv(envExtra), () => workRouteContext(input || hookInput(), TEL));
}

// ── It fires, and says the right thing ──────────────────────────────────────

test("advisory: the directive is emitted for a native plan", () => {
  writeState("advisory");
  const out = directive();
  assert.ok(out, "expected a directive, got empty");
  assert.match(out, /^\[tkr worker id=wr-1770000000-abc123: tkr:explore-haiku; /);
  assert.match(out, /shape=narrow_reversible/);
  assert.match(out, /main=review/);
  assert.match(out, /verify=evidence_only/);
  assert.ok(out.endsWith("]"), `unterminated directive: ${out}`);
});

test("assisted and managed are actionable too", () => {
  for (const mode of ["assisted", "managed"]) {
    writeState(mode);
    assert.ok(directive(), `mode=${mode} should emit a directive`);
  }
});

// §10.2: "Do not inject full JSON." A directive that grows a payload is
// how a compact standing line turns into a per-prompt context tax.
test("the directive stays a compact single line", () => {
  writeState("advisory");
  const out = directive();
  assert.ok(!out.includes("\n"), `directive must be one line: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("{"), `directive must not carry JSON: ${out}`);
  assert.ok(
    Buffer.byteLength(out, "utf8") <= 200,
    `directive is ${Buffer.byteLength(out, "utf8")} bytes; budget is 200`,
  );
});

// ── Same turn, not three turns later (§10.3) ────────────────────────────────

// The sustained-mismatch rule that governs main-session effort/model needs
// ROUTE_STREAK_MIN consecutive prompts. Worker delegation must not: by the
// third prompt the work is done. One planted state, one call, one
// directive — no streak file, no priming turns.
test("the directive needs no streak — it fires on the first prompt", () => {
  writeState("advisory");
  // Prove there is no per-session streak state for this to have consumed.
  for (const f of fs.readdirSync(STATE_DIR)) {
    assert.ok(
      !f.startsWith("route-nudge-"),
      `a nudge-streak file exists (${f}); the directive must not depend on one`,
    );
  }
  assert.ok(directive(), "first prompt must already carry the directive");
});

// ── Everything that must stay silent (§10.3) ────────────────────────────────

test("stay_main emits nothing", () => {
  writeState("advisory", { disposition: "stay_main", agent_profile: "", reason: "shape_not_routable" });
  assert.strictEqual(directive(), "");
});

test("off and observe emit nothing", () => {
  for (const mode of ["off", "observe", ""]) {
    writeState(mode);
    assert.strictEqual(directive(), "", `mode=${JSON.stringify(mode)} must stay silent`);
  }
});

test("an unknown mode emits nothing — unknown is not permission", () => {
  writeState("supervised");
  assert.strictEqual(directive(), "");
});

test("low confidence emits nothing", () => {
  writeState("advisory", { confidence: "low" });
  assert.strictEqual(directive(), "");
});

test("high stakes emits nothing", () => {
  writeState("advisory", { high_stakes: true });
  assert.strictEqual(directive(), "");
});

test("a disabled classification emits nothing", () => {
  writeState("advisory", null, { classification: { disabled: true } });
  assert.strictEqual(directive(), "");
});

test("a non-Anthropic backend emits nothing", () => {
  writeState("advisory", null, { active_model: "gpt-4o" });
  // The model hint must agree, or readRouteState rejects the doc first and
  // the test would pass without ever reaching the backend check.
  const out = withEnv(advisoryEnv(), () =>
    workRouteContext(hookInput(), { model_id: "gpt-4o" }),
  );
  assert.strictEqual(out, "");
});

test("a subagent dispatch emits nothing — a worker must not spawn a worker", () => {
  writeState("advisory");
  assert.strictEqual(directive(hookInput({ subagent_type: "Explore" })), "");
  assert.strictEqual(directive(hookInput({ scope: "subagent" })), "");
});

// INV-074 residue: computeWorkRouteDirective previously hand-rolled only the
// two undocumented mirrors (subagent_type/scope) and never gated on the
// documented agent_id/agent_type markers. Now routed through
// lib/subagent-context.js's isSubagentContext; the neither-marker case
// (proving the directive still fires normally) is covered above by
// "advisory: the directive is emitted for a native plan".
test("agent_id/agent_type also emit nothing (INV-074)", () => {
  writeState("advisory");
  assert.strictEqual(directive(hookInput({ agent_id: "a1" })), "");
  assert.strictEqual(directive(hookInput({ agent_type: "Explore" })), "");
});

test("kill switches emit nothing", () => {
  writeState("advisory");
  for (const key of ["TKR_HOOKS_DISABLED", "TKR_ROUTE_DISABLED", "TKR_WORK_ROUTE_DISABLED"]) {
    assert.strictEqual(directive(undefined, { [key]: "1" }), "", `${key}=1 must silence it`);
  }
});

test("a prompt the plan was not written for emits nothing", () => {
  writeState("advisory");
  const other = { ...hookInput(), prompt: "something else entirely" };
  assert.strictEqual(directive(other), "");
});

test("another session's state emits nothing", () => {
  writeState("advisory");
  assert.strictEqual(directive({ ...hookInput(), session_id: "sess-somebody-else" }), "");
});

test("an expired plan emits nothing", () => {
  const stale = new Date(Date.now() - (routeState.STATE_TTL_SECS + 60) * 1000).toISOString();
  writeState("advisory", null, { written_at: stale });
  assert.strictEqual(directive(), "");
});

test("a plan with no id emits nothing — an unjoinable directive is unauditable", () => {
  writeState("advisory", { plan_id: "" }, { plan_id: "" });
  assert.strictEqual(directive(), "");
});

// ── Rule 8: the profile has to exist ────────────────────────────────────────

// This is the rule that keeps PR 3 safe to ship before PR 4. `tkr route
// classify` builds plans with route.AllProfiles() — every profile marked
// present — which is right for "what WOULD policy choose" but wrong for a
// directive telling the model to invoke one.
test("an uninstalled profile emits nothing", () => {
  writeState("advisory");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-no-agents-"));
  assert.strictEqual(directive(undefined, { TKR_WORK_AGENTS_DIR: empty }), "");
});

test("a profile naming a path outside agents/ emits nothing", () => {
  for (const bad of ["tkr:../../etc/passwd", "tkr:", "../evil", "tkr:has space"]) {
    assert.strictEqual(
      withEnv(advisoryEnv(), () => workProfileInstalled(bad)),
      false,
      `${JSON.stringify(bad)} must not resolve to an installed profile`,
    );
  }
});

test("a plan missing shape, main role, or verification emits nothing", () => {
  writeState("advisory", { main_role: "" });
  assert.strictEqual(directive(), "");
  writeState("advisory", { verification: "" });
  assert.strictEqual(directive(), "");
  writeState("advisory", null, { shape: { shape: "", high_stakes: false } });
  assert.strictEqual(directive(), "");
});

// ── The channels stay separate ──────────────────────────────────────────────

// §10.3: "The existing three-turn sustained mismatch rule remains
// unchanged for main-model or main-effort changes." The directive is a
// different channel, and the effort/model channels must not learn about
// work plans just because one exists.
test("effort and model channels are unaffected by an actionable plan", () => {
  writeState("advisory");
  withEnv(advisoryEnv({ TKR_ROUTE_SYNC: "0" }), () => {
    for (const [label, out] of [
      ["routeInjectContext", routeInjectContext(hookInput(), TEL)],
      ["shapeNudgeContext", shapeNudgeContext(hookInput(), TEL)],
    ]) {
      const s = String(out || "");
      for (const token of ["tkr worker", "wr-", PROFILE, "native_subagent"]) {
        assert.ok(!s.includes(token), `${label} leaked ${JSON.stringify(token)}: ${s}`);
      }
    }
  });
});

// ── No new subprocess on the hot path ───────────────────────────────────────

// Asserted behaviorally rather than with a timer, which would be flaky in
// CI and would not actually pin the property. routeInjectContext already
// ran `tkr route classify` for this prompt; the directive reads what that
// wrote. With an empty PATH the binary cannot be found at all, so a
// directive still appearing proves this function never needed it.
test("the directive needs no tkr binary — it reads, it does not classify", () => {
  writeState("advisory");
  const out = directive(undefined, { PATH: "", TKR_ROUTE_SYNC: "0" });
  assert.ok(out, "directive must come from state alone, with no binary available");
});

// ── End to end through the real hook ────────────────────────────────────────

test("the assembled hook response carries the directive exactly once", () => {
  writeState("advisory");
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, "user-prompt-submit.js")],
    {
      input: JSON.stringify(hookInput()),
      env: {
        ...process.env,
        TKR_STATE_DIR: STATE_DIR,
        TKR_SESSION_ID: SID,
        TKR_WORK_AGENTS_DIR: AGENTS_DIR,
        // Keep the planted state: the sync path would re-classify and
        // overwrite it with whatever the installed binary decides.
        TKR_ROUTE_SYNC: "0",
        CLAUDE_MODEL: "claude-opus-5",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout || "{}");
  const ctx = String(
    (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || "",
  );
  const hits = ctx.split("[tkr worker ").length - 1;
  assert.strictEqual(hits, 1, `expected exactly one directive, found ${hits}: ${ctx}`);
});

// ── The injected half of "was the plan followed?" ───────────────────────────

// decisions.jsonl records which plan the POLICY chose; it cannot record
// whether the model was ever told. A follow-rate computed from plans alone
// would divide by directives that never went out.
test("the injection log records the plan id of a directive that went out", () => {
  writeState("advisory");
  const logPath = path.join(STATE_DIR, "injection-events.jsonl");
  try {
    fs.unlinkSync(logPath);
  } catch {}

  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, "user-prompt-submit.js")],
    {
      input: JSON.stringify(hookInput()),
      env: {
        ...process.env,
        TKR_STATE_DIR: STATE_DIR,
        TKR_SESSION_ID: SID,
        TKR_WORK_AGENTS_DIR: AGENTS_DIR,
        TKR_ROUTE_SYNC: "0",
        CLAUDE_MODEL: "claude-opus-5",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);

  const rows = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(rows.length > 0, "expected an injection-log row");
  assert.strictEqual(rows[rows.length - 1].wr, PLAN_ID);
});

test("no directive means no plan id on the row — absence is the signal", () => {
  // stay_main: a plan exists and is logged in decisions.jsonl, but nothing
  // was injected. A row carrying wr here would inflate the denominator's
  // numerator, which is the exact error this field exists to prevent.
  writeState("advisory", { disposition: "stay_main", agent_profile: "" });
  const logPath = path.join(STATE_DIR, "injection-events.jsonl");
  try {
    fs.unlinkSync(logPath);
  } catch {}

  spawnSync(process.execPath, [path.join(__dirname, "user-prompt-submit.js")], {
    input: JSON.stringify(hookInput()),
    env: {
      ...process.env,
      TKR_STATE_DIR: STATE_DIR,
      TKR_SESSION_ID: SID,
      TKR_WORK_AGENTS_DIR: AGENTS_DIR,
      TKR_ROUTE_SYNC: "0",
      CLAUDE_MODEL: "claude-opus-5",
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  const rows = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(rows.length > 0, "expected an injection-log row");
  assert.strictEqual(rows[rows.length - 1].wr, undefined);
});

// ── The durable directive ledger (PR 5A §14) ────────────────────────────────
//
// The injection log above is per-session and answers "did this turn's
// directive go out?". The funnel needs the other question — "how many
// directives has this feature ever emitted?" — because that is the
// denominator for follow rate, and the most damning outcome a directive
// can have is producing no spawn at all. A denominator built from spawns
// cannot see those turns, so it would report a follow rate that can only
// go up.

function workDirectiveRows() {
  const p = path.join(STATE_DIR, "decisions.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.event === "work-directive");
}

test("an emitted directive leaves a durable ledger row", () => {
  writeState("advisory");
  const before = workDirectiveRows().length;
  const out = directive(hookInput({ prompt_id: "pr-advisory-1" }));
  assert.ok(out, "precondition: the directive must have been emitted");

  const rows = workDirectiveRows();
  assert.strictEqual(rows.length, before + 1);
  const r = rows[rows.length - 1];
  assert.strictEqual(r.plan_id, PLAN_ID);
  assert.strictEqual(r.session_id, SID);
  assert.strictEqual(r.prompt_id, "pr-advisory-1");
  // The profile is parsed back out of the text that actually went out, so
  // the row describes what the model was told rather than what the plan
  // said — those diverge the moment the directive format changes.
  assert.strictEqual(r.profile, PROFILE);
});

test("a silent turn leaves no ledger row", () => {
  // Every mode and gate that suppresses the directive must also suppress
  // the row. A tombstone here is not harmless: it is a directive nobody
  // received, counted against the coordinator.
  writeState("advisory", { disposition: "stay_main", agent_profile: "" });
  const before = workDirectiveRows().length;
  assert.strictEqual(directive(), "");
  assert.strictEqual(workDirectiveRows().length, before);

  for (const mode of ["off", "observe"]) {
    writeState(mode);
    assert.strictEqual(directive(), "");
  }
  assert.strictEqual(workDirectiveRows().length, before);
});

// ── §11/§13.1 objective vocabulary ───────────────────────────────────────────

test("vocabulary plan: directive carries objective and strategy in §13.1 order", () => {
  writeState("advisory", { objective: "economize", model_strategy: "downshift" });
  const out = directive();
  assert.ok(out, "expected a directive, got empty");
  assert.match(
    out,
    /^\[tkr worker id=wr-1770000000-abc123: tkr:explore-haiku; objective=economize; model=downshift; shape=/,
  );
  assert.ok(
    Buffer.byteLength(out, "utf8") <= 200,
    `extended directive is ${Buffer.byteLength(out, "utf8")} bytes; budget is 200`,
  );
  const rows = workDirectiveRows();
  const last = rows[rows.length - 1];
  assert.strictEqual(last.route_objective, "economize");
  assert.strictEqual(last.model_strategy, "downshift");
});

test("legacy plan (no vocabulary): original directive format, empty ledger fields", () => {
  writeState("advisory");
  const out = directive();
  assert.match(out, /^\[tkr worker id=wr-1770000000-abc123: tkr:explore-haiku; shape=/);
  assert.ok(!out.includes("objective="), `legacy directive must not name an objective: ${out}`);
  const rows = workDirectiveRows();
  const last = rows[rows.length - 1];
  assert.strictEqual(last.route_objective, "");
  assert.strictEqual(last.model_strategy, "");
});

// §11: an unknown or unexpected objective must cause the hooks to
// decline, not fill — and partial vocabulary is unexpected too.
test("unknown or partial vocabulary declines the directive", () => {
  const bad = [
    { objective: "turbo", model_strategy: "downshift" },
    { objective: "economize", model_strategy: "sideways" },
    { objective: "economize" },
    { model_strategy: "same" },
  ];
  for (const overrides of bad) {
    writeState("advisory", overrides);
    assert.strictEqual(directive(), "", `expected decline for ${JSON.stringify(overrides)}`);
  }
});
