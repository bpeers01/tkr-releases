#!/usr/bin/env node
// Probe test for hooks/session-start.js — verifies PLAN-1 think-in-code
// rule appears in stdout when brevity mode is full or ultra.
//
// Run: node hooks/session-start.test.js
//
// Uses node:test (Node 18+ built-in). Each case spawns the hook with a
// temp TKR_STATE_DIR seeded with the target brevity-mode flag, then
// asserts the expected substring is present in stdout.

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "session-start.js");

// Windows-tolerant tmp cleanup. SessionStart spawns detached background
// scans (L0R / memory-nudge / etc.) that briefly hold file handles past
// test exit, causing ENOTEMPTY / EPERM on rmSync. OS reaps eventually;
// silencing here is best-effort cleanup, not a correctness gap.
function safeRmSync(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (!e) return;
    if (e.code === "ENOTEMPTY" || e.code === "EPERM" || e.code === "EBUSY") return;
    throw e;
  }
}

function runHookWithMode(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-test-"));
  if (mode) fs.writeFileSync(path.join(tmp, "brevity-mode"), mode);
  try {
    // Scrub TKR_SYSPROMPT so standing guidance is emitted even when the
    // test runner is itself a `tkr claude` session (which sets the marker).
    const env = { ...process.env, TKR_STATE_DIR: tmp, CLAUDE_PROJECT_DIR: tmp };
    delete env.TKR_SYSPROMPT;
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      // CLAUDE_PROJECT_DIR pinned to tmp so the file-first /continue
      // advisory does not see the repo's real .continue-here.md.
      env,
      encoding: "utf8",
    });
    return res;
  } finally {
    safeRmSync(tmp);
  }
}

// Wave 2 helper: spawn session-start.js with a seeded pinned-budget cache.
function runHookWithPinnedCache(cache, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-l0-"));
  fs.writeFileSync(path.join(tmp, "pinned-budget.json"), JSON.stringify(cache));
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ source: "startup", session_id: "ss-l0-test" }),
      env: {
        ...process.env,
        TKR_STATE_DIR: tmp,
        CLAUDE_PROJECT_DIR: tmp,
        ...extraEnv,
      },
      encoding: "utf8",
    });
    let ledgerLines = [];
    const ledgerPath = path.join(tmp, "playbook-events.jsonl");
    if (fs.existsSync(ledgerPath)) {
      ledgerLines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    }
    return { res, ledgerLines };
  } finally {
    safeRmSync(tmp);
  }
}

test("full mode emits think-in-code rule", () => {
  const res = runHookWithMode("full");
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(
    res.stdout.includes("program the analysis"),
    `stdout missing 'program the analysis':\n${res.stdout}`,
  );
  assert.ok(res.stdout.includes("Brevity mode: full"));
});

test("ultra mode emits think-in-code rule", () => {
  const res = runHookWithMode("ultra");
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(
    res.stdout.includes("program the analysis"),
    `stdout missing 'program the analysis':\n${res.stdout}`,
  );
  assert.ok(res.stdout.includes("Brevity mode: ultra"));
});

test("lite mode omits think-in-code rule", () => {
  const res = runHookWithMode("lite");
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(
    !res.stdout.includes("program the analysis"),
    "lite mode must not carry think-in-code",
  );
});

test("off mode emits no brevity section", () => {
  const res = runHookWithMode("off");
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(!res.stdout.includes("Brevity mode:"));
  assert.ok(!res.stdout.includes("program the analysis"));
});

// Guidance-block smoke-bound: catches pathological bloat (e.g., leaked
// debug payloads). Baseline grew with the 2026-05-10 planning-context
// nudge (~290 → ~491 tokens full-mode); the 2026-05-12 cache-mechanics
// nudge (PR #3 of injection-discipline proposal) adds ~350 raw tok.
// Cap raised 600 → 1000 to cover the new framing block plus headroom.
test("full-mode guidance stays under smoke-bound token ceiling", () => {
  const res = runHookWithMode("full");
  const approxTokens = Math.ceil(res.stdout.length / 4);
  assert.ok(
    approxTokens <= 1000,
    `full-mode guidance = ~${approxTokens} tokens; smoke-cap 1000`,
  );
});

