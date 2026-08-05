#!/usr/bin/env node
// Test for hooks/agent-search-inject.js — verifies:
//   1. (DELEG-INT-001) run_in_background=true is rewritten to false on Agent/Task
//   2. run_in_background already false → no rewrite needed (passthrough or
//      injection-only output without flipping the flag)
//   3. Non-Agent tools pass through unchanged
//   4. Explore subagent gets search guidance injected
//
// Run: node hooks/agent-search-inject.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "agent-search-inject.js");

function runHook(event, env) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, ...(env || {}) },
  });
}

// withTempLedger gives a test its own task-spawns.jsonl path so writes
// don't pollute ~/.tkr/. Returns { dir, ledger, cleanup }.
function withTempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-task-spawns-"));
  const ledger = path.join(dir, "task-spawns.jsonl");
  return {
    dir,
    ledger,
    env: { TKR_TASK_SPAWNS_PATH: ledger },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function readLedger(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("forces run_in_background=false when true on Agent tool", () => {
  const res = runHook({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "general-purpose",
      prompt: "do a thing",
      run_in_background: true,
    },
  });
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(res.stdout, "expected stdout payload");
  const out = JSON.parse(res.stdout);
  assert.strictEqual(
    out.hookSpecificOutput.updatedInput.run_in_background,
    false,
    "run_in_background must be false",
  );
  // Prompt unchanged for non-Explore subagent
  assert.strictEqual(out.hookSpecificOutput.updatedInput.prompt, "do a thing");
});

test("forces run_in_background=false on Task tool name", () => {
  const res = runHook({
    tool_name: "Task",
    tool_input: {
      subagent_type: "senior-implementer",
      prompt: "implement",
      run_in_background: true,
    },
  });
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(
    out.hookSpecificOutput.updatedInput.run_in_background,
    false,
  );
});

test("Explore subagent gets prompt injection AND run_in_background=false", () => {
  const res = runHook({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "Explore",
      prompt: "find auth logic",
      run_in_background: true,
    },
  });
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(
    out.hookSpecificOutput.updatedInput.run_in_background,
    false,
  );
  assert.ok(
    out.hookSpecificOutput.updatedInput.prompt.includes("tkr search"),
    "expected search guidance prepended",
  );
  assert.ok(
    out.hookSpecificOutput.updatedInput.prompt.includes("find auth logic"),
    "expected original prompt preserved",
  );
});

test("run_in_background already false on non-Explore → no output (passthrough)", () => {
  const res = runHook({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "general-purpose",
      prompt: "do a thing",
      run_in_background: false,
    },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "", "expected empty stdout (passthrough)");
});

test("run_in_background missing (undefined) is treated as needs-rewrite", () => {
  // undefined !== false → force to false. Defensive: idempotent + safe.
  const res = runHook({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "general-purpose",
      prompt: "x",
    },
  });
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(
    out.hookSpecificOutput.updatedInput.run_in_background,
    false,
  );
});

test("non-Agent tool passes through unchanged", () => {
  const res = runHook({
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "");
});

test("malformed JSON is silently passthrough", () => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: "{not json",
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "");
});

// INV-023 P1 — task-spawn ledger emission.

test("INV-023: ledger row written for every Agent/Task spawn", () => {
  const tmp = withTempLedger();
  try {
    const event = {
      tool_name: "Agent",
      session_id: "test-sid-1234",
      tool_input: {
        subagent_type: "Explore",
        description: "find auth logic",
        prompt: "find auth logic in the codebase",
        run_in_background: true,
      },
    };
    const res = runHook(event, tmp.env);
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1, "expected one ledger row");
    const r = rows[0];
    assert.strictEqual(r.tool_name, "Agent");
    assert.strictEqual(r.subagent_type, "Explore");
    assert.strictEqual(r.description, "find auth logic");
    assert.strictEqual(r.session_id, "test-sid-1234");
    assert.strictEqual(r.background, true);
    // v2 added the §14.2 work-routing join. This spawn had no plan, so
    // none of those fields appear — which is itself the v2 contract:
    // absent plan_id on a v2 row means "no plan was current", not
    // "this writer never recorded one".
    assert.strictEqual(r.schema_version, 4);
    assert.ok(!("plan_id" in r), "unplanned spawn must not carry routing fields");
    assert.ok(!("route_followed" in r), "unplanned spawn must not claim a follow");
    assert.ok(r.at, "expected ISO timestamp");
    // v3 added the lifecycle join anchors. Unlike the routing fields they
    // are written unconditionally, empty included: an empty prompt_id is
    // the record that this spawn can never be joined to an outcome, which
    // is a different fact from the reader having failed to look.
    assert.strictEqual(r.prompt_id, "");
    assert.strictEqual(r.tool_use_id, "");
  } finally {
    tmp.cleanup();
  }
});

