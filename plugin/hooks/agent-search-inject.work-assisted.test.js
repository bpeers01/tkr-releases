#!/usr/bin/env node
// Assisted-mode Agent routing (native-work-routing §13).
//
// Advisory (PR 3) put a directive in the coordinator's context and left
// the decision entirely to it. Assisted lets the hook FILL IN a spawn the
// coordinator already decided to make. That is a much sharper tool, so
// most of this file is about when it must keep its hands off — §13.4's
// compatibility checks, the explicit-choice rule, and one-plan-one-spawn.
//
// Two properties are asserted throughout and are easy to lose:
//   - a plan that is not applied is still RECORDED against the
//     coordinator's own choice (§14.2), because follow rate is the number
//     that justifies ever acting;
//   - an explicit model always wins, in every mode.
//
// Run: node --test hooks/agent-search-inject.work-assisted.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const HOOK = path.resolve(__dirname, "agent-search-inject.js");
const routeState = require("./lib/route-state.js");

const SID = "sess-work-assisted";
const PLAN_ID = "wr-1770000000-assist";
const PROFILE = "tkr:explore-haiku";
// The receipt and the route state must agree on the prompt hash — that
// agreement is what proves both describe the same turn.
const PROMPT_HASH = crypto.createHash("sha1").update("turn-A-prompt").digest("hex");

// env builds an isolated run: its own state dir (route state + consumed
// marker) and its own ledger. TKR_AUTOROUTE_DISABLED keeps the capacity
// axis out of these assertions — it has its own tests, and letting it
// fire here would make "who wrote model" ambiguous.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-work-assisted-"));
  const ledger = path.join(dir, "task-spawns.jsonl");
  return {
    dir,
    ledger,
    env: {
      TKR_STATE_DIR: dir,
      TKR_TASK_SPAWNS_PATH: ledger,
      TKR_AUTOROUTE_DISABLED: "1",
      TKR_SESSION_ID: SID,
    },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// writeState plants the doc internal/route/state.go persists. planOverrides
// edits the work plan; stateOverrides edits the envelope (for TTL and
// session-mismatch cases).
// writeReceipt plants the per-turn directive receipt UserPromptSubmit
// leaves behind. Assisted routing requires one: it is the only proof
// that the coordinator was told about THIS plan on THIS turn.
function writeReceipt(dir, fields) {
  const f = fields || {};
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `work-receipt-${SID}.json`),
    JSON.stringify({
      session_id: "session_id" in f ? f.session_id : SID,
      prompt_hash: "prompt_hash" in f ? f.prompt_hash : PROMPT_HASH,
      plan_id: "plan_id" in f ? f.plan_id : PLAN_ID,
      directive_emitted: "directive_emitted" in f ? f.directive_emitted : true,
      written_at: f.written_at || new Date().toISOString(),
    }),
  );
}

function writeState(dir, mode, planOverrides, stateOverrides) {
  const doc = {
    schema_version: routeState.STATE_SCHEMA_VERSION,
    session_id: SID,
    prompt_hash: PROMPT_HASH,
    active_model: "claude-opus-5",
    written_at: new Date().toISOString(),
    plan_id: PLAN_ID,
    classification: { active_model: "claude-opus-5", effort: "low", confidence: "high", scope: "main" },
    shape: { shape: "narrow_reversible", high_stakes: false, confidence: "high", read_only: true },
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
      ...(planOverrides || {}),
    },
    ...(stateOverrides || {}),
  };
  const saved = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  const fp = routeState.routeStatePath(SID);
  if (saved === undefined) delete process.env.TKR_STATE_DIR;
  else process.env.TKR_STATE_DIR = saved;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(doc));
  // Default to the happy path: the coordinator was told about this plan
  // this turn. Tests that probe the receipt itself overwrite it after.
  writeReceipt(dir, { plan_id: doc.work_plan.plan_id });
  return fp;
}

function agentEvent(toolInput) {
  return {
    tool_name: "Agent",
    session_id: SID,
    tool_input: {
      subagent_type: "general-purpose",
      description: "find the retry budget",
      prompt: "find where the retry budget is configured",
      run_in_background: false,
      ...toolInput,
    },
  };
}

function run(fx, event) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, ...fx.env },
  });
  assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  let updated = null;
  if (res.stdout && res.stdout.trim()) {
    const parsed = JSON.parse(res.stdout);
    updated = (parsed.hookSpecificOutput || {}).updatedInput || null;
  }
  const rows = fs.existsSync(fx.ledger)
    ? fs.readFileSync(fx.ledger, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { updated, rows, stdout: res.stdout };
}

// ── Applying ────────────────────────────────────────────────────────────────