// Wave 2 — L0 pinned-budget tests
test("L0 warning fires when actual_tok > budget_tok", () => {
  const { res, ledgerLines } = runHookWithPinnedCache({
    updated_at: new Date().toISOString(),
    budget_tok: 12000,
    actual_tok: 18420,
    delta_tok: 6420,
    biggest_offender: "global CLAUDE.md chain (8210 tok)",
  });
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(res.stdout.includes("[L0 pinned-budget]"), `missing L0 line:\n${res.stdout}`);
  assert.ok(res.stdout.includes("delta=6420tok"));
  assert.strictEqual(ledgerLines.length, 1, "expected one L0 fired event");
  const evt = JSON.parse(ledgerLines[0]);
  assert.strictEqual(evt.layer, "L0");
  assert.strictEqual(evt.event, "fired");
  assert.strictEqual(evt.trigger_state.pinned_actual_tok, 18420);
  assert.strictEqual(evt.trigger_state.pinned_budget_tok, 12000);
});

test("L0 suppressed when within budget", () => {
  const { res, ledgerLines } = runHookWithPinnedCache({
    updated_at: new Date().toISOString(),
    budget_tok: 12000,
    actual_tok: 8000,
    delta_tok: -4000,
    biggest_offender: "global (3000 tok)",
  });
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[L0 pinned-budget]"), "should not warn within budget");
  assert.strictEqual(ledgerLines.length, 0, "no L0 fired event when within budget");
});

test("L0 disabled by TKR_PLAYBOOK_L0_DISABLED", () => {
  const { res, ledgerLines } = runHookWithPinnedCache(
    { updated_at: new Date().toISOString(), budget_tok: 12000, actual_tok: 18420, delta_tok: 6420 },
    { TKR_PLAYBOOK_L0_DISABLED: "1" },
  );
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[L0 pinned-budget]"), "L0 must respect kill switch");
  assert.strictEqual(ledgerLines.length, 0);
});

test("L0 disabled by global TKR_PLAYBOOK_DISABLED", () => {
  const { res, ledgerLines } = runHookWithPinnedCache(
    { updated_at: new Date().toISOString(), budget_tok: 12000, actual_tok: 18420, delta_tok: 6420 },
    { TKR_PLAYBOOK_DISABLED: "1" },
  );
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[L0 pinned-budget]"));
  assert.strictEqual(ledgerLines.length, 0);
});

// Wave 7 — L0R /continue advisory tests (proposal 2026-05-10, revised 2026-05-17).
// Helper: spawn session-start.js with a seeded last-session-cw.json cache.
//
// CLAUDE_PROJECT_DIR pinned to the tmp dir so the FILE PATH check in
// continue.js doesn't find the repo's real .continue-here.md and fire
// the file-fresh advisory; these tests cover the JSONL FALLBACK branch.
function runHookWithLastSessionCache(cache, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-l0r-"));
  if (cache) {
    fs.writeFileSync(path.join(tmp, "last-session-cw.json"), JSON.stringify(cache));
  }
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ source: "startup", session_id: "ss-l0r-test" }),
      env: {
        ...process.env,
        TKR_STATE_DIR: tmp,
        CLAUDE_PROJECT_DIR: tmp,
        ...extraEnv,
      },
      encoding: "utf8",
    });
    let ledgerLines = [];
    const ledgerPath = path.join(tmp, "playbook-events.jsonl");
    if (fs.existsSync(ledgerPath)) {
      ledgerLines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    }
    return { res, ledgerLines };
  } finally {
    safeRmSync(tmp);
  }
}

// File-first helper — seed .tkr/handoffs/<id>.md in CLAUDE_PROJECT_DIR
// with a specific mtime offset (ms ago) so the FILE PATH branch can be
// exercised independently of the JSONL cache.
function runHookWithHandoffFile(mtimeAgoMs, { cache = null, extraEnv = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cont-"));
  const handoffsDir = path.join(tmp, ".tkr", "handoffs");
  fs.mkdirSync(handoffsDir, { recursive: true });
  const filePath = path.join(handoffsDir, "ss-cont-test-20260521-0000.md");
  fs.writeFileSync(filePath, "# handoff\n\n## Next Action\n- test\n");
  if (mtimeAgoMs > 0) {
    const t = (Date.now() - mtimeAgoMs) / 1000;
    fs.utimesSync(filePath, t, t);
  }
  if (cache) {
    fs.writeFileSync(path.join(tmp, "last-session-cw.json"), JSON.stringify(cache));
  }
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ source: "clear", session_id: "ss-cont-test" }),
      env: {
        ...process.env,
        TKR_STATE_DIR: tmp,
        CLAUDE_PROJECT_DIR: tmp,
        ...extraEnv,
      },
      encoding: "utf8",
    });
    let ledgerLines = [];
    const ledgerPath = path.join(tmp, "playbook-events.jsonl");
    if (fs.existsSync(ledgerPath)) {
      ledgerLines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    }
    return { res, ledgerLines };
  } finally {
    safeRmSync(tmp);
  }
}