test("INV-023: passthrough spawns still emit ledger row", () => {
  // The hook short-circuits when run_in_background=false + non-Explore.
  // Ledger emit must happen BEFORE the short-circuit so we capture every
  // spawn — that's the whole point of the observability surface.
  const tmp = withTempLedger();
  try {
    const res = runHook({
      tool_name: "Agent",
      session_id: "test-sid-passthrough",
      tool_input: {
        subagent_type: "general-purpose",
        description: "trivial",
        prompt: "x",
        run_in_background: false,
      },
    }, tmp.env);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, "", "passthrough: empty stdout");
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1, "ledger row still required");
    assert.strictEqual(rows[0].background, false);
    assert.strictEqual(rows[0].subagent_type, "general-purpose");
  } finally {
    tmp.cleanup();
  }
});

test("INV-023: ledger NOT written for non-Agent tools", () => {
  const tmp = withTempLedger();
  try {
    runHook({ tool_name: "Bash", tool_input: { command: "ls" } }, tmp.env);
    assert.strictEqual(readLedger(tmp.ledger).length, 0);
  } finally {
    tmp.cleanup();
  }
});

test("INV-023: TKR_TASK_SPAWNS_DISABLED=1 suppresses ledger", () => {
  const tmp = withTempLedger();
  try {
    runHook({
      tool_name: "Agent",
      session_id: "sid",
      tool_input: { subagent_type: "Explore", prompt: "x", run_in_background: true },
    }, { ...tmp.env, TKR_TASK_SPAWNS_DISABLED: "1" });
    assert.strictEqual(readLedger(tmp.ledger).length, 0);
  } finally {
    tmp.cleanup();
  }
});

test("INV-023: 5 successive spawns produce 5 rows (P1 gate)", () => {
  const tmp = withTempLedger();
  try {
    const types = ["Explore", "general-purpose", "Plan", "blueprint:reviewer", "codex:rescue"];
    for (const t of types) {
      runHook({
        tool_name: "Agent",
        session_id: "gate-sid",
        tool_input: { subagent_type: t, description: t, prompt: "p", run_in_background: false },
      }, tmp.env);
    }
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 5, "5 spawns => 5 rows");
    const got = rows.map((r) => r.subagent_type);
    assert.deepStrictEqual(got, types, "subagent_type preserved per spawn");
  } finally {
    tmp.cleanup();
  }
});

// ── COMPETE-002 autoroute ─────────────────────────────────────────────