test("assisted fills a general-purpose spawn from the plan", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted");
    const { updated, rows } = run(fx, agentEvent());

    assert.ok(updated, "expected a rewrite");
    assert.strictEqual(updated.subagent_type, PROFILE);
    assert.strictEqual(updated.model, "haiku");
    assert.strictEqual(updated.run_in_background, false);
    assert.ok(
      updated.prompt.startsWith("## TKR bounded worker contract"),
      "worker contract scaffold should lead the prompt",
    );
    assert.ok(
      updated.prompt.includes("find where the retry budget is configured"),
      "the coordinator's own task must survive",
    );

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].plan_id, PLAN_ID);
    assert.strictEqual(rows[0].plan_mode, "assisted");
    assert.strictEqual(rows[0].planned_profile, PROFILE);
    assert.strictEqual(rows[0].emitted_profile, PROFILE);
    assert.strictEqual(rows[0].emitted_model, "haiku");
    assert.strictEqual(rows[0].rewrite_mode, "assisted");

    // The coordinator asked for general-purpose; the hook made it match.
    // So this is NOT a follow, and scoring it as one would make assisted
    // mode report 100% compliance by construction and destroy the only
    // number that could ever justify acting on plans.
    assert.strictEqual(rows[0].requested_profile, "general-purpose");
    assert.strictEqual(rows[0].profile_followed, false);
    assert.strictEqual(rows[0].route_followed, false);
  } finally {
    fx.cleanup();
  }
});

for (const [label, subagentType] of [
  ["an absent subagent_type", ""],
  ["an Explore spawn", "Explore"],
  ["a spawn already naming the planned profile", PROFILE],
]) {
  test(`assisted applies to ${label}`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      const { updated } = run(fx, agentEvent({ subagent_type: subagentType }));
      assert.ok(updated, "expected a rewrite");
      assert.strictEqual(updated.subagent_type, PROFILE);
      assert.strictEqual(updated.model, "haiku");
    } finally {
      fx.cleanup();
    }
  });
}

// ── Refusing, but still recording ───────────────────────────────────────────

// The heart of advisory: nothing is touched, and the coordinator's own
// choice is written down next to what policy would have picked. Without
// this row there is no way to know whether the directive is working.
test("advisory records the coordinator's choice without rewriting", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    const { updated, rows } = run(fx, agentEvent());

    if (updated) {
      assert.strictEqual(updated.subagent_type, "general-purpose",
        "advisory must not change the subagent type");
      assert.ok(!updated.model, "advisory must not set a model");
    }
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].plan_id, PLAN_ID);
    assert.strictEqual(rows[0].planned_profile, PROFILE);
    assert.strictEqual(rows[0].emitted_profile, "general-purpose");
    assert.strictEqual(rows[0].route_followed, false);
    assert.strictEqual(rows[0].rewrite_mode, "none");
  } finally {
    fx.cleanup();
  }
});

test("advisory records a follow when the coordinator obeys the directive", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    const { rows } = run(fx, agentEvent({ subagent_type: PROFILE }));
    assert.strictEqual(rows[0].emitted_profile, PROFILE);
    assert.strictEqual(rows[0].route_followed, true,
      "the coordinator invoking the named profile IS the follow being measured");
    assert.strictEqual(rows[0].rewrite_mode, "none",
      "it followed on its own — nothing was rewritten");
  } finally {
    fx.cleanup();
  }
});

for (const mode of ["observe", "off", "managed", "", "nonsense"]) {
  test(`mode ${JSON.stringify(mode)} never rewrites`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, mode);
      const { updated } = run(fx, agentEvent());
      if (updated) {
        assert.strictEqual(updated.subagent_type, "general-purpose");
        assert.ok(!updated.model);
      }
    } finally {
      fx.cleanup();
    }
  });
}

// Managed is listed above deliberately: it is a real mode name in the
// plan but is not implemented, and an unimplemented mode must fail to
// "do nothing", never fall through to assisted's behavior.

test("an explicit model always wins, even when it agrees with the plan", () => {
  for (const model of ["opus", "haiku"]) {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      const { updated, rows } = run(fx, agentEvent({ model }));
      if (updated) {
        assert.strictEqual(updated.model, model, `explicit ${model} was overwritten`);
        assert.strictEqual(updated.subagent_type, "general-purpose");
      }
      assert.strictEqual(rows[0].emitted_model, model);
      assert.strictEqual(rows[0].rewrite_mode, "none");
    } finally {
      fx.cleanup();
    }
  }
});

for (const [label, subagentType] of [
  ["Plan", "Plan"],
  ["an unrelated specialist", "code-reviewer"],
  ["another plugin's agent", "blueprint:reviewer"],
]) {
  test(`assisted refuses to reshape ${label}`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      const { updated, rows } = run(fx, agentEvent({ subagent_type: subagentType }));
      if (updated) {
        assert.strictEqual(updated.subagent_type, subagentType,
          "a specialist was chosen for capabilities the plan knows nothing about");
        assert.ok(!updated.model);
      }
      assert.strictEqual(rows[0].emitted_profile, subagentType);
      assert.strictEqual(rows[0].rewrite_mode, "none");
    } finally {
      fx.cleanup();
    }
  });
}

test("an empty prompt is not routable", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted");
    const { updated } = run(fx, agentEvent({ prompt: "   " }));
    if (updated) assert.ok(!updated.model, "empty task must not be shaped");
  } finally {
    fx.cleanup();
  }
});

// ── Plans that should not exist at all ──────────────────────────────────────

