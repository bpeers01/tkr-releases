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
    assert.strictEqual(r.schema_version, 6);
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
// vetoCheck() resolves the binary through lib/tkr-bin.js, so these tests
// shim it by pointing TKR_BIN at a JS file: the resolver launches a
// .js/.cjs/.mjs target as `node <path>`, which runs identically on every
// platform.
//
// This replaces a PATH shim — an extensionless `#!/bin/sh` file named
// `tkr` placed first on PATH — that was POSIX-only by construction.
// Without shell:true (which vetoCheck deliberately does not set, matching
// production byte for byte) Node resolves a bare command name only to
// .exe/.com on Windows, and refuses .cmd/.bat outright. On Windows the
// shim therefore could not execute, and three of the four tests assert
// that NO deny happened — trivially true when the check cannot run — so
// they passed vacuously and would have kept passing with the veto deleted.
// That is why #143 finding 1 could not be validated on the platform that
// has the problem, and why the fix had to start here rather than at the
// timeout (see the issue thread).

function withTkrShim(responseObj, { delayMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-veto-shim-"));
  const shim = path.join(dir, "tkr-shim.js");
  // Drains stdin first: vetoCheck writes the VetoInput payload, and a shim
  // that exits without reading it makes the parent's write fail with EPIPE
  // on some platforms — which would look like an unrelated transport error.
  const body =
    `process.stdin.resume();\n` +
    `process.stdin.on("data", () => {});\n` +
    `const reply = () => process.stdout.write(${JSON.stringify(JSON.stringify(responseObj))} + "\\n");\n` +
    (delayMs > 0 ? `setTimeout(reply, ${delayMs});\n` : `reply();\n`);
  fs.writeFileSync(shim, body);
  return {
    dir,
    env: { TKR_BIN: shim },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// pathWithoutTkr makes the binary unresolvable. resolveTkrBin has THREE
// candidate sources and all three have to miss, or the "unreachable" case
// cannot be expressed:
//
//   1. TKR_BIN            → names a file that does not exist
//   2. the platform install path → derived from HOME/USERPROFILE/
//                           LOCALAPPDATA, so those are pointed at the empty
//                           temp dir too
//   3. bare "tkr" via PATH → PATH is that same empty temp dir
//
// Emptying only PATH is not enough on Windows, where a real installed
// tkr.exe lives under %USERPROFILE%\.local\bin or %LOCALAPPDATA%: candidate
// 2 resolves, the check answers, and a test asserting "no verdict at all"
// fails on the one platform finding 1 is about. Same neutering that
// lib/tkr-bin.test.js already does by passing its own HOME.
//
// Not a filtered copy of the real PATH — a dev build of tkr sitting in this
// very repo would otherwise still resolve on some platforms and the test
// would depend on incidental machine state.
function pathWithoutTkr() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-noexist-"));
  return {
    env: {
      PATH: dir,
      TKR_BIN: path.join(dir, "definitely-not-here"),
      HOME: dir,
      USERPROFILE: dir,
      LOCALAPPDATA: dir,
    },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// withStateDir gives the hook a private TKR_STATE_DIR, optionally
// pre-seeded with the work-mode cache that condition 3 of the fail-closed
// scope reads (lib/veto-fallback.js).
//
// Every veto test that can reach a timeout MUST use this. Without it
// stateDir() resolves to the developer's real ~/.tkr, so whether a timeout
// denies would depend on whether that machine happens to hold a cached
// enforcing mode — the test would pass or fail on incidental state, and it
// would do so in the direction that hides a regression.
function withStateDir(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-veto-state-"));
  if (mode) {
    fs.writeFileSync(
      path.join(dir, "veto-mode.json"),
      JSON.stringify({ mode, at: new Date().toISOString() }),
    );
  }
  return {
    dir,
    env: { TKR_STATE_DIR: dir },
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
    // Both halves of pathWithoutTkr, not just PATH: on Windows tkr-bin.js
    // resolves the platform install path before it ever falls back to a
    // bare name, so an emptied PATH alone leaves a real installed binary
    // reachable and the check answers instead of failing to run.
    const res = runHook(tkrEvent(MUTATING_PROMPT), { ...tmp.env, ...noTkr.env });
    assert.strictEqual(res.status, 0, `hook itself must still exit 0: ${res.stderr}`);
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "a missing/unreachable binary must never block the spawn");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput?.run_in_background, false);
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1);
    assert.ok(!("veto_checked" in rows[0]), "no verdict at all — the check could not run");
    assert.strictEqual(
      rows[0].veto_unavailable,
      "unreachable",
      "a check that was attempted and could not run must say so",
    );
  } finally {
    noTkr.cleanup();
    tmp.cleanup();
  }
});