// withAutorouteEnv — temp TKR_STATE_DIR (config.json + decisions.jsonl)
// plus a statusline payload fixture reachable via TKR_STATUSLINE_PATH.
function withAutorouteEnv(payload, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-autoroute-"));
  if (cfg !== undefined) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
  }
  const telPath = path.join(dir, "statusline.json");
  if (payload !== undefined) {
    fs.writeFileSync(telPath, JSON.stringify(payload));
  }
  return {
    dir,
    decisions: path.join(dir, "decisions.jsonl"),
    env: {
      TKR_STATE_DIR: dir,
      TKR_STATUSLINE_PATH: telPath,
      TKR_TASK_SPAWNS_PATH: path.join(dir, "task-spawns.jsonl"),
    },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function exploreEvent(extraInput) {
  return {
    tool_name: "Agent",
    session_id: "autoroute-sid",
    tool_input: {
      subagent_type: "Explore",
      prompt: "map the repo",
      run_in_background: false,
      ...(extraInput || {}),
    },
  };
}

test("autoroute: off by default — no model override even under pressure", () => {
  const t = withAutorouteEnv({ delegate_via: "subagent_haiku", recommend: "delegate", rate_class: "high" });
  try {
    const res = runHook(exploreEvent(), t.env);
    const out = JSON.parse(res.stdout || "{}");
    const updated = out.hookSpecificOutput?.updatedInput;
    // Explore still gets search guidance, but model must be untouched.
    assert.strictEqual(updated.model, undefined, "no model override without opt-in");
    assert.ok(
      !updated.prompt.includes("Execution contract"),
      "no downgrade scaffold without a downgrade",
    );
    assert.ok(!fs.existsSync(t.decisions), "no decision row without opt-in");
  } finally {
    t.cleanup();
  }
});

test("autoroute: enabled + subagent_haiku verdict — model forced to haiku + ledger row", () => {
  const t = withAutorouteEnv(
    { delegate_via: "subagent_haiku", recommend: "delegate", rate_class: "high" },
    { autoroute: { enabled: true } },
  );
  try {
    const res = runHook(exploreEvent(), t.env);
    const out = JSON.parse(res.stdout || "{}");
    const updated = out.hookSpecificOutput?.updatedInput;
    assert.strictEqual(updated.model, "haiku", "model downgraded to haiku");
    // A downgraded spawn gets the execution contract prepended, with the
    // search guidance and original task preserved after it — smaller
    // models need explicit instructions where larger ones absorb
    // ambiguity.
    assert.ok(
      updated.prompt.startsWith("## Execution contract"),
      `scaffold must lead the prompt, got: ${updated.prompt.slice(0, 60)}`,
    );
    assert.ok(updated.prompt.includes("tkr search"), "search guidance preserved");
    assert.ok(updated.prompt.includes("map the repo"), "original task preserved");
    const rows = readLedger(t.decisions);
    assert.strictEqual(rows.length, 1, "one decision row");
    assert.strictEqual(rows[0].event, "autoroute");
    assert.ok(rows[0].ts, "row carries a ts timestamp (DecisionRecord field name)");
    assert.strictEqual(rows[0].delegate_via, "subagent_haiku");
    assert.strictEqual(rows[0].rate_class, "high");
    assert.strictEqual(rows[0].reason, "interceptor:autoroute");
  } finally {
    t.cleanup();
  }
});

test("autoroute: payg_delegate verdict also downgrades to haiku", () => {
  const t = withAutorouteEnv(
    { delegate_via: "payg_delegate", recommend: "delegate", rate_class: "critical" },
    { autoroute: { enabled: true } },
  );
  try {
    const res = runHook(exploreEvent(), t.env);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, "haiku");
  } finally {
    t.cleanup();
  }
});

test("autoroute: explicit model choice always wins", () => {
  const t = withAutorouteEnv(
    { delegate_via: "subagent_haiku", recommend: "delegate", rate_class: "high" },
    { autoroute: { enabled: true } },
  );
  try {
    const res = runHook(exploreEvent({ model: "opus" }), t.env);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, "opus");
    assert.ok(!fs.existsSync(t.decisions), "no decision row when model explicit");
  } finally {
    t.cleanup();
  }
});

test("autoroute: non-Explore spawns untouched", () => {
  const t = withAutorouteEnv(
    { delegate_via: "subagent_haiku", recommend: "delegate", rate_class: "high" },
    { autoroute: { enabled: true } },
  );
  try {
    const res = runHook(
      {
        tool_name: "Agent",
        session_id: "autoroute-sid",
        tool_input: { subagent_type: "general-purpose", prompt: "edit code", run_in_background: true },
      },
      t.env,
    );
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, undefined);
  } finally {
    t.cleanup();
  }
});

test("autoroute: verdict none / stay — untouched", () => {
  const t = withAutorouteEnv(
    { delegate_via: "none", rate_class: "healthy" },
    { autoroute: { enabled: true } },
  );
  try {
    const res = runHook(exploreEvent(), t.env);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, undefined);
    assert.ok(!fs.existsSync(t.decisions));
  } finally {
    t.cleanup();
  }
});