// These differ from the cases above: there is no usable plan, so the
// ledger row must carry NO routing fields. A row claiming
// route_followed=false against a plan that was never eligible would
// depress follow rate with spawns the feature never had an opinion on.
for (const [label, planOverrides] of [
  ["high-stakes", { high_stakes: true }],
  ["low-confidence", { confidence: "low" }],
  ["stay-main", { disposition: "stay_main" }],
  ["profile-less", { agent_profile: "" }],
]) {
  test(`a ${label} plan produces no routing record`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted", planOverrides);
      const { updated, rows } = run(fx, agentEvent());
      if (updated) assert.ok(!updated.model);
      assert.strictEqual(rows.length, 1);
      assert.ok(!("plan_id" in rows[0]),
        `${label} plan leaked into the ledger: ${JSON.stringify(rows[0])}`);
    } finally {
      fx.cleanup();
    }
  });
}

test("a stale plan is not applied", () => {
  const fx = fixture();
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeState(fx.dir, "assisted", {}, { written_at: old });
    const { updated, rows } = run(fx, agentEvent());
    if (updated) assert.ok(!updated.model);
    assert.ok(!("plan_id" in rows[0]), "an expired plan was still recorded");
  } finally {
    fx.cleanup();
  }
});

test("another session's plan is not applied", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted", {}, { session_id: "someone-else" });
    const { updated, rows } = run(fx, agentEvent());
    if (updated) assert.ok(!updated.model);
    assert.ok(!("plan_id" in rows[0]));
  } finally {
    fx.cleanup();
  }
});

for (const killSwitch of [
  "TKR_WORK_ROUTE_DISABLED",
  "TKR_ROUTE_DISABLED",
]) {
  test(`${killSwitch}=1 stops assisted routing`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      fx.env[killSwitch] = "1";
      const { updated } = run(fx, agentEvent());
      if (updated) assert.ok(!updated.model, `${killSwitch} did not stop the rewrite`);
    } finally {
      fx.cleanup();
    }
  });
}

// ── One plan, one spawn ─────────────────────────────────────────────────────

// A coordinator that fans out five workers off one prompt should have the
// plan shape the first and leave the rest alone: the plan described one
// bounded piece of work, not a licence to reshape everything that follows.
test("a plan is spent after the spawn it shapes", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted");

    const first = run(fx, agentEvent());
    assert.strictEqual(first.updated.subagent_type, PROFILE, "first spawn should be shaped");

    const second = run(fx, agentEvent());
    if (second.updated) {
      assert.strictEqual(second.updated.subagent_type, "general-purpose",
        "the plan was already spent");
      assert.ok(!second.updated.model);
    }

    assert.strictEqual(second.rows.length, 2);
    assert.strictEqual(second.rows[0].rewrite_mode, "assisted");
    assert.strictEqual(second.rows[1].rewrite_mode, "none",
      "the second spawn must not be recorded as routed");
    assert.strictEqual(second.rows[1].profile_followed, false);
  } finally {
    fx.cleanup();
  }
});

// ── Route state stays the Go binary's ───────────────────────────────────────

// Consumption is tracked in its own file. If it were written back into
// route-current-<sid>.json, this hook would race `tkr route classify`
// and drop verdicts (hooks/CLAUDE.md § State files: one writer).
test("claiming a plan does not touch the route state file", () => {
  const fx = fixture();
  try {
    const fp = writeState(fx.dir, "assisted");
    const before = fs.readFileSync(fp, "utf8");
    run(fx, agentEvent());
    assert.strictEqual(fs.readFileSync(fp, "utf8"), before,
      "the Agent hook wrote to the Go binary's state file");
    assert.ok(
      fs.existsSync(path.join(fx.dir, `work-claim-${SID}-${PLAN_ID}`)),
      "the claim should live in its own file",
    );
  } finally {
    fx.cleanup();
  }
});

// ── Unplanned spawns are untouched ──────────────────────────────────────────

test("with no plan at all, nothing about routing changes", () => {
  const fx = fixture();
  try {
    const { updated, rows } = run(fx, agentEvent());
    if (updated) {
      assert.strictEqual(updated.subagent_type, "general-purpose");
      assert.ok(!updated.model);
    }
    assert.strictEqual(rows.length, 1);
    assert.ok(!("plan_id" in rows[0]));
    assert.ok(!("claim_denied" in rows[0]), "no plan means no claim to deny");
    assert.strictEqual(rows[0].schema_version, 6);
  } finally {
    fx.cleanup();
  }
});

// ── Finding 0 (PR 5A): the lifecycle join anchors ───────────────────────────

test("the spawn row carries the payload's join anchors verbatim", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    const event = agentEvent();
    event.prompt_id = "pr-0001";
    event.tool_use_id = "toolu_abc";
    const { rows } = run(fx, event);

    assert.strictEqual(rows[0].prompt_id, "pr-0001");
    assert.strictEqual(rows[0].tool_use_id, "toolu_abc");
  } finally {
    fx.cleanup();
  }
});