test("L0R fires when prior cum_cw > 200K AND away_summary present", () => {
  const { res, ledgerLines } = runHookWithLastSessionCache({
    updated_at: new Date().toISOString(),
    prior_session_id: "abcd1234-prior",
    prior_cum_cw: 350000,
    away_summary: "shipped wave 6",
    away_summary_seen: true,
  });
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(res.stdout.includes("[continue]"), `missing L0R line:\n${res.stdout}`);
  assert.ok(res.stdout.includes("350K"));
  const l0rEvents = ledgerLines
    .map((l) => JSON.parse(l))
    .filter((e) => e.layer === "L0R");
  assert.strictEqual(l0rEvents.length, 1, "expected one L0R fired event");
  assert.strictEqual(l0rEvents[0].event, "fired");
  assert.strictEqual(l0rEvents[0].trigger_state.prior_session_cw, 350000);
  assert.strictEqual(l0rEvents[0].trigger_state.away_summary_seen, true);
});

test("L0R suppressed when cum_cw below 200K", () => {
  const { res, ledgerLines } = runHookWithLastSessionCache({
    updated_at: new Date().toISOString(),
    prior_session_id: "small-prior",
    prior_cum_cw: 50000,
    away_summary: "small session",
    away_summary_seen: true,
  });
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"), "L0R must respect cw threshold");
  const l0rEvents = ledgerLines
    .map((l) => JSON.parse(l))
    .filter((e) => e.layer === "L0R");
  assert.strictEqual(l0rEvents.length, 0);
});

test("L0R suppressed when away_summary missing", () => {
  const { res, ledgerLines } = runHookWithLastSessionCache({
    updated_at: new Date().toISOString(),
    prior_session_id: "no-away",
    prior_cum_cw: 500000,
    away_summary: "",
    away_summary_seen: false,
  });
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"));
  const l0rEvents = ledgerLines
    .map((l) => JSON.parse(l))
    .filter((e) => e.layer === "L0R");
  assert.strictEqual(l0rEvents.length, 0);
});

test("L0R disabled by TKR_PLAYBOOK_L0R_DISABLED", () => {
  const { res, ledgerLines } = runHookWithLastSessionCache(
    {
      updated_at: new Date().toISOString(),
      prior_session_id: "p",
      prior_cum_cw: 350000,
      away_summary: "x",
      away_summary_seen: true,
    },
    { TKR_PLAYBOOK_L0R_DISABLED: "1" },
  );
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"));
  const l0rEvents = ledgerLines
    .map((l) => JSON.parse(l))
    .filter((e) => e.layer === "L0R");
  assert.strictEqual(l0rEvents.length, 0);
});

test("L0R disabled by TKR_PLAYBOOK_EXTENSIONS_DISABLED", () => {
  const { res, ledgerLines } = runHookWithLastSessionCache(
    {
      updated_at: new Date().toISOString(),
      prior_session_id: "p",
      prior_cum_cw: 350000,
      away_summary: "x",
      away_summary_seen: true,
    },
    { TKR_PLAYBOOK_EXTENSIONS_DISABLED: "1" },
  );
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"));
  const l0rEvents = ledgerLines
    .map((l) => JSON.parse(l))
    .filter((e) => e.layer === "L0R");
  assert.strictEqual(l0rEvents.length, 0);
});

test("L0R disabled by global TKR_PLAYBOOK_DISABLED", () => {
  const { res, ledgerLines } = runHookWithLastSessionCache(
    {
      updated_at: new Date().toISOString(),
      prior_session_id: "p",
      prior_cum_cw: 350000,
      away_summary: "x",
      away_summary_seen: true,
    },
    { TKR_PLAYBOOK_DISABLED: "1" },
  );
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"));
  const l0rEvents = ledgerLines
    .map((l) => JSON.parse(l))
    .filter((e) => e.layer === "L0R");
  assert.strictEqual(l0rEvents.length, 0);
});

test("L0R silent when cache missing (cold) — schedules background scan", () => {
  const { res, ledgerLines } = runHookWithLastSessionCache(null);
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"), "cold cache must be silent");
  const l0rEvents = ledgerLines
    .map((l) => JSON.parse(l))
    .filter((e) => e.layer === "L0R");
  assert.strictEqual(l0rEvents.length, 0);
});

test("L0R uses stale cache to fire (signal stable across 5min boundary)", () => {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10min old
  const { res } = runHookWithLastSessionCache({
    updated_at: stale,
    prior_session_id: "stale-prior",
    prior_cum_cw: 400000,
    away_summary: "stale but valid",
    away_summary_seen: true,
  });
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes("[continue]"), "stale cache should still emit");
});