// ── #143 finding 1: the fail-open is now measurable ──────────────────────
//
// Fail-open behavior is unchanged and must stay unchanged — these assert
// that no denial happens. What is new is that the ledger distinguishes
// "nobody asked" from "we asked and got no answer". On Windows, where a
// bare spawn degrades to 4-6s under multi-session load against a 500ms
// budget, the timeout case is the one that actually fires, and it used to
// be indistinguishable from a spawn the veto has no opinion about.

test("veto: a timed-out check fails open AND records veto_unavailable:timeout", () => {
  // Shim sleeps well past the budget the hook is given.
  const shim = withTkrShim({ verdict: "deny", enforce: true, evaluated: true }, { delayMs: 2000 });
  const tmp = withTempLedger();
  // No cached mode — a fresh install has no evidence that this environment
  // enforces anything, so the fail-closed branch must not engage.
  const state = withStateDir(null);
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), {
      ...tmp.env,
      ...shim.env,
      ...state.env,
      TKR_VETO_TIMEOUT_MS: "150",
    });
    assert.strictEqual(res.status, 0, `hook must still exit 0: ${res.stderr}`);
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "a timeout with no cached enforcing mode stays fail-open");
    assert.strictEqual(out.hookSpecificOutput?.updatedInput?.run_in_background, false);
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1);
    assert.ok(!("veto_checked" in rows[0]), "a timeout produced no verdict");
    assert.strictEqual(rows[0].veto_unavailable, "timeout");
    assert.ok(!("veto_local_deny" in rows[0]), "nothing was denied locally");
  } finally {
    shim.cleanup();
    tmp.cleanup();
    state.cleanup();
  }
});

test("veto: a timeout DENIES the mutation-to-read-only class once a mode is known", () => {
  // The whole point of finding 1's second half. Everything here is the
  // fail-open case above plus one fact: a previous check in this
  // environment reported an enforcing mode. That is the evidence the hook
  // needs to treat an unanswered check as a hung binary rather than an
  // unconfigured install, and to refuse the one spawn class whose fail-open
  // cost cannot be recovered — a read-only profile handed a mutating task,
  // which either never happens or lands unreviewed through Bash.
  const shim = withTkrShim({ verdict: "deny", enforce: true, evaluated: true }, { delayMs: 2000 });
  const tmp = withTempLedger();
  const state = withStateDir("advisory");
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), {
      ...tmp.env,
      ...shim.env,
      ...state.env,
      TKR_VETO_TIMEOUT_MS: "150",
    });
    assert.strictEqual(res.status, 0, `hook must still exit 0: ${res.stderr}`);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.decision, "block", "this is the class a timeout must not wave through");
    assert.strictEqual(out.hookSpecificOutput?.permissionDecision, "deny");
    assert.ok(
      !out.hookSpecificOutput?.updatedInput,
      "a denied call is never also rewritten",
    );
    assert.match(
      out.reason || "",
      /read-only/i,
      "the reason must tell the coordinator what to re-issue, not just that it failed",
    );
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows.length, 1);
    // The honesty half: policy never answered, so the row must not claim a
    // check ran. The denial is recorded as what it is — the hook's own.
    assert.ok(!("veto_checked" in rows[0]), "no policy verdict exists to report");
    assert.ok(!("veto_denied" in rows[0]), "veto_denied means POLICY refused; it did not");
    assert.strictEqual(rows[0].veto_unavailable, "timeout");
    assert.strictEqual(rows[0].veto_local_deny, true);
    assert.strictEqual(rows[0].veto_local_reason, "veto_check_timeout");
  } finally {
    shim.cleanup();
    tmp.cleanup();
    state.cleanup();
  }
});

test("veto: a timeout under a non-enforcing cached mode still fails open", () => {
  // observe computes verdicts but acts on none of them, so a timeout under
  // it has nothing to enforce and denying would invent policy the operator
  // deliberately did not ask for.
  const shim = withTkrShim({ verdict: "deny", enforce: true, evaluated: true }, { delayMs: 2000 });
  const tmp = withTempLedger();
  const state = withStateDir("observe");
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), {
      ...tmp.env,
      ...shim.env,
      ...state.env,
      TKR_VETO_TIMEOUT_MS: "150",
    });
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "observe never blocks, timeout or not");
    const rows = readLedger(tmp.ledger);
    assert.ok(!("veto_local_deny" in rows[0]));
  } finally {
    shim.cleanup();
    tmp.cleanup();
    state.cleanup();
  }
});