test("a spawn that loses the exclusive claim records the denial", () => {
  // "One plan reshapes at most one spawn" is unfalsifiable from a ledger
  // that only shows the winner: a plan applied once and a plan applied
  // once-out-of-five look identical. The loser's row is the difference.
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted");
    // Stand in for the sibling PreToolUse process that got there first.
    // The claim is an exclusive create, so pre-existing is the same
    // observable state as "another process just won it".
    fs.writeFileSync(path.join(fx.dir, `work-claim-${SID}-${PLAN_ID}`), "{}");

    const { updated, rows } = run(fx, agentEvent());

    if (updated) {
      assert.strictEqual(updated.subagent_type, "general-purpose",
        "a denied claim must not rewrite");
      assert.ok(!updated.model, "a denied claim must not set the model");
    }
    assert.strictEqual(rows[0].claim_denied, true);
    assert.strictEqual(rows[0].rewrite_mode, "none");
    assert.strictEqual(rows[0].emitted_profile, "general-purpose");
  } finally {
    fx.cleanup();
  }
});

// ── Finding 1: a plan may only shape the turn it was announced on ───────────
//
// The Agent hook cannot check the user's prompt hash — it holds an
// Agent's prompt. Session + freshness alone leaves a five-minute window
// in which turn A's plan can reshape turn B's spawn: if turn B's classify
// times out or never writes, UserPromptSubmit correctly stays silent
// (hash mismatch) while turn A's plan is still live. Turn B may be the
// mutating one, and the hook would be applying turn A's safety verdict
// to it. The receipt closes that window.

test("a plan with no receipt is never applied", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted");
    fs.rmSync(path.join(fx.dir, `work-receipt-${SID}.json`), { force: true });
    const { updated, rows } = run(fx, agentEvent());
    if (updated) {
      assert.strictEqual(updated.subagent_type, "general-purpose",
        "a plan the coordinator was never told about was applied");
      assert.ok(!updated.model);
    }
    // And no plan fields at all: without a receipt the plan is not proven
    // to belong to this turn, so it must not be recorded against this
    // spawn either. Finding 2 — telemetry has to be as careful as acting.
    assert.ok(!("plan_id" in rows[0]),
      `an unproven plan reached the ledger: ${JSON.stringify(rows[0])}`);
  } finally {
    fx.cleanup();
  }
});

// The exact reported failure path: turn A's plan is still inside the TTL,
// but the receipt names the turn-B prompt for which no directive went out.
test("last turn's plan cannot shape this turn's spawn", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted");
    // Turn B: UserPromptSubmit emitted nothing (its classify never wrote),
    // so it left a tombstone. Turn A's plan is still on disk and fresh.
    // Turn B's tombstone carries turn B's prompt hash, which is not the
    // hash turn A's route state was written under.
    writeReceipt(fx.dir, {
      plan_id: "", directive_emitted: false,
      prompt_hash: crypto.createHash("sha1").update("turn-B-prompt").digest("hex"),
    });
    const { updated, rows } = run(fx, agentEvent());
    if (updated) {
      assert.strictEqual(updated.subagent_type, "general-purpose",
        "turn A's plan reshaped turn B's spawn");
      assert.ok(!updated.model);
    }
    assert.ok(!("plan_id" in rows[0]),
      "turn A's plan was scored against turn B's spawn");
  } finally {
    fx.cleanup();
  }
});

for (const [label, fields] of [
  ["names a different plan", { plan_id: "wr-9999999999-other" }],
  ["says no directive was emitted", { directive_emitted: false }],
  ["belongs to another session", { session_id: "someone-else" }],
  ["is older than the state TTL", { written_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }],
  ["is stamped in the future", { written_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }],
]) {
  test(`a receipt that ${label} does not authorize a rewrite`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      writeReceipt(fx.dir, fields);
      const { updated } = run(fx, agentEvent());
      if (updated) assert.ok(!updated.model, `receipt that ${label} was accepted`);
    } finally {
      fx.cleanup();
    }
  });
}

// ── Finding 2: one plan, one spawn — end-to-end smoke ───────────────────────
//
// Honest about what this does NOT prove. Node startup dominates here: the
// first process boots, claims and exits before its siblings reach the
// claim, so a check-then-write implementation passes this test. Verified
// by reverting the claim and watching it stay green.
//
// The actual exclusivity gate is in hooks/lib/work-route-state.test.js,
// where the racers are released from a barrier after all are booted —
// that one does catch check-then-write. This case exists to confirm the
// claim is wired into the hook at all, and that parallel spawns produce
// sane output rather than an exception.
test("parallel spawns produce exactly one rewrite end-to-end", async () => {
  const { spawn } = require("node:child_process");
  const ROUNDS = 4;
  const RACERS = 8;
  for (let round = 0; round < ROUNDS; round++) {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      const payload = JSON.stringify(agentEvent());

      const kids = Array.from({ length: RACERS }, () =>
        spawn(process.execPath, [HOOK], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...fx.env },
        }),
      );
      // Feed every child before reading any, so they run concurrently
      // rather than one-at-a-time.
      for (const k of kids) k.stdin.end(payload);

      const outs = await Promise.all(kids.map((k) => new Promise((res) => {
        let buf = "";
        k.stdout.on("data", (d) => { buf += d; });
        k.once("close", () => res(buf));
      })));

      const rewrites = outs.filter((o) => {
        if (!o.trim()) return false;
        const ui = (JSON.parse(o).hookSpecificOutput || {}).updatedInput || {};
        return ui.subagent_type === PROFILE;
      }).length;
      assert.strictEqual(rewrites, 1,
        `round ${round}: ${rewrites} spawns claimed the same plan`);
    } finally {
      fx.cleanup();
    }
  }
});