test("autoroute: TKR_AUTOROUTE_DISABLED=1 kill switch", () => {
  const t = withAutorouteEnv(
    { delegate_via: "subagent_haiku", recommend: "delegate", rate_class: "high" },
    { autoroute: { enabled: true } },
  );
  try {
    const res = runHook(exploreEvent(), { ...t.env, TKR_AUTOROUTE_DISABLED: "1" });
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, undefined);
  } finally {
    t.cleanup();
  }
});

test("autoroute: missing payload file — graceful no-op", () => {
  const t = withAutorouteEnv(undefined, { autoroute: { enabled: true } });
  try {
    const res = runHook(exploreEvent(), t.env);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, undefined);
  } finally {
    t.cleanup();
  }
});


test("autoroute: offer-tier verdict (recommend != delegate) does not fire", () => {
  const t = withAutorouteEnv(
    // classifyDelegateVia returns subagent_haiku for ANY non-stay verdict,
    // including offer-tier reasons — the recommend gate must hold the line.
    { delegate_via: "subagent_haiku", recommend: "offer", rate_class: "healthy" },
    { autoroute: { enabled: true } },
  );
  try {
    const res = runHook(exploreEvent(), t.env);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, undefined);
    assert.ok(!fs.existsSync(t.decisions), "no decision row on offer tier");
  } finally {
    t.cleanup();
  }
});

// ── ADR-0033 Phase 4: spawn-time veto ────────────────────────────────────
//
// vetoCheck() spawns the real `tkr` binary by bare name (no TKR_BIN
// indirection — see cmd/tkr/cmd_route_vetocheck.go's doc comment), so
// these tests shim it by putting a fake executable named "tkr" first on
// PATH. POSIX shebang + chmod 0o755, same convention
// hooks/tkr-rewrite.fastpath.test.js already uses for its own tkr shim —
// there is no other precedent in this repo. Windows note: without
// shell:true (which vetoCheck() deliberately does not set, matching the
// production spawnSync call byte for byte), Node's child_process only
// auto-resolves a bare command name to .exe/.com, never .cmd/.bat — so
// this shim mechanism is POSIX-only, exactly like the precedent it
// copies. CI only runs `node --test` on ubuntu-latest (ci.yml), so this
// is the authoritative platform for these tests.

function withTkrShim(responseObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-veto-shim-"));
  const shim = path.join(dir, "tkr");
  fs.writeFileSync(shim, `#!/bin/sh\necho '${JSON.stringify(responseObj)}'\n`);
  fs.chmodSync(shim, 0o755);
  return {
    dir,
    env: { PATH: dir + path.delimiter + (process.env.PATH || "") },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// pathWithoutTkr is a PATH that cannot resolve "tkr" anywhere — an empty
// temp directory, not a filtered copy of the real PATH, so the test does
// not depend on incidental machine state (a dev build of tkr sitting in
// this very repo would otherwise still resolve on some platforms).
function pathWithoutTkr() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-noexist-"));
  return {
    env: { PATH: dir },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function tkrEvent(prompt, extra) {
  return {
    tool_name: "Agent",
    session_id: "veto-sid",
    tool_input: {
      subagent_type: "tkr:explore-haiku",
      prompt,
      run_in_background: true,
      ...(extra || {}),
    },
  };
}

const MUTATING_PROMPT = "edit internal/foo.go and rename X to Y";

test("veto: non-tkr subagent_type never invokes the subprocess or carries ledger veto fields", () => {
  const shim = withTkrShim({ verdict: "deny", reason: "mutation_to_readonly_worker", enforce: true, evaluated: true, mode: "advisory" });
  const tmp = withTempLedger();
  try {
    const res = runHook(
      {
        tool_name: "Agent",
        session_id: "veto-sid-nontkr",
        tool_input: { subagent_type: "general-purpose", prompt: MUTATING_PROMPT, run_in_background: false },
      },
      { ...tmp.env, ...shim.env },
    );
    assert.strictEqual(res.status, 0);
    // Nothing to rewrite (background already false, non-Explore, no work
    // plan, no autoroute) — output stays empty passthrough, exactly as it
    // was before this hook knew about veto at all.
    assert.strictEqual(res.stdout, "", "output must be unchanged from the pre-veto passthrough");
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1);
    assert.ok(!("veto_checked" in rows[0]), "non-tkr profile must never be evaluated");
  } finally {
    shim.cleanup();
    tmp.cleanup();
  }
});

test("veto: TKR_WORK_VETO_DISABLED=1 kill switch — no deny, no veto fields, no subprocess reached", () => {
  const shim = withTkrShim({ verdict: "deny", reason: "mutation_to_readonly_worker", enforce: true, evaluated: true, mode: "advisory" });
  const tmp = withTempLedger();
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), { ...tmp.env, ...shim.env, TKR_WORK_VETO_DISABLED: "1" });
    assert.strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "kill switch must never produce a block decision");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput?.run_in_background, false);
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1);
    assert.ok(!("veto_checked" in rows[0]), "kill switch means the check never ran at all");
  } finally {
    shim.cleanup();
    tmp.cleanup();
  }
});