// File-first tests — .continue-here.md mtime gating (revised 2026-05-17).

test("[continue] fires file_fresh path when handoff mtime < 24h", () => {
  const oneHourAgo = 60 * 60 * 1000;
  const { res, ledgerLines } = runHookWithHandoffFile(oneHourAgo);
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(res.stdout.includes("[continue]"), `missing advisory:\n${res.stdout}`);
  assert.ok(
    res.stdout.includes("fresh handoff"),
    `expected fresh-handoff wording:\n${res.stdout}`,
  );
  const l0r = ledgerLines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L0R");
  assert.strictEqual(l0r.length, 1);
  assert.strictEqual(l0r[0].trigger_state.path, "v2_fresh");
});

test("[continue] fires v2_stale path when handoff mtime 24h-3d", () => {
  const twoDaysAgo = 2 * 24 * 60 * 60 * 1000;
  const { res, ledgerLines } = runHookWithHandoffFile(twoDaysAgo);
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes("[continue]"));
  assert.ok(
    res.stdout.includes("d old"),
    `expected stale-handoff wording (N d old):\n${res.stdout}`,
  );
  const l0r = ledgerLines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L0R");
  assert.strictEqual(l0r.length, 1);
  assert.strictEqual(l0r[0].trigger_state.path, "v2_stale");
});

test("[continue] ignores handoff file >3d and falls through to JSONL", () => {
  const fiveDaysAgo = 5 * 24 * 60 * 60 * 1000;
  // No cache → JSONL fallback returns "" (cold cache silent). File too
  // old to fire either fresh or stale. Net: silent.
  const { res, ledgerLines } = runHookWithHandoffFile(fiveDaysAgo);
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"), `should be silent:\n${res.stdout}`);
  const l0r = ledgerLines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L0R");
  assert.strictEqual(l0r.length, 0);
});

test("[continue] file >3d still triggers JSONL fallback when cache valid", () => {
  const fiveDaysAgo = 5 * 24 * 60 * 60 * 1000;
  const { res, ledgerLines } = runHookWithHandoffFile(fiveDaysAgo, {
    cache: {
      updated_at: new Date().toISOString(),
      prior_session_id: "old-file-fresh-cache",
      prior_cum_cw: 350000,
      away_summary: "fallback should fire",
      away_summary_seen: true,
    },
  });
  assert.strictEqual(res.status, 0);
  assert.ok(res.stdout.includes("[continue]"));
  assert.ok(
    res.stdout.includes("350K"),
    `expected JSONL-fallback wording with cum_cw:\n${res.stdout}`,
  );
  const l0r = ledgerLines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L0R");
  assert.strictEqual(l0r.length, 1);
  assert.strictEqual(l0r[0].trigger_state.path, "jsonl_fallback");
});

test("[continue] file_fresh respects TKR_PLAYBOOK_L0R_DISABLED", () => {
  const oneHourAgo = 60 * 60 * 1000;
  const { res, ledgerLines } = runHookWithHandoffFile(oneHourAgo, {
    extraEnv: { TKR_PLAYBOOK_L0R_DISABLED: "1" },
  });
  assert.strictEqual(res.status, 0);
  assert.ok(!res.stdout.includes("[continue]"));
  const l0r = ledgerLines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L0R");
  assert.strictEqual(l0r.length, 0);
});

// Planning-context nudge tests — capability hint for planners.
// Default on; opt-out via cfg.planning.nudge=false or TKR_PLANNING_NUDGE_DISABLED=1.
test("planning nudge present by default", () => {
  const res = runHookWithMode("full");
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(
    res.stdout.includes("Plan context-aware"),
    `stdout missing planning nudge:\n${res.stdout}`,
  );
});

test("planning nudge omitted when cfg.planning.nudge=false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-plan-cfg-"));
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ planning: { nudge: false } }),
  );
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env: { ...process.env, TKR_STATE_DIR: tmp },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      !res.stdout.includes("Plan context-aware"),
      "config opt-out must suppress planning nudge",
    );
  } finally {
    safeRmSync(tmp);
  }
});

test("planning nudge omitted when TKR_PLANNING_NUDGE_DISABLED=1", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-plan-env-"));
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env: {
        ...process.env,
        TKR_STATE_DIR: tmp,
        TKR_PLANNING_NUDGE_DISABLED: "1",
      },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      !res.stdout.includes("Plan context-aware"),
      "env opt-out must suppress planning nudge",
    );
  } finally {
    safeRmSync(tmp);
  }
});