// ── Finding 3: observe rows must not be scored ──────────────────────────────
//
// In observe nothing reaches the model, so a matching profile is
// coincidence and a mismatch is not a refusal. Recording either would
// quietly poison the follow rate with spawns the coordinator was never
// asked about.
test("observe records the plan but scores nothing", () => {
  for (const requested of ["general-purpose", PROFILE]) {
    const fx = fixture();
    try {
      writeState(fx.dir, "observe");
      const { rows } = run(fx, agentEvent({ subagent_type: requested }));
      assert.strictEqual(rows[0].plan_id, PLAN_ID, "correlation id should survive");
      assert.strictEqual(rows[0].plan_mode, "observe");
      assert.strictEqual(rows[0].followable, false);
      for (const k of ["route_followed", "profile_followed", "model_followed"]) {
        assert.ok(!(k in rows[0]),
          `observe row scored ${k} (requested=${requested}) — the coordinator was never told`);
      }
    } finally {
      fx.cleanup();
    }
  }
});

test("advisory is scored, because the coordinator was told", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    const { rows } = run(fx, agentEvent({ subagent_type: PROFILE }));
    assert.strictEqual(rows[0].followable, true);
    assert.strictEqual(rows[0].profile_followed, true);
    assert.strictEqual(rows[0].route_followed, true);
  } finally {
    fx.cleanup();
  }
});

// ── Finding 4: naming the profile while pinning another model ───────────────
//
// The profile matches, so profile-only scoring would call this a follow —
// but the plan's whole claim is haiku economics, and opus does not
// deliver them. The savings would be booked and never realized.
test("the planned profile with a conflicting model is not a follow", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    const { rows } = run(fx, agentEvent({ subagent_type: PROFILE, model: "opus" }));
    assert.strictEqual(rows[0].requested_profile, PROFILE);
    assert.strictEqual(rows[0].requested_model, "opus");
    assert.strictEqual(rows[0].profile_followed, true, "the profile did match");
    assert.strictEqual(rows[0].model_followed, false, "but opus is not the planned worker");
    assert.strictEqual(rows[0].route_followed, false);
  } finally {
    fx.cleanup();
  }
});

test("an absent model is the profile's own default, so it follows", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    const { rows } = run(fx, agentEvent({ subagent_type: PROFILE }));
    assert.strictEqual(rows[0].requested_model, "");
    assert.strictEqual(rows[0].model_followed, true);
    assert.strictEqual(rows[0].route_followed, true);
  } finally {
    fx.cleanup();
  }
});

test("naming the planned model explicitly also follows", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    const { rows } = run(fx, agentEvent({ subagent_type: PROFILE, model: "haiku" }));
    assert.strictEqual(rows[0].model_followed, true);
    assert.strictEqual(rows[0].route_followed, true);
  } finally {
    fx.cleanup();
  }
});

// ── Finding 1 (round 2): every prompt must leave a tombstone ────────────────
//
// UserPromptSubmit returns early for the brevity commands, before it ever
// reaches the directive. Writing the receipt only at that point left those
// prompts carrying the PREVIOUS turn's receipt for the rest of the TTL —
// and with it, authority for the previous turn's plan.
//
// This runs the REAL UserPromptSubmit hook, because the bug was entirely
// in its control flow; a unit test of the receipt writer could not see it.
for (const earlyPrompt of ["/brevity ultra", "/tkr-brevity", "stop brevity", "normal mode"]) {
  test(`${JSON.stringify(earlyPrompt)} still tombstones the receipt`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      const receipt = path.join(fx.dir, `work-receipt-${SID}.json`);
      assert.strictEqual(JSON.parse(fs.readFileSync(receipt, "utf8")).plan_id, PLAN_ID,
        "fixture should start with turn A's receipt");

      // Turn B: an early-returning prompt through the real hook.
      const ups = spawnSync(process.execPath, [path.resolve(__dirname, "user-prompt-submit.js")], {
        input: JSON.stringify({ prompt: earlyPrompt, session_id: SID, cwd: process.cwd() }),
        encoding: "utf8",
        env: { ...process.env, ...fx.env, TKR_ROUTE_SYNC: "0", CLAUDE_MODEL: "claude-opus-5" },
      });
      assert.strictEqual(ups.status, 0, `UserPromptSubmit exited ${ups.status}: ${ups.stderr}`);

      const after = JSON.parse(fs.readFileSync(receipt, "utf8"));
      assert.strictEqual(after.directive_emitted, false,
        `${earlyPrompt} left turn A's receipt in place`);
      assert.strictEqual(after.plan_id, "");

      // And the Agent hook now refuses, on the same turn.
      const { updated, rows } = run(fx, agentEvent());
      if (updated) {
        assert.strictEqual(updated.subagent_type, "general-purpose",
          `${earlyPrompt} let turn A's plan reshape turn B's spawn`);
        assert.ok(!updated.model);
      }
      assert.ok(!("plan_id" in rows[0]),
        `${earlyPrompt} let turn A's plan be scored against turn B`);
    } finally {
      fx.cleanup();
    }
  });
}