test("veto: fail-open when the tkr binary is unreachable — spawn proceeds, no deny", () => {
  const noTkr = pathWithoutTkr();
  const tmp = withTempLedger();
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), { ...tmp.env, PATH: noTkr.env.PATH });
    assert.strictEqual(res.status, 0, `hook itself must still exit 0: ${res.stderr}`);
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "a missing/unreachable binary must never block the spawn");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput?.run_in_background, false);
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1);
    assert.ok(!("veto_checked" in rows[0]), "no verdict at all — the check could not run");
  } finally {
    noTkr.cleanup();
    tmp.cleanup();
  }
});

test("veto: deny verdict blocks the spawn — decision:block + permissionDecision:deny, no updatedInput; ledger records veto_denied", () => {
  const shim = withTkrShim({
    verdict: "deny",
    reason: "mutation_to_readonly_worker",
    detail: "profile tkr:explore-haiku is read-only and this task carries mutation intent",
    enforce: true,
    evaluated: true,
    mode: "advisory",
  });
  const tmp = withTempLedger();
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), { ...tmp.env, ...shim.env });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.decision, "block");
    assert.strictEqual(out.reason, "profile tkr:explore-haiku is read-only and this task carries mutation intent");
    assert.strictEqual(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
    assert.strictEqual(
      out.hookSpecificOutput.permissionDecisionReason,
      "profile tkr:explore-haiku is read-only and this task carries mutation intent",
    );
    assert.ok(!("updatedInput" in out.hookSpecificOutput), "a deny must never carry updatedInput");

    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1, "the ledger row must still be written before the deny short-circuit");
    assert.strictEqual(rows[0].veto_checked, true);
    assert.strictEqual(rows[0].veto_denied, true);
    assert.strictEqual(rows[0].veto_reason, "mutation_to_readonly_worker");
  } finally {
    shim.cleanup();
    tmp.cleanup();
  }
});

test("veto: observe (would_deny) verdict never blocks — row records veto_would_deny, not veto_denied", () => {
  const shim = withTkrShim({
    verdict: "allow",
    reason: "mutation_to_readonly_worker",
    enforce: false,
    would_deny: true,
    evaluated: true,
    mode: "observe",
  });
  const tmp = withTempLedger();
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), { ...tmp.env, ...shim.env });
    assert.strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "observe must never block the spawn");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput?.run_in_background, false);

    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows[0].veto_checked, true);
    assert.strictEqual(rows[0].veto_denied, false);
    assert.strictEqual(rows[0].veto_would_deny, true);
  } finally {
    shim.cleanup();
    tmp.cleanup();
  }
});

test("autoroute: stale payload (mtime beyond max age) does not fire", () => {
  const t = withAutorouteEnv(
    { delegate_via: "subagent_haiku", recommend: "delegate", rate_class: "high" },
    { autoroute: { enabled: true } },
  );
  try {
    const telPath = t.env.TKR_STATUSLINE_PATH;
    const old = (Date.now() - 11 * 60 * 1000) / 1000; // 11 min ago (max 10)
    fs.utimesSync(telPath, old, old);
    const res = runHook(exploreEvent(), t.env);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput.model, undefined);
    assert.ok(!fs.existsSync(t.decisions), "no decision row on stale verdict");
  } finally {
    t.cleanup();
  }
});