// Cache-mechanics nudge tests — PR #3 of injection-discipline proposal
// (docs/proposals/2026-05-12-prefix-aware-context-injection.md §3.1).
// Wording is FROZEN per §5 Q4; tests pin the verbatim emitted block.
const CACHE_MECH_GOLDEN = [
  "**Cache mechanics.** Prefix bakes turn 1, re-reads at ~10% rate across",
  "session. 1K early token = 20K effective at 200 turns. TTL = 5min idle.",
  "",
  "**State signals.** `[tkr: ...]` lines surface live constraints when meaningful:",
  "ctx=NK (window), turn=N (cache multiplier), age=Ns (TTL), 5h/7d=N% (burn).",
  "Fields surface when configured thresholds cross — see `tkr config get",
  "injection.thresholds`; ranges may tune over time.",
  "",
  "**Next-action by state.** Compose ctx + turn + rate-limit:",
  "",
  "  ctx<100K + 7d<50%:  routine — no constraints",
  "  ctx 100-200K:       search before read; tkr_read for exploration;",
  "                      delegate cold-domain work",
  "  ctx 200-250K:       no new heavy work; finish current task;",
  "                      suggest /clear or handoff",
  "  ctx ≥250K (SOFT):   handoff or /clear before continuing",
  "  ctx ≥300K (HARD):   costs compounding; refuse heavy work; clear first",
  "",
  `Rate-limit overlays: 7d≥70% adds "suggest user pause"; 7d≥85% adds`,
  `"suggest user stop session entirely."`,
  "",
  "**Trajectory.** Early in heavy work → delegate cold domains, /clear at",
  "module boundaries. Wrapping up (commit/PR/docs imminent) → push through;",
  "natural break coming. Decide by leverage × distance to next break.",
  "",
  "**State on demand.** Call `tkr signals --current` during planning, before",
  "delegating, before suggesting /clear, or when uncertain about session",
  "phase. ~80ms; no token cost between turns.",
].join("\n");

test("cache-mechanics nudge present by default with verbatim wording", () => {
  const res = runHookWithMode("full");
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(
    res.stdout.includes(CACHE_MECH_GOLDEN),
    `stdout missing verbatim cache-mechanics nudge.\nExpected substring:\n${CACHE_MECH_GOLDEN}\n---\nGot:\n${res.stdout}`,
  );
});

test("cache-mechanics nudge omitted when TKR_CACHE_MECHANICS_DISABLED=1", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cm-env-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env: {
        ...process.env,
        TKR_STATE_DIR: tmp,
        TKR_CACHE_MECHANICS_DISABLED: "1",
      },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      !res.stdout.includes("**Cache mechanics.**"),
      "env opt-out must suppress cache-mechanics nudge",
    );
  } finally {
    safeRmSync(tmp);
  }
});

test("cache-mechanics nudge omitted when cfg.cache_mechanics.nudge=false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cm-cfg-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ cache_mechanics: { nudge: false } }),
  );
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env: { ...process.env, TKR_STATE_DIR: tmp },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      !res.stdout.includes("**Cache mechanics.**"),
      "config opt-out must suppress cache-mechanics nudge",
    );
  } finally {
    safeRmSync(tmp);
  }
});

// Hardened planning-nudge: drop "Quality first; cost as tiebreaker"
// softening; new wording leads with cost-IS-the-lever framing.
test("planning nudge uses hardened cost-IS-the-lever framing", () => {
  const res = runHookWithMode("full");
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.ok(
    res.stdout.includes("Cost compounds — turn-1 token = 21× effective"),
    `stdout missing hardened planning framing:\n${res.stdout}`,
  );
  assert.ok(
    !res.stdout.includes("Quality first; cost as tiebreaker"),
    "old softening must be gone — cost IS the lever, not a tiebreaker",
  );
});

// Threshold config reader — unit test of loadInjectionThresholds().
// Defaults shipped here so PR #4 (Channel 1 state line) can consume them.
test("loadInjectionThresholds returns defaults when config missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-thr-def-"));
  const prevEnv = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = tmp;
  try {
    // Force fresh module load so module-scoped TKR_STATE_DIR re-evaluates.
    delete require.cache[require.resolve("./session-start.js")];
    const m = require("./session-start.js");
    const t = m.loadInjectionThresholds();
    assert.deepStrictEqual(t, {
      ctx_k: 75,
      turn: 50,
      age_s: 200,
      fivehour_pct: 40,
      sevenday_pct: 50,
    });
    assert.deepStrictEqual(t, m.INJECTION_THRESHOLD_DEFAULTS);
  } finally {
    if (prevEnv === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevEnv;
    delete require.cache[require.resolve("./session-start.js")];
    safeRmSync(tmp);
  }
});