// A normal prompt must still get a real receipt — the tombstone is
// written first and then superseded, so a regression that skipped the
// overwrite would silently disable assisted routing entirely.
test("a normal prompt supersedes its own tombstone", () => {
  const fx = fixture();
  try {
    const prompt = "Find where the retry budget is configured";
    // Route state must be written under THIS prompt's hash for the
    // directive to fire, since UserPromptSubmit checks the prompt hash.
    writeState(fx.dir, "assisted", {}, {
      prompt_hash: crypto.createHash("sha1").update(prompt).digest("hex"),
    });
    const ups = spawnSync(process.execPath, [path.resolve(__dirname, "user-prompt-submit.js")], {
      input: JSON.stringify({ prompt, session_id: SID, cwd: process.cwd() }),
      encoding: "utf8",
      env: { ...process.env, ...fx.env, TKR_ROUTE_SYNC: "0", CLAUDE_MODEL: "claude-opus-5" },
    });
    assert.strictEqual(ups.status, 0, `UserPromptSubmit exited ${ups.status}: ${ups.stderr}`);
    assert.ok(ups.stdout.includes("tkr worker id="), "expected the directive to be emitted");

    const after = JSON.parse(fs.readFileSync(path.join(fx.dir, `work-receipt-${SID}.json`), "utf8"));
    assert.strictEqual(after.directive_emitted, true, "the tombstone was never superseded");
    assert.strictEqual(after.plan_id, PLAN_ID);
  } finally {
    fx.cleanup();
  }
});

// ── Finding 2 (round 2): unproven plans stay out of telemetry ──────────────
//
// The descriptor used to be built before any turn proof, so advisory,
// observe and refused-assisted spawns could all be scored against a plan
// from a previous turn. The Agent was left alone and the follow rate was
// corrupted anyway — which matters, because that rate is the entire
// justification for ever acting.
for (const mode of ["advisory", "observe", "assisted"]) {
  test(`${mode}: a plan from another turn is not recorded`, () => {
    const fx = fixture();
    try {
      writeState(fx.dir, mode);
      writeReceipt(fx.dir, {
        plan_id: "", directive_emitted: false,
        prompt_hash: crypto.createHash("sha1").update("some-other-turn").digest("hex"),
      });
      const { rows } = run(fx, agentEvent({ subagent_type: PROFILE }));
      for (const k of ["plan_id", "plan_mode", "planned_profile", "route_followed", "followable"]) {
        assert.ok(!(k in rows[0]),
          `${mode} recorded ${k} for a plan from another turn: ${JSON.stringify(rows[0])}`);
      }
    } finally {
      fx.cleanup();
    }
  });
}

// A directive that never went out is not something the coordinator can
// have followed — in any mode. Scoring it would count silence as refusal.
test("a plan whose directive never went out is recorded but not scored", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "advisory");
    // Same turn (hashes agree), but nothing was emitted — e.g. the named
    // profile is not installed, or the backend is unrecognized.
    writeReceipt(fx.dir, { plan_id: "", directive_emitted: false });
    const { rows } = run(fx, agentEvent({ subagent_type: PROFILE }));
    assert.strictEqual(rows[0].plan_id, PLAN_ID, "same-turn plan should still correlate");
    assert.strictEqual(rows[0].followable, false);
    for (const k of ["route_followed", "profile_followed", "model_followed"]) {
      assert.ok(!(k in rows[0]), `scored ${k} against a directive that never went out`);
    }
  } finally {
    fx.cleanup();
  }
});

// ── §13.2 subagent recursion guard ───────────────────────────────────────────

// A sidechain shares the coordinator's session_id, so a fillable plan IS
// visible from a worker's own Agent call — the guard, not the receipt,
// is what stands between that and worker-spawns-worker cost doubling.
test("recursion guard: any subagent marker declines work routing entirely", () => {
  const markers = [
    { agent_id: "a1b2c3" },
    { agent_type: "tkr:isolate-research" },
    { scope: "subagent" },
    { subagent_type: "Explore" }, // top-level (session identity), not tool_input
  ];
  for (const marker of markers) {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted");
      const { updated, rows } = run(fx, { ...agentEvent(), ...marker });
      assert.strictEqual(updated, null, `marker ${JSON.stringify(marker)} must not rewrite`);
      assert.strictEqual(rows.length, 1, "spawn row still recorded");
      assert.ok(!("plan_id" in rows[0]), `no plan fields on a sidechain spawn row: ${JSON.stringify(marker)}`);
    } finally {
      fx.cleanup();
    }
  }
});

// ── §13.2 same-model fill guard ──────────────────────────────────────────────