test("veto: a timeout on a read-only task is allowed even in an enforcing mode", () => {
  // INV-088: the advise rubric tells coordinators to STATE constraints, so
  // well-written read-only contracts routinely NAME mutation verbs in order
  // to forbid them. If the detector ignored negation, the best-written
  // spawn contracts would be exactly the ones a timeout blocked.
  const shim = withTkrShim({ verdict: "deny", enforce: true, evaluated: true }, { delayMs: 2000 });
  const tmp = withTempLedger();
  const state = withStateDir("advisory");
  try {
    const res = runHook(
      tkrEvent("Read internal/route/veto.go and summarize it. Do not edit anything."),
      { ...tmp.env, ...shim.env, ...state.env, TKR_VETO_TIMEOUT_MS: "150" },
    );
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "a stated no-edit constraint must not read as mutation intent");
    const rows = readLedger(tmp.ledger);
    assert.ok(!("veto_local_deny" in rows[0]));
    assert.strictEqual(rows[0].veto_unavailable, "timeout");
  } finally {
    shim.cleanup();
    tmp.cleanup();
    state.cleanup();
  }
});

test("veto: TKR_VETO_TIMEOUT_MS raises the budget — the same slow check now completes and denies", () => {
  // The delay exceeds the 500ms DEFAULT budget, so this deny is reachable
  // only because the override raised it. That is what makes this a timeout
  // test rather than a "does the shim work" test — and it is the property a
  // Windows operator needs, where the default is the thing that fails.
  const shim = withTkrShim({
    verdict: "deny",
    reason: "mutation_to_readonly_worker",
    enforce: true,
    evaluated: true,
    mode: "assisted",
  }, { delayMs: 1200 });
  const tmp = withTempLedger();
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), {
      ...tmp.env,
      ...shim.env,
      TKR_VETO_TIMEOUT_MS: "8000",
    });
    assert.strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout || "{}");
    assert.strictEqual(out.decision, "block", "the verdict arrives when the budget allows it");
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows[0].veto_checked, true);
    assert.strictEqual(rows[0].veto_denied, true);
    assert.ok(!("veto_unavailable" in rows[0]), "a completed check is not unavailable");
  } finally {
    shim.cleanup();
    tmp.cleanup();
  }
});

test("veto: an unusable response records veto_unavailable:bad_response, not a denial", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-veto-junk-"));
  const shim = path.join(dir, "tkr-shim.js");
  fs.writeFileSync(
    shim,
    `process.stdin.resume();\nprocess.stdin.on("data", () => {});\nprocess.stdout.write("not json at all\\n");\n`,
  );
  const tmp = withTempLedger();
  try {
    const res = runHook(tkrEvent(MUTATING_PROMPT), { ...tmp.env, TKR_BIN: shim });
    assert.strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout || "{}");
    assert.ok(!out.decision, "unparseable output is not a denial");
    const rows = readLedger(tmp.ledger);
    assert.strictEqual(rows[0].veto_unavailable, "bad_response");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    tmp.cleanup();
  }
});

test("veto: never-attempted checks stay silent — no veto_unavailable for non-tkr profiles or the kill switch", () => {
  // The exclusivity that lets a v4 reader keep its meaning: absence of BOTH
  // keys still means "no check was attempted". If a never-attempted check
  // wrote veto_unavailable, every ordinary Explore spawn would look like a
  // veto failure and the new counter would be pure noise.
  for (const [label, event, extraEnv] of [
    ["non-tkr profile", { tool_name: "Agent", session_id: "s", tool_input: { subagent_type: "Explore", prompt: MUTATING_PROMPT, run_in_background: true } }, {}],
    ["kill switch", tkrEvent(MUTATING_PROMPT), { TKR_WORK_VETO_DISABLED: "1" }],
  ]) {
    const shim = withTkrShim({ verdict: "deny", enforce: true, evaluated: true });
    const tmp = withTempLedger();
    try {
      runHook(event, { ...tmp.env, ...shim.env, ...extraEnv });
      const rows = readLedger(tmp.ledger);
      assert.strictEqual(rows.length, 1, `${label}: expected one row`);
      assert.ok(!("veto_checked" in rows[0]), `${label}: no check ran`);
      assert.ok(
        !("veto_unavailable" in rows[0]),
        `${label}: a check that was never attempted has nothing to report`,
      );
    } finally {
      shim.cleanup();
      tmp.cleanup();
    }
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