test("loadInjectionThresholds honors user overrides; falls back per-field", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-thr-over-"));
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({
      injection: {
        thresholds: { ctx_k: 100, turn: 80, sevenday_pct: 60 },
      },
    }),
  );
  const prevEnv = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = tmp;
  try {
    delete require.cache[require.resolve("./session-start.js")];
    const m = require("./session-start.js");
    const t = m.loadInjectionThresholds();
    assert.deepStrictEqual(t, {
      ctx_k: 100,
      turn: 80,
      age_s: 200,       // default kept (not overridden)
      fivehour_pct: 40, // default kept (not overridden)
      sevenday_pct: 60,
    });
  } finally {
    if (prevEnv === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevEnv;
    delete require.cache[require.resolve("./session-start.js")];
    safeRmSync(tmp);
  }
});

// Cache-bust delta assertion. Approach: measure the cache-mechanics nudge
// text size in isolation (the only new contribution to the baked prefix).
// Conservative ~4 char/tok converts byte length to raw-tok estimate.
// Safety cap: ≤ 350 raw tok per proposal §11.2 PR #3 acceptance.
// Soft target: ~165 raw tok. Measuring full SessionStart stdout against
// `git show main:hooks/session-start.js` is awkward in-process and
// platform-fragile; the isolated nudge length is the tightest pin.
//
// Isolated TKR_STATE_DIR so the gate (issue #11) reads a cold cache
// regardless of host machine state, keeping the test deterministic.
test("cache-mechanics nudge byte size ≤ 350 raw tok safety cap", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cm-byte-"));
  const prevEnv = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = tmp;
  try {
    delete require.cache[require.resolve("./session-start.js")];
    const m = require("./session-start.js");
    const txt = m.loadCacheMechanicsNudge();
    const approxTok = Math.ceil(txt.length / 4);
    assert.ok(
      approxTok <= 350,
      `cache-mechanics nudge = ~${approxTok} raw tok (len=${txt.length}); cap 350. ` +
        `Wording is FROZEN per proposal §5 Q4 — STOP and amend the proposal before tuning.`,
    );
    // Sanity floor: nudge should not collapse to empty string (catches a
    // future regression where the wording is accidentally gated off).
    assert.ok(txt.length > 1000, `nudge unexpectedly short: len=${txt.length}`);
  } finally {
    if (prevEnv === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevEnv;
    delete require.cache[require.resolve("./session-start.js")];
    safeRmSync(tmp);
  }
});

// Issue #11 — smart gate on prior session weight. Skips the ~1500-char
// cache-mechanics block on sessions where the prior was light, since
// the framework only pays off when context pressure is realistic.

function writeLastSessionCWCache(stateDir, payload) {
  fs.writeFileSync(
    path.join(stateDir, "last-session-cw.json"),
    JSON.stringify({ updated_at: new Date().toISOString(), ...payload }),
  );
}

test("cache-mechanics nudge suppressed when prior_cum_cw < 100K (light prior)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cm-light-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  writeLastSessionCWCache(tmp, { prior_cum_cw: 50_000 });
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env: { ...process.env, TKR_STATE_DIR: tmp },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      !res.stdout.includes("**Cache mechanics.**"),
      `light prior should suppress cache-mechanics nudge:\n${res.stdout}`,
    );
  } finally {
    safeRmSync(tmp);
  }
});

test("cache-mechanics nudge emitted when prior_cum_cw > 100K (heavy prior)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cm-heavy-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  writeLastSessionCWCache(tmp, { prior_cum_cw: 250_000 });
  try {
    const env = { ...process.env, TKR_STATE_DIR: tmp };
    delete env.TKR_SYSPROMPT;
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env,
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      res.stdout.includes("**Cache mechanics.**"),
      `heavy prior must keep emitting cache-mechanics nudge`,
    );
  } finally {
    safeRmSync(tmp);
  }
});

test("cache-mechanics nudge emitted on cold cache (no last-session-cw.json)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cm-cold-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  try {
    const env = { ...process.env, TKR_STATE_DIR: tmp };
    delete env.TKR_SYSPROMPT;
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env,
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      res.stdout.includes("**Cache mechanics.**"),
      `cold cache (no signal) must default to emitting the nudge`,
    );
  } finally {
    safeRmSync(tmp);
  }
});