test("same-model plan is recorded but never filled outside ObjectiveIsolate", () => {
  // Legacy plan (no vocabulary) and an economize plan, both claiming a
  // worker in the active model's family — an upstream regression either
  // way, since the Go gate refuses same-family for economize.
  const plans = [
    { worker_model: "opus" },
    { worker_model: "claude-opus-5", objective: "economize", model_strategy: "downshift" },
  ];
  for (const planOverrides of plans) {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted", planOverrides);
      const { updated, rows } = run(fx, agentEvent());
      assert.strictEqual(updated, null, `must not fill: ${JSON.stringify(planOverrides)}`);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].plan_id, PLAN_ID, "plan still recorded against the spawn");
      assert.strictEqual(rows[0].rewrite_mode, "none");
    } finally {
      fx.cleanup();
    }
  }
});

// ── §11/§15 vocabulary on the spawn row ──────────────────────────────────────

test("vocabulary plan: spawn row carries route_objective and model_strategy", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted", { objective: "economize", model_strategy: "downshift" });
    const { updated, rows } = run(fx, agentEvent());
    assert.ok(updated, "economize/downshift with a cheaper worker still fills");
    assert.strictEqual(updated.model, "haiku");
    assert.strictEqual(rows[0].route_objective, "economize");
    assert.strictEqual(rows[0].model_strategy, "downshift");
  } finally {
    fx.cleanup();
  }
});

test("legacy plan: spawn row vocabulary fields are empty, fill unaffected", () => {
  const fx = fixture();
  try {
    writeState(fx.dir, "assisted");
    const { updated, rows } = run(fx, agentEvent());
    assert.ok(updated, "legacy plan keeps the shipped fill behavior");
    assert.strictEqual(rows[0].route_objective, "");
    assert.strictEqual(rows[0].model_strategy, "");
  } finally {
    fx.cleanup();
  }
});

// §11: unknown or partial vocabulary means the plan state cannot be
// trusted — the hook must decline to represent it at all, not fill.
test("unknown or partial vocabulary: no plan fields, no fill", () => {
  const bad = [
    { objective: "turbo", model_strategy: "downshift" },
    { objective: "economize", model_strategy: "sideways" },
    { objective: "economize" },
    { model_strategy: "downshift" },
  ];
  for (const planOverrides of bad) {
    const fx = fixture();
    try {
      writeState(fx.dir, "assisted", planOverrides);
      const { updated, rows } = run(fx, agentEvent());
      assert.strictEqual(updated, null, `must not fill: ${JSON.stringify(planOverrides)}`);
      assert.strictEqual(rows.length, 1);
      assert.ok(!("plan_id" in rows[0]), `untrusted plan must leave no plan fields: ${JSON.stringify(planOverrides)}`);
    } finally {
      fx.cleanup();
    }
  }
});

// ── The veto and the claim (#143 finding 2) ─────────────────────────────────
//
// Two defects, one ordering. `workRoute` claimed the plan as its last
// step, and `vetoCheck` ran afterwards on the ORIGINAL call — so a denied
// spawn consumed the plan, and the rewritten call (the one that actually
// runs) was never checked at all. The second half is the sharper one: a
// generic spawn carries no tkr:* profile, so the original-call check
// declines to run, and the rewrite then hands the task to a read-only
// worker with that worker's own contract never consulted.
//
// Shimmed via TKR_BIN pointing at a JS file, same mechanism (and same
// reasoning) as the veto tests in agent-search-inject.test.js — see the
// header there. Runs on every platform; the old PATH shim did not.
function withTkrShim(responseObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-veto-shim-"));
  const shim = path.join(dir, "tkr-shim.js");
  fs.writeFileSync(
    shim,
    `process.stdin.resume();\nprocess.stdin.on("data", () => {});\n` +
      `process.stdout.write(${JSON.stringify(JSON.stringify(responseObj))} + "\\n");\n`,
  );
  return {
    env: { TKR_BIN: shim },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// Same shim, but it records every payload the hook sent it. What the hook
// ASKS is the assertion target here — a shim that only answers cannot
// distinguish "checked the coordinator's prompt" from "checked its own
// injected boilerplate", and that distinction is the whole of INV-099.
function withRecordingTkrShim(responseObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-veto-rec-"));
  const shim = path.join(dir, "tkr-shim.js");
  const log = path.join(dir, "payloads.jsonl");
  fs.writeFileSync(
    shim,
    `const fs = require("fs");\nlet buf = "";\n` +
      `process.stdin.on("data", (c) => { buf += c; });\n` +
      `process.stdin.on("end", () => {\n` +
      `  try { fs.appendFileSync(${JSON.stringify(log)}, buf.trim() + "\\n"); } catch {}\n` +
      `  process.stdout.write(${JSON.stringify(JSON.stringify(responseObj))} + "\\n");\n` +
      `});\n`,
  );
  return {
    env: { TKR_BIN: shim },
    payloads: () =>
      (fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
        : []
      ).map((l) => JSON.parse(l)),
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

const DENY = {
  verdict: "deny",
  reason: "mutation_to_readonly_worker",
  detail: "profile tkr:explore-haiku is read-only and this task carries mutation intent",
  enforce: true,
  evaluated: true,
  mode: "assisted",
};

// The gap itself: the emitted call is tkr:explore-haiku, so the profile's
// contract has to be asked about it. Before this, the only question asked
// was about "general-purpose", which vetoCheck declines to answer.
test("the REWRITTEN call is veto-checked, not just the original", () => {
  const fx = fixture();
  const shim = withTkrShim(DENY);
  try {
    writeState(fx.dir, "assisted");
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(agentEvent({ prompt: "edit internal/foo.go and rename X to Y" })),
      encoding: "utf8",
      env: { ...process.env, ...fx.env, ...shim.env },
    });
    assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.decision, "block",
      "a generic spawn rewritten into a read-only worker must still face that worker's veto");
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(!("updatedInput" in out.hookSpecificOutput),
      "a denied spawn is never also rewritten");
  } finally {
    shim.cleanup();
    fx.cleanup();
  }
});

// INV-099. The hook injects SEARCH_GUIDANCE into every Explore spawn, and
// that text ends "...to explore the codebase, run:". `run` is a
// mutationVerb, so checking the ASSEMBLED prompt made tkr deny a spawn on
// the strength of its own boilerplate — every assisted Explore spawn, on
// any machine where the check could actually run. It stayed invisible for
// three nightlies because a dev box with a reachable-but-non-enforcing
// tkr, or no tkr at all, answers allow either way.
//
// The profile asked about must still be the EMITTED one (#143 finding 2);
// only the prompt reverts to what the coordinator wrote.
test("the veto sees the coordinator's prompt, never the hook's own injection", () => {
  const fx = fixture();
  const shim = withRecordingTkrShim({
    verdict: "allow", enforce: false, evaluated: true, mode: "assisted",
  });
  try {
    writeState(fx.dir, "assisted");
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(agentEvent({ subagent_type: "Explore" })),
      encoding: "utf8",
      env: { ...process.env, ...fx.env, ...shim.env },
    });
    assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);

    const asked = shim.payloads();
    assert.strictEqual(asked.length, 1, "exactly the emitted-call check runs");
    assert.strictEqual(asked[0].subagent_type, PROFILE,
      "the EMITTED profile is what the veto is asked about");
    assert.strictEqual(asked[0].prompt, "find where the retry budget is configured",
      "the coordinator's prompt, verbatim — no guidance, no contract scaffold");
    assert.ok(!asked[0].prompt.includes("tkr search"),
      "injected search guidance must never reach the risk gate");
    assert.ok(!asked[0].prompt.includes("TKR bounded worker contract"),
      "the worker contract scaffold must never reach the risk gate");

    // And the spawn still gets shaped — the point of not self-vetoing.
    const out = JSON.parse(res.stdout);
    assert.ok(!out.decision, "an allowed read-only spawn is not blocked");
    assert.strictEqual(out.hookSpecificOutput.updatedInput.subagent_type, PROFILE);
  } finally {
    shim.cleanup();
    fx.cleanup();
  }
});

// The ordering half: a plan the veto refused is not spent, so the
// coordinator's corrected retry can still use it. Before this the retry
// found the plan claimed and silently ran unrouted.
test("a vetoed spawn does not consume the plan claim", () => {
  const fx = fixture();
  const denyShim = withTkrShim(DENY);
  try {
    writeState(fx.dir, "assisted");

    // Attempt 1: denied. The plan must survive it.
    const denied = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(agentEvent({ prompt: "edit internal/foo.go and rename X to Y" })),
      encoding: "utf8",
      env: { ...process.env, ...fx.env, ...denyShim.env },
    });
    assert.strictEqual(JSON.parse(denied.stdout).decision, "block");
    denyShim.cleanup();

    // Attempt 2: the corrected retry, with no reachable veto (fail-open).
    // It must still be shaped by the plan the denial did not spend.
    const retry = run(fx, agentEvent());
    assert.ok(retry.updated, "the retry produced no updatedInput at all");
    assert.strictEqual(retry.updated.subagent_type, PROFILE,
      "the denied spawn consumed the plan; the corrected retry ran unrouted");
    assert.strictEqual(retry.rows.length, 2);
    assert.strictEqual(retry.rows[0].veto_denied, true, "row 1 records the denial");
    assert.strictEqual(retry.rows[0].rewrite_mode, "none",
      "a denied spawn never reports itself as routed");
    assert.strictEqual(retry.rows[1].rewrite_mode, "assisted",
      "row 2 is the retry the plan actually shaped");
  } finally {
    fx.cleanup();
  }
});

// Fail-open survives the second check too: an unreachable binary must not
// turn an assisted rewrite into a block.
test("an unreachable veto binary still lets the rewrite through", () => {
  const fx = fixture();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-noexist-"));
  try {
    writeState(fx.dir, "assisted");
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(agentEvent()),
      encoding: "utf8",
      env: { ...process.env, ...fx.env, PATH: empty },
    });
    assert.strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.ok(!out.decision, "a missing binary must never block");
    assert.strictEqual(out.hookSpecificOutput.updatedInput.subagent_type, PROFILE);
  } finally {
    try { fs.rmSync(empty, { recursive: true, force: true }); } catch {}
    fx.cleanup();
  }
});