// TKR_SYSPROMPT division-of-labor gate. When `tkr claude` launched the
// session it sets TKR_SYSPROMPT=1 on the child (the standing guidance is
// already pinned in the system prompt via --system-prompt-file), so the
// SessionStart hook must drop the duplicated standing block and emit STATE
// only. Plain `claude` (marker absent) still gets the full standing block.

// Base env with TKR_SYSPROMPT scrubbed — the test runner may itself be a
// `tkr claude` session, which would leak the marker into the "absent" case.
function envWithoutSysprompt(stateDir) {
  const e = { ...process.env, TKR_STATE_DIR: stateDir };
  delete e.TKR_SYSPROMPT;
  return e;
}

test("TKR_SYSPROMPT=1 drops standing guidance, keeps STATE", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-sp-on-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env: { ...envWithoutSysprompt(tmp), TKR_SYSPROMPT: "1" },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    // Standing guidance gone...
    assert.ok(
      !res.stdout.includes("## tkr plugin active") &&
        !res.stdout.includes("Before reading unfamiliar files"),
      `standing block must be suppressed when pinned:\n${res.stdout}`,
    );
    // ...but per-session STATE still present.
    assert.ok(
      res.stdout.includes("Brevity mode"),
      `STATE (brevity) must still emit under the marker:\n${res.stdout}`,
    );
  } finally {
    safeRmSync(tmp);
  }
});

test("no TKR_SYSPROMPT → full standing block emitted (plain claude)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-sp-off-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env: envWithoutSysprompt(tmp),
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      res.stdout.includes("## tkr plugin active") &&
        res.stdout.includes("Before reading unfamiliar files"),
      `standing block must emit when prompt not pinned:\n${res.stdout}`,
    );
  } finally {
    safeRmSync(tmp);
  }
});

// PLAN-1 T7 (Wave-0, v3.13.1) — L6 cache-TTL inference emitted once per
// session startup when detectTTL has direct evidence. The integration
// path here pre-seeds the persisted cache-ttl.json so detectTTL takes
// the cached-direct path without needing a real Anthropic JSONL.
test("L6 cache-TTL inference fires on startup when persisted cache shows direct evidence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-l6-"));
  const sid = "test-1h-l6";
  const ttlCacheDir = path.join(tmp, "session-state", sid);
  fs.mkdirSync(ttlCacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(ttlCacheDir, "cache-ttl.json"),
    JSON.stringify({
      ttl_seconds: 3600,
      source: "direct",
      idle_gap_observed_secs: 0,
      at: Date.now(),
    }),
  );
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        source: "startup",
        session_id: sid,
        transcript_path: "/fake/test-1h.jsonl",
      }),
      env: { ...process.env, TKR_STATE_DIR: tmp, CLAUDE_PROJECT_DIR: tmp },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    const ledgerPath = path.join(tmp, "playbook-events.jsonl");
    assert.ok(fs.existsSync(ledgerPath), "playbook ledger should exist after L6 emit");
    const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    const l6 = lines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L6");
    assert.strictEqual(l6.length, 1, "expected exactly one L6 event");
    assert.strictEqual(l6[0].event, "fired");
    assert.strictEqual(l6[0].trigger_state.ttl_seconds, 3600);
    assert.strictEqual(l6[0].trigger_state.source, "direct");
    assert.strictEqual(l6[0].session_id, sid);
  } finally {
    safeRmSync(tmp);
  }
});

test("L6 NOT emitted when detectTTL falls back to default (no signal)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-l6-def-"));
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ source: "startup", session_id: "no-evidence" }),
      env: {
        ...process.env,
        TKR_STATE_DIR: tmp,
        CLAUDE_PROJECT_DIR: tmp,
        // Pin to non-existent project dir so JSONL lookup misses → default.
        HOME: tmp,
        USERPROFILE: tmp,
      },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0);
    const ledgerPath = path.join(tmp, "playbook-events.jsonl");
    const lines = fs.existsSync(ledgerPath)
      ? fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)
      : [];
    const l6 = lines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L6");
    assert.strictEqual(l6.length, 0, "default source must not emit L6");
  } finally {
    safeRmSync(tmp);
  }
});

test("L6 NOT emitted on non-startup sources (resume/compact)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-l6-resume-"));
  const sid = "resume-no-l6";
  const ttlCacheDir = path.join(tmp, "session-state", sid);
  fs.mkdirSync(ttlCacheDir, { recursive: true });
  // Seed direct evidence — proves the gating is on source==="startup",
  // not on detectTTL evidence.
  fs.writeFileSync(
    path.join(ttlCacheDir, "cache-ttl.json"),
    JSON.stringify({
      ttl_seconds: 3600,
      source: "direct",
      idle_gap_observed_secs: 0,
      at: Date.now(),
    }),
  );
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ source: "resume", session_id: sid }),
      env: { ...process.env, TKR_STATE_DIR: tmp, CLAUDE_PROJECT_DIR: tmp },
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0);
    const ledgerPath = path.join(tmp, "playbook-events.jsonl");
    const lines = fs.existsSync(ledgerPath)
      ? fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)
      : [];
    const l6 = lines.map((l) => JSON.parse(l)).filter((e) => e.layer === "L6");
    assert.strictEqual(l6.length, 0, "resume path must not emit L6 (startup-only)");
  } finally {
    safeRmSync(tmp);
  }
});

test("cfg.cache_mechanics.nudge=true forces always-on regardless of prior weight", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-cm-always-"));
  fs.writeFileSync(path.join(tmp, "brevity-mode"), "full");
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ cache_mechanics: { nudge: true } }),
  );
  // Light prior would normally suppress; explicit true must override.
  writeLastSessionCWCache(tmp, { prior_cum_cw: 10_000 });
  try {
    const env = { ...process.env, TKR_STATE_DIR: tmp };
    delete env.TKR_SYSPROMPT;
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{}",
      env,
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(
      res.stdout.includes("**Cache mechanics.**"),
      `explicit nudge=true must force emit even with light prior`,
    );
  } finally {
    safeRmSync(tmp);
  }
});

test("delegateNudge mentions /tkr:delegate only on advanced tier", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-tier-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = tmp;
  try {
    const { delegateNudge } = require("./session-start.js");
    // No tier file (CLI-only / unknown) → no mention.
    assert.strictEqual(delegateNudge(), "");
    // Core tier → no mention (skill ships in skills-advanced/ only).
    fs.writeFileSync(path.join(tmp, "plugin-tier"), "core\n");
    assert.strictEqual(delegateNudge(), "");
    // Advanced tier → cap-pressure escape-valve mention.
    fs.writeFileSync(path.join(tmp, "plugin-tier"), "advanced\n");
    assert.match(delegateNudge(), /\/tkr:delegate/);
    assert.match(delegateNudge(), /cap pressure/i);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- HAND-008: output format forks only on the auto-continue path -----
//
// Plain stdout is what every session depends on and the docs never state it
// is equivalent to additionalContext. These pin the fork: JSON exactly when
// there is a systemMessage to carry, bare text otherwise.

function runHookForContinue(specs, source) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-h007-state-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ss-h007-proj-"));
  const dir = path.join(proj, ".tkr", "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const s of specs) {
    const full = path.join(dir, s.name);
    fs.writeFileSync(full, "# Handoff\n\n## Next Action\nRun the migration.\n");
    const t = new Date(now - s.ageMs);
    fs.utimesSync(full, t, t);
  }
  try {
    const env = { ...process.env, TKR_STATE_DIR: state, CLAUDE_PROJECT_DIR: proj };
    delete env.TKR_SYSPROMPT;
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ source, session_id: "h007-sid" }),
      encoding: "utf8",
      env,
      cwd: proj,
    });
    return res.stdout || "";
  } finally {
    safeRmSync(state);
    safeRmSync(proj);
  }
}

test("HAND-008: auto-continue emits JSON with a user-only systemMessage", () => {
  const out = runHookForContinue(
    [{ name: "a-20260805-1200.md", ageMs: 4 * 60 * 1000 }],
    "clear",
  );
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(out);
  }, "auto path must emit parseable JSON");
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /<tkr-carryover /);
  assert.match(parsed.systemMessage, /carry-over auto-loaded/);
  // The two channels must not be the same string: one is a 6KB payload, the
  // other a glanceable line. Collapsing them would print the body.
  assert.ok(
    parsed.systemMessage.length < parsed.hookSpecificOutput.additionalContext.length,
  );
  assert.doesNotMatch(parsed.systemMessage, /Run the migration\./);
});

test("HAND-008: every other path keeps bare-text stdout", () => {
  const cases = [
    ["startup with fresh handoff", [{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }], "startup"],
    ["clear with stale handoff", [{ name: "a-20260805-1200.md", ageMs: 2 * 24 * 3600 * 1000 }], "clear"],
    ["clear with no handoffs", [], "clear"],
  ];
  for (const [label, specs, source] of cases) {
    const out = runHookForContinue(specs, source);
    assert.ok(out.length > 0, `${label}: hook emitted nothing`);
    assert.throws(
      () => JSON.parse(out),
      `${label}: must stay bare text, not JSON`,
    );
  }
});
