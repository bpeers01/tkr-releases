#!/usr/bin/env node
// Tests for hooks/user-prompt-submit.js coldResumeContext — covers
// pre-TTL warning tier (240s..300s) and cold-resume tier (>=300s).
//
// Run: node hooks/user-prompt-submit.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  COLD_RESUME_IDLE_SECS,
  COLD_RESUME_MIN_CENTS,
  PRE_TTL_IDLE_SECS,
  L1_IDLE_SECS,
  L1_LAST_CTX_K,
  coldResumeContext,
  l1IdleGapContext,
  l1StatePath,
  writeInjectionLogRow,
  sessionStartStatePath,
} = require("./user-prompt-submit.js");

// Route-inject plumbing tests below exercise cache/skip mechanics under
// the pre-addendum per-turn contract; pin mode=always (module scope =
// applies to every test in this file, none of which asserts mismatch-
// mode policy). Policy behavior lives in
// user-prompt-submit.route-policy.test.js.
process.env.TKR_ROUTE_INJECT_MODE = "always";

function mkTelemetryFile(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ups-test-"));
  const fp = path.join(dir, "claude-statusline.json");
  fs.writeFileSync(fp, JSON.stringify(payload));
  return fp;
}

test("constants are sane", () => {
  assert.strictEqual(COLD_RESUME_IDLE_SECS, 300);
  assert.strictEqual(PRE_TTL_IDLE_SECS, 240);
  assert.ok(PRE_TTL_IDLE_SECS < COLD_RESUME_IDLE_SECS);
  assert.ok(COLD_RESUME_MIN_CENTS > 0);
});

test("returns empty when telemetry file missing", () => {
  const out = coldResumeContext("/nonexistent/path.json");
  assert.strictEqual(out, "");
});

test("returns empty when telemetry malformed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ups-bad-"));
  const fp = path.join(dir, "claude-statusline.json");
  fs.writeFileSync(fp, "not json");
  const out = coldResumeContext(fp);
  assert.strictEqual(out, "");
});

test("returns empty when idle below pre-TTL threshold", () => {
  const fp = mkTelemetryFile({ idle_secs: PRE_TTL_IDLE_SECS - 1, projected_miss_cents: 50 });
  assert.strictEqual(coldResumeContext(fp), "");
});

test("returns empty when cost below min-cents (even when idle long)", () => {
  const fp = mkTelemetryFile({ idle_secs: 600, projected_miss_cents: COLD_RESUME_MIN_CENTS - 1 });
  assert.strictEqual(coldResumeContext(fp), "");
});

test("emits pre-TTL warning at lower bound (240s)", () => {
  const fp = mkTelemetryFile({ idle_secs: 240, projected_miss_cents: 100 });
  const out = coldResumeContext(fp);
  assert.ok(out.includes("pre-TTL"), out);
  assert.ok(out.includes("Type now"), out);
  assert.ok(out.includes("$1.00"), out);
});

test("emits pre-TTL warning at upper edge (299s)", () => {
  const fp = mkTelemetryFile({ idle_secs: 299, projected_miss_cents: 25 });
  const out = coldResumeContext(fp);
  assert.ok(out.includes("pre-TTL"), out);
  // Should not yet say cold-resume
  assert.ok(!out.includes("cold-resume"), out);
});

test("crosses to cold-resume at 300s", () => {
  const fp = mkTelemetryFile({ idle_secs: 300, projected_miss_cents: 100 });
  const out = coldResumeContext(fp);
  assert.ok(out.includes("cold-resume"), out);
  assert.ok(!out.includes("pre-TTL"), out);
});

test("cold-resume tier escalates wording when 7d cap >= 70%", () => {
  const fp = mkTelemetryFile({
    idle_secs: 600,
    projected_miss_cents: 50,
    seven_day_pct: 75,
  });
  const out = coldResumeContext(fp);
  assert.ok(out.includes("cold-resume"), out);
  assert.ok(out.includes("7d cap 75%"), out);
});

test("cold-resume tier uses default phrasing under 7d cap threshold", () => {
  const fp = mkTelemetryFile({
    idle_secs: 600,
    projected_miss_cents: 50,
    seven_day_pct: 30,
  });
  const out = coldResumeContext(fp);
  assert.ok(out.includes("cold-resume"), out);
  assert.ok(!out.includes("7d cap"), out);
  assert.ok(out.includes("/clear"), out);
});

test("pre-TTL message reports remaining seconds correctly", () => {
  const fp = mkTelemetryFile({ idle_secs: 250, projected_miss_cents: 100 });
  const out = coldResumeContext(fp);
  // Cache has ~50s left (300 - 250).
  assert.ok(out.includes("~50s") || out.includes("50s"), out);
});

// Wave 3 — L1 idle-gap tests
function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-l1-test-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function freshUPSRequire() {
  delete require.cache[require.resolve("./user-prompt-submit.js")];
  // Clear playbook-emit's in-memory rate guard (module-level Map persists
  // across tests since lib/ deps aren't re-required). Production unaffected:
  // one-shot hook processes start with an empty map by construction.
  try {
    require("./lib/playbook-emit.js").__resetRateGuard();
  } catch {}
  return require("./user-prompt-submit.js");
}

test("L1 fires when idle≥300 + last_ctx_k≥100 + emits ledger event", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({ idle_secs: 412, last_ctx_k: 142, projected_miss_cents: 87 });
    const { l1IdleGapContext: l1 } = freshUPSRequire();
    const out = l1("sid-l1-test", fp);
    assert.ok(out.includes("[L1 idle-gap]"), `expected L1 line, got:\n${out}`);
    assert.ok(out.includes("ctx 142K"));
    const ledger = path.join(dir, "playbook-events.jsonl");
    assert.ok(fs.existsSync(ledger), "ledger file written");
    const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 1);
    const evt = JSON.parse(lines[0]);
    assert.strictEqual(evt.layer, "L1");
    assert.strictEqual(evt.event, "fired");
    assert.strictEqual(evt.trigger_state.idle_secs, 412);
    assert.strictEqual(evt.trigger_state.last_ctx_k, 142);
  });
});

test("L1 suppressed when idle below threshold", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({ idle_secs: 280, last_ctx_k: 200, projected_miss_cents: 90 });
    const { l1IdleGapContext: l1 } = freshUPSRequire();
    assert.strictEqual(l1("sid", fp), "");
  });
});

test("L1 suppressed when context too small", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({ idle_secs: 600, last_ctx_k: 50, projected_miss_cents: 90 });
    const { l1IdleGapContext: l1 } = freshUPSRequire();
    assert.strictEqual(l1("sid", fp), "");
  });
});

test("L1 dedup — second call within same idle window stays quiet", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({ idle_secs: 412, last_ctx_k: 142, projected_miss_cents: 87 });
    const { l1IdleGapContext: l1 } = freshUPSRequire();
    const first = l1("sid-dedup", fp);
    const second = l1("sid-dedup", fp);
    assert.ok(first.includes("[L1 idle-gap]"));
    assert.strictEqual(second, "", "dedup must suppress repeat");
    const ledger = path.join(dir, "playbook-events.jsonl");
    const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 1, "only one event despite two calls");
  });
});

test("L1 re-arms after user acts (idle resets below threshold)", () => {
  withTempStateDir(() => {
    const { l1IdleGapContext: l1 } = freshUPSRequire();
    const high = mkTelemetryFile({ idle_secs: 412, last_ctx_k: 142, projected_miss_cents: 87 });
    const low = mkTelemetryFile({ idle_secs: 30, last_ctx_k: 142, projected_miss_cents: 5 });
    assert.ok(l1("sid-rearm", high).includes("[L1 idle-gap]"), "first fire");
    assert.strictEqual(l1("sid-rearm", high), "", "deduped");
    assert.strictEqual(l1("sid-rearm", low), "", "user acted; below threshold");
    // Idle climbs back above threshold — should fire again.
    assert.ok(l1("sid-rearm", high).includes("[L1 idle-gap]"), "re-armed");
  });
});

test("L1 disabled by TKR_PLAYBOOK_L1_DISABLED env", () => {
  withTempStateDir(() => {
    const prev = process.env.TKR_PLAYBOOK_L1_DISABLED;
    process.env.TKR_PLAYBOOK_L1_DISABLED = "1";
    try {
      const fp = mkTelemetryFile({ idle_secs: 412, last_ctx_k: 142, projected_miss_cents: 87 });
      const { l1IdleGapContext: l1 } = freshUPSRequire();
      assert.strictEqual(l1("sid", fp), "");
    } finally {
      if (prev === undefined) delete process.env.TKR_PLAYBOOK_L1_DISABLED;
      else process.env.TKR_PLAYBOOK_L1_DISABLED = prev;
    }
  });
});

test("L1 disabled by global TKR_PLAYBOOK_DISABLED env", () => {
  withTempStateDir(() => {
    const prev = process.env.TKR_PLAYBOOK_DISABLED;
    process.env.TKR_PLAYBOOK_DISABLED = "1";
    try {
      const fp = mkTelemetryFile({ idle_secs: 412, last_ctx_k: 142, projected_miss_cents: 87 });
      const { l1IdleGapContext: l1 } = freshUPSRequire();
      assert.strictEqual(l1("sid", fp), "");
    } finally {
      if (prev === undefined) delete process.env.TKR_PLAYBOOK_DISABLED;
      else process.env.TKR_PLAYBOOK_DISABLED = prev;
    }
  });
});

test("regression — coldResumeContext + l1 coexist on long idle", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({ idle_secs: 500, last_ctx_k: 142, projected_miss_cents: 87 });
    const { coldResumeContext: cr, l1IdleGapContext: l1 } = freshUPSRequire();
    const cold = cr(fp);
    const lone = l1("sid-coexist", fp);
    assert.ok(cold.includes("cold-resume"));
    assert.ok(lone.includes("[L1 idle-gap]"));
  });
});

// Wave 4 — L2 handoff detector
test("L2 fires when high + turn≥80 + cache_read>60%", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({
      rate_class: "high",
      turn_count: 94,
      cache_read_share_pct: 71,
      last_ctx_k: 312,
    });
    const { l2HandoffContext: l2 } = freshUPSRequire();
    const out = l2("sid-l2-fire", fp);
    assert.ok(out.includes("[L2 handoff]"), `expected L2 line, got:\n${out}`);
    assert.ok(out.includes("turn 94"));
    assert.ok(out.includes("cache-read 71%"));
    const ledger = path.join(dir, "playbook-events.jsonl");
    const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    const evt = JSON.parse(lines[0]);
    assert.strictEqual(evt.layer, "L2");
    assert.strictEqual(evt.event, "fired");
    assert.strictEqual(evt.trigger_state.classification, "high");
    assert.strictEqual(evt.trigger_state.turn_count, 94);
    assert.strictEqual(evt.trigger_state.cache_read_share_pct, 71);
  });
});

test("L2 fires for critical classification", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      rate_class: "critical",
      turn_count: 100,
      cache_read_share_pct: 80,
      last_ctx_k: 400,
    });
    const { l2HandoffContext: l2 } = freshUPSRequire();
    assert.ok(l2("sid-crit", fp).includes("[L2 handoff]"));
  });
});

test("L2 suppressed below turn count threshold", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      rate_class: "high",
      turn_count: 50,
      cache_read_share_pct: 70,
    });
    const { l2HandoffContext: l2 } = freshUPSRequire();
    assert.strictEqual(l2("sid", fp), "");
  });
});

test("L2 suppressed below cache_read share threshold", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      rate_class: "high",
      turn_count: 100,
      cache_read_share_pct: 40,
    });
    const { l2HandoffContext: l2 } = freshUPSRequire();
    assert.strictEqual(l2("sid", fp), "");
  });
});

test("L2 suppressed for elevated/healthy classification", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      rate_class: "elevated",
      turn_count: 100,
      cache_read_share_pct: 80,
    });
    const { l2HandoffContext: l2 } = freshUPSRequire();
    assert.strictEqual(l2("sid", fp), "");
  });
});

test("L2 dedup — second call same session stays quiet", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({
      rate_class: "high",
      turn_count: 100,
      cache_read_share_pct: 75,
      last_ctx_k: 250,
    });
    const { l2HandoffContext: l2 } = freshUPSRequire();
    const first = l2("sid-l2-dedup", fp);
    const second = l2("sid-l2-dedup", fp);
    assert.ok(first.includes("[L2 handoff]"));
    assert.strictEqual(second, "", "L2 dedup must suppress repeat");
    const ledger = path.join(dir, "playbook-events.jsonl");
    const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 1, "only one event despite two calls");
  });
});

test("L2 disabled by TKR_PLAYBOOK_L2_DISABLED env", () => {
  withTempStateDir(() => {
    const prev = process.env.TKR_PLAYBOOK_L2_DISABLED;
    process.env.TKR_PLAYBOOK_L2_DISABLED = "1";
    try {
      const fp = mkTelemetryFile({
        rate_class: "high",
        turn_count: 100,
        cache_read_share_pct: 75,
      });
      const { l2HandoffContext: l2 } = freshUPSRequire();
      assert.strictEqual(l2("sid", fp), "");
    } finally {
      if (prev === undefined) delete process.env.TKR_PLAYBOOK_L2_DISABLED;
      else process.env.TKR_PLAYBOOK_L2_DISABLED = prev;
    }
  });
});

test("L2 disabled by global TKR_PLAYBOOK_DISABLED env", () => {
  withTempStateDir(() => {
    const prev = process.env.TKR_PLAYBOOK_DISABLED;
    process.env.TKR_PLAYBOOK_DISABLED = "1";
    try {
      const fp = mkTelemetryFile({
        rate_class: "high",
        turn_count: 100,
        cache_read_share_pct: 75,
      });
      const { l2HandoffContext: l2 } = freshUPSRequire();
      assert.strictEqual(l2("sid", fp), "");
    } finally {
      if (prev === undefined) delete process.env.TKR_PLAYBOOK_DISABLED;
      else process.env.TKR_PLAYBOOK_DISABLED = prev;
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// L7 session-shape advisor — shapeAdvisorContext
// ────────────────────────────────────────────────────────────────────

// Telemetry that clears the healthy+cheap suppression gate (7d ≥ 30 OR miss
// ≥ 25c) so triggers are reachable. Merge extra fields per test.
function shapeTel(extra) {
  return { seven_day_pct: 55, projected_miss_cents: 40, ...extra };
}

function readPlaybookLedger(dir) {
  const fp = path.join(dir, "playbook-events.jsonl");
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("shape A fires at tool-bytes threshold + ctx", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 100 * 1024, last_ctx_k: 60 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    const out = shape("sid-a-fire", fp);
    assert.ok(out.includes("[shape tool-bytes]"), `expected A, got: ${out}`);
    assert.ok(out.includes("~100KB"), out);
    assert.ok(out.includes("ctx 60K"), out);
    assert.ok(out.includes("/tkr:handoff"), out);
  });
});

test("shape A suppressed just below tool-bytes threshold", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 100 * 1024 - 1, last_ctx_k: 60 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.strictEqual(shape("sid-a-below", fp), "");
  });
});

test("shape A suppressed below min_ctx_k", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 200 * 1024, last_ctx_k: 40 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.strictEqual(shape("sid-a-ctx", fp), "");
  });
});

test("shape B fires on turn-proxy + CU burn (two-prompt delta)", () => {
  withTempStateDir(() => {
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    // Prompt 1 seeds the per-turn CU baseline (ratio ~1.0 → no fire).
    const fp1 = mkTelemetryFile(shapeTel({ turn_count: 60, cap_units_total: 600, last_ctx_k: 100 }));
    assert.strictEqual(shape("sid-b-turn", fp1), "", "baseline prompt must not fire");
    // Prompt 2: 25 CU over 1 turn vs ~10 avg → ratio ~2.4 → fires.
    const fp2 = mkTelemetryFile(shapeTel({ turn_count: 61, cap_units_total: 625, last_ctx_k: 100 }));
    const out = shape("sid-b-turn", fp2);
    assert.ok(out.includes("[shape tail-burn]"), `expected B, got: ${out}`);
    assert.ok(out.includes("turn 61"), out);
  });
});

test("shape B fires on ctx-proxy + CU burn", () => {
  withTempStateDir(() => {
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    // turn_count < tail_turns(60) but ctx ≥ tail_ctx_k(140) satisfies the proxy.
    const fp1 = mkTelemetryFile(shapeTel({ turn_count: 25, cap_units_total: 250, last_ctx_k: 150 }));
    assert.strictEqual(shape("sid-b-ctx", fp1), "");
    const fp2 = mkTelemetryFile(shapeTel({ turn_count: 26, cap_units_total: 275, last_ctx_k: 150 }));
    assert.ok(shape("sid-b-ctx", fp2).includes("[shape tail-burn]"));
  });
});

test("shape B degraded path fires on BOTH position proxies when cap_units_total absent", () => {
  withTempStateDir(() => {
    // No cap_units_total → require turn ≥ 60 AND ctx ≥ 140. Fires on one prompt.
    const fp = mkTelemetryFile(shapeTel({ turn_count: 65, last_ctx_k: 150 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    const out = shape("sid-b-degraded", fp);
    assert.ok(out.includes("[shape tail-burn]"), `expected degraded B, got: ${out}`);
    assert.ok(out.includes("~2.0x"), `degraded shows threshold multiple: ${out}`);
  });
});

test("shape B degraded path suppressed with only one proxy", () => {
  withTempStateDir(() => {
    // turn ≥ 60 but ctx < 140 — degraded requires BOTH.
    const fp = mkTelemetryFile(shapeTel({ turn_count: 65, last_ctx_k: 100 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.strictEqual(shape("sid-b-degraded-one", fp), "");
  });
});

test("shape once-per-session per trigger (A does not re-fire)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 150 * 1024, last_ctx_k: 80 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.ok(shape("sid-once", fp).includes("[shape tool-bytes]"), "first fire");
    assert.strictEqual(shape("sid-once", fp), "", "A must not re-fire this session");
  });
});

test("shape A beats B same prompt; B stays armed", () => {
  withTempStateDir(() => {
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    // Seed B baseline.
    const seed = mkTelemetryFile(shapeTel({ turn_count: 60, cap_units_total: 600, last_ctx_k: 100 }));
    assert.strictEqual(shape("sid-ab", seed), "");
    // Both A (tool-bytes) and B (CU burn) satisfiable this prompt → A wins.
    const both = mkTelemetryFile(
      shapeTel({ turn_count: 61, cap_units_total: 625, last_ctx_k: 100, tool_result_bytes: 120 * 1024 }),
    );
    assert.ok(shape("sid-ab", both).includes("[shape tool-bytes]"), "A must win the tie");
    // B was left armed → a later prompt with CU burn still fires it.
    const bOnly = mkTelemetryFile(shapeTel({ turn_count: 62, cap_units_total: 650, last_ctx_k: 100 }));
    assert.ok(shape("sid-ab", bOnly).includes("[shape tail-burn]"), "B stayed armed after A won");
  });
});

test("shape suppressed when L2 already fired this session", () => {
  withTempStateDir((dir) => {
    const { shapeAdvisorContext: shape, l2StatePath } = freshUPSRequire();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(l2StatePath("sid-l2-shape"), JSON.stringify({ fired: true, fire_at: 1 }));
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 200 * 1024, last_ctx_k: 90 }));
    assert.strictEqual(shape("sid-l2-shape", fp), "");
  });
});

test("shape suppressed on healthy + cheap session", () => {
  withTempStateDir(() => {
    // 7d < 30 AND miss < 25c → low-stakes, no nudge even though A would fire.
    const fp = mkTelemetryFile({ seven_day_pct: 20, projected_miss_cents: 10, tool_result_bytes: 300 * 1024, last_ctx_k: 90 });
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.strictEqual(shape("sid-cheap", fp), "");
  });
});

test("shape B suppressed when 5h window resets within 15 min", () => {
  withTempStateDir(() => {
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    const nowSecs = Math.floor(Date.now() / 1000);
    // Degraded B would fire, but a reset in 10 min suppresses it.
    const fp = mkTelemetryFile(shapeTel({ turn_count: 65, last_ctx_k: 150, five_hour_resets_at: nowSecs + 600 }));
    assert.strictEqual(shape("sid-reset-soon", fp), "");
    // Control: reset far in the future → fires.
    const fp2 = mkTelemetryFile(shapeTel({ turn_count: 65, last_ctx_k: 150, five_hour_resets_at: nowSecs + 4 * 3600 }));
    assert.ok(shape("sid-reset-far", fp2).includes("[shape tail-burn]"));
  });
});

for (const env of ["TKR_HOOKS_DISABLED", "TKR_PLAYBOOK_DISABLED", "TKR_SHAPE_ADVISOR_DISABLED"]) {
  test(`shape disabled by ${env}`, () => {
    withTempStateDir(() => {
      const prev = process.env[env];
      process.env[env] = "1";
      try {
        const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 200 * 1024, last_ctx_k: 90 }));
        const { shapeAdvisorContext: shape } = freshUPSRequire();
        assert.strictEqual(shape("sid-kill", fp), "");
      } finally {
        if (prev === undefined) delete process.env[env];
        else process.env[env] = prev;
      }
    });
  });
}

test("shape disabled by config advisor.shape.enabled=false", () => {
  withTempStateDir((dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ advisor: { shape: { enabled: false } } }));
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 200 * 1024, last_ctx_k: 90 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.strictEqual(shape("sid-cfg-off", fp), "");
  });
});

test("shape never fires for subagent scope", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 200 * 1024, last_ctx_k: 90 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.strictEqual(shape("sid-sub", fp, undefined, { scope: "subagent" }), "");
    assert.strictEqual(shape("sid-sub2", fp, undefined, { subagent_type: "task" }), "");
  });
});

test("shape emits L7 fired row with correct trigger_state", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile(shapeTel({ tool_result_bytes: 128 * 1024, last_ctx_k: 75, turn_count: 40, cap_units_total: 400 }));
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.ok(shape("sid-l7-row", fp).includes("[shape tool-bytes]"));
    const rows = readPlaybookLedger(dir).filter((r) => r.layer === "L7");
    assert.strictEqual(rows.length, 1, "one L7 fired row");
    const evt = rows[0];
    assert.strictEqual(evt.event, "fired");
    assert.strictEqual(evt.trigger_state.trigger, "tool_bytes");
    assert.strictEqual(evt.trigger_state.tool_result_bytes, 128 * 1024);
    assert.strictEqual(evt.trigger_state.last_ctx_k, 75);
    assert.strictEqual(evt.trigger_state.turn_count, 40);
    assert.strictEqual(evt.trigger_state.seven_day_pct, 55);
    assert.strictEqual(evt.outcome, null);
  });
});

test("shape returns '' on malformed telemetry", () => {
  withTempStateDir(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shape-bad-"));
    const fp = path.join(dir, "claude-statusline.json");
    fs.writeFileSync(fp, "not json");
    const { shapeAdvisorContext: shape } = freshUPSRequire();
    assert.strictEqual(shape("sid-bad", fp), "");
    assert.strictEqual(shape("sid-missing", "/no/such/path.json"), "");
  });
});

// (pressureContext tests deleted with the V2=0 legacy path — INV-073.)

// ────────────────────────────────────────────────────────────────────
// PR #1 — Phase 1 hook log writer (injection-events.jsonl)
// ────────────────────────────────────────────────────────────────────

// Hot-path schema — 10 fields. PR #2 hydrates the 5 post-hoc fields
// (model_id, is_subagent, is_resume, rate_class, total_cost_so_far_cents)
// via parser.py join on (session_id, turn). Hot path stays under the
// 200-byte rotation cap by deferring them to the join. md carries the
// injection-cadence arm ("<route[0]>/<state[0]>") for A/B splits.
const EXPECTED_LOG_KEYS = [
  "ts",
  "session_id",
  "turn",
  "ctx_k",
  "idle_secs",
  "fivehour_pct",
  "sevenday_pct",
  "age_s",
  "inject_b",
  "md",
];

function readLog(dir) {
  const fp = path.join(dir, "injection-events.jsonl");
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("PR1: log row has stable 9-key shape, types correct, ≤200 bytes", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({
      turn_count: 42,
      last_ctx_k: 138,
      idle_secs: 27,
      five_hour_pct: 18,
      seven_day_pct: 56,
    });
    const { writeInjectionLogRow: write } = freshUPSRequire();
    const input = {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      prompt: "implement the feature please",
    };
    const emitted = "[tkr brevity: full — fragments, no articles, no filler, no hedging]\n" +
      "[tkr pressure: 7d=56% 5h=18%]";
    write(input, emitted, fp);

    const rows = readLog(dir);
    assert.strictEqual(rows.length, 1, "exactly one row written");
    const row = rows[0];

    for (const k of EXPECTED_LOG_KEYS) {
      assert.ok(k in row, `row missing key ${k}`);
    }
    assert.strictEqual(Object.keys(row).length, EXPECTED_LOG_KEYS.length, "no extra keys");
    // Route mode is pinned "always" at file top; state-line mode unset → bucket.
    assert.strictEqual(row.md, "a/b", "md carries the cadence arm");

    assert.strictEqual(typeof row.ts, "string");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.ts), "ISO-8601 ts");
    assert.strictEqual(row.session_id, "550e8400-e29b-41d4-a716-446655440000");
    assert.strictEqual(row.turn, 42);
    assert.strictEqual(row.ctx_k, 138);
    assert.strictEqual(row.idle_secs, 27);
    assert.strictEqual(row.fivehour_pct, 18);
    assert.strictEqual(row.sevenday_pct, 56);
    assert.strictEqual(typeof row.age_s, "number");
    assert.strictEqual(row.inject_b, Buffer.byteLength(emitted, "utf8"));

    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    assert.ok(rowBytes <= 200, `row size ${rowBytes} > 200 bytes cap`);
  });
});

test("PR1: missing statusline.json → numeric fields default 0/-1, no crash", () => {
  withTempStateDir((dir) => {
    const { writeInjectionLogRow: write } = freshUPSRequire();
    write({ session_id: "sid-missing-tel", prompt: "x" }, "", "/no/such/path.json");
    const rows = readLog(dir);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.turn, 0);
    assert.strictEqual(row.ctx_k, 0);
    assert.strictEqual(row.idle_secs, 0);
    assert.strictEqual(row.fivehour_pct, -1);
    assert.strictEqual(row.sevenday_pct, -1);
    assert.strictEqual(row.inject_b, 0);
  });
});

test("PR1: missing session_id + transcript_path → fallback to pid-based, never crash", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({ turn_count: 1 });
    const { writeInjectionLogRow: write } = freshUPSRequire();
    // No session_id, no transcript_path. extractSessionID falls back to
    // pid-${ppid} (always a non-empty string), so session_id stays set.
    write({ prompt: "hello" }, "", fp);
    const rows = readLog(dir);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(typeof rows[0].session_id, "string");
    assert.ok(rows[0].session_id.length > 0, "session_id non-empty (pid fallback)");
  });
});

test("PR1: TKR_INJECTION_LOG_DISABLED=1 → no log file created", () => {
  withTempStateDir((dir) => {
    const prev = process.env.TKR_INJECTION_LOG_DISABLED;
    process.env.TKR_INJECTION_LOG_DISABLED = "1";
    try {
      const fp = mkTelemetryFile({ turn_count: 5 });
      const { writeInjectionLogRow: write } = freshUPSRequire();
      write({ session_id: "sid-disabled", prompt: "x" }, "[tkr ...]", fp);
      const logPath = path.join(dir, "injection-events.jsonl");
      assert.strictEqual(fs.existsSync(logPath), false, "no log when disabled");
    } finally {
      if (prev === undefined) delete process.env.TKR_INJECTION_LOG_DISABLED;
      else process.env.TKR_INJECTION_LOG_DISABLED = prev;
    }
  });
});

test("PR1: age_s — first call 0, second call ~30 with seeded file", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({ turn_count: 1 });
    const { writeInjectionLogRow: write, sessionStartStatePath: ssp } = freshUPSRequire();
    const sid = "sid-age-test";
    write({ session_id: sid, prompt: "first" }, "", fp);
    let rows = readLog(dir);
    assert.strictEqual(rows[0].age_s, 0, "first call seeds → 0");

    // Pre-seed state file 30s ago, then call again.
    const stateFp = ssp(sid);
    const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
    fs.writeFileSync(stateFp, thirtySecsAgo);
    write({ session_id: sid, prompt: "second" }, "", fp);
    rows = readLog(dir);
    assert.strictEqual(rows.length, 2);
    assert.ok(
      rows[1].age_s >= 29 && rows[1].age_s <= 32,
      `expected ~30s, got ${rows[1].age_s}`,
    );
  });
});

test("PR1: rotation — pre-seeded 10MB+1 log rotates on next append", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({ turn_count: 1 });
    const logPath = path.join(dir, "injection-events.jsonl");
    // Pre-seed at 10MB+1 byte (rotation threshold = 10MB).
    const filler = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41); // 'A'
    fs.writeFileSync(logPath, filler);
    assert.strictEqual(fs.statSync(logPath).size, 10 * 1024 * 1024 + 1);

    const { writeInjectionLogRow: write } = freshUPSRequire();
    write({ session_id: "sid-rotate", prompt: "x" }, "", fp);

    // Old file moves to .1; fresh file starts with one row only.
    assert.ok(fs.existsSync(logPath + ".1"), "rotated to .1");
    const newSize = fs.statSync(logPath).size;
    assert.ok(newSize < 1024, `fresh log small (got ${newSize})`);
    const rows = readLog(dir);
    assert.strictEqual(rows.length, 1, "exactly one row in fresh log");
  });
});

test("PR1: concurrent serial appends → all rows present, no partial lines", () => {
  // appendFileSync is synchronous in-process; we exercise sequential
  // serial appends (5×) since true concurrent subprocess writes would
  // measure node-startup, not the writer. Cross-process atomicity is
  // best-effort (matches instructions-loaded.js pattern).
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({ turn_count: 1 });
    const { writeInjectionLogRow: write } = freshUPSRequire();
    for (let i = 0; i < 5; i++) {
      write({ session_id: `sid-conc-${i}`, prompt: `p${i}` }, "", fp);
    }
    const rows = readLog(dir);
    assert.strictEqual(rows.length, 5);
    // Each row parses cleanly → no partial JSON.
    for (const r of rows) {
      assert.strictEqual(typeof r.ts, "string");
    }
    // session_id values distinct → no cross-row corruption.
    const sids = new Set(rows.map((r) => r.session_id));
    assert.strictEqual(sids.size, 5);
  });
});

test("PR1: inject_b matches Buffer.byteLength of emitted text", () => {
  withTempStateDir((dir) => {
    const fp = mkTelemetryFile({ turn_count: 1 });
    const { writeInjectionLogRow: write } = freshUPSRequire();
    const cases = [
      "",
      "ascii only",
      "unicode: ✓ ✗ — em dash",
      "multi\nline\ncontent",
    ];
    for (const emitted of cases) {
      write({ session_id: `sid-bytes-${emitted.length}`, prompt: "x" }, emitted, fp);
    }
    const rows = readLog(dir);
    assert.strictEqual(rows.length, cases.length);
    for (let i = 0; i < cases.length; i++) {
      const expected = cases[i] ? Buffer.byteLength(cases[i], "utf8") : 0;
      assert.strictEqual(rows[i].inject_b, expected, `case ${i}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// PR #4 — Channel 1 (V2 gate + state line + tier-cross advisories)
// ────────────────────────────────────────────────────────────────────

function spawnHook(input, env = {}) {
  const { spawnSync } = require("node:child_process");
  // These tests pre-date per-project namespacing: they seed
  // <TMPDIR>/claude-statusline.json directly. Auto-derive TKR_STATUSLINE_PATH
  // so the hook's getTelemetryPath() finds the seeded payload.
  const finalEnv = { ...process.env, ...env };
  if (finalEnv.TMPDIR && !finalEnv.TKR_STATUSLINE_PATH) {
    finalEnv.TKR_STATUSLINE_PATH = path.join(finalEnv.TMPDIR, "claude-statusline.json");
  }
  // Test-environment isolation: parent process.env may carry
  // CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_EFFORT (set by the developer's own
  // Claude Code session) into the hook subprocess, polluting shapeNudge
  // assertions. Equivalent leak path for the route-classify cache: the
  // hook reads $TMPDIR/tkr-route-<sha1>.json, but Node os.tmpdir() on
  // Windows ignores TMPDIR and reads %TEMP%, so a stale cache from any
  // prior run hits. Strip both and pin the cache dir to the test's
  // TMPDIR so individual tests can opt back in by setting them in `env`.
  if (!("CLAUDE_CODE_EFFORT_LEVEL" in env)) delete finalEnv.CLAUDE_CODE_EFFORT_LEVEL;
  if (!("CLAUDE_EFFORT" in env)) delete finalEnv.CLAUDE_EFFORT;
  if (finalEnv.TMPDIR && !finalEnv.TKR_ROUTE_CACHE_DIR) {
    finalEnv.TKR_ROUTE_CACHE_DIR = finalEnv.TMPDIR;
  }
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "user-prompt-submit.js")],
    {
      input: JSON.stringify(input),
      env: finalEnv,
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  return result;
}

// (injectionV2Active gate tests deleted with the gate itself — INV-073.)

// State-line variants — direct stateLineContext() call (not full hook spawn).

test("PR4: state line — quiet (nothing crossed)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      last_ctx_k: 50,
      turn_count: 10,
      idle_secs: 5,
      five_hour_pct: 10,
      seven_day_pct: 20,
    });
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { stateLineContext } = require("./user-prompt-submit.js");
    assert.strictEqual(stateLineContext("sid-quiet", fp), "");
  });
});

test("PR4: state line — warming (ctx≥75K, turn<50)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      last_ctx_k: 85, turn_count: 10, idle_secs: 5,
      five_hour_pct: 10, seven_day_pct: 20,
    });
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { stateLineContext } = require("./user-prompt-submit.js");
    assert.strictEqual(stateLineContext("sid-warm", fp), "[tkr: ctx=85K]");
  });
});

test("PR4: state line — seasoned (turn≥50 + ctx≥75K)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      last_ctx_k: 110, turn_count: 120, idle_secs: 5,
      five_hour_pct: 10, seven_day_pct: 20,
    });
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { stateLineContext } = require("./user-prompt-submit.js");
    assert.strictEqual(stateLineContext("sid-seas", fp), "[tkr: t=120 ctx=110K]");
  });
});

test("PR4: state line — pre-TTL (age within window)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      last_ctx_k: 110, turn_count: 120, idle_secs: 250,
      five_hour_pct: 10, seven_day_pct: 20,
    });
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { stateLineContext } = require("./user-prompt-submit.js");
    assert.strictEqual(
      stateLineContext("sid-ttl", fp),
      "[tkr: t=120 ctx=110K age~250s]",
    );
  });
});

test("PR4: state line — hot (5h≥40%)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      last_ctx_k: 110, turn_count: 120, idle_secs: 5,
      five_hour_pct: 42, seven_day_pct: 20,
    });
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { stateLineContext } = require("./user-prompt-submit.js");
    assert.strictEqual(
      stateLineContext("sid-hot", fp),
      "[tkr: t=120 ctx=110K 5h=42%]",
    );
  });
});

test("PR4: state line — critical (7d≥50%, full disclosure)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      last_ctx_k: 110, turn_count: 120, idle_secs: 5,
      five_hour_pct: 58, seven_day_pct: 72,
    });
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { stateLineContext } = require("./user-prompt-submit.js");
    assert.strictEqual(
      stateLineContext("sid-crit", fp),
      "[tkr: t=120 ctx=110K 7d=72% 5h=58%]",
    );
  });
});

test("PR4: hysteresis — ctx field sticks after dip", () => {
  withTempStateDir(() => {
    // Sticky per-turn redisplay is the legacy cadence; delta-only mode
    // stays silent on a same-bucket dip by design (covered in
    // user-prompt-submit.state-bucket.test.js).
    const prevMode = process.env.TKR_STATE_LINE_MODE;
    process.env.TKR_STATE_LINE_MODE = "every-turn";
    try {
      delete require.cache[require.resolve("./user-prompt-submit.js")];
      const { stateLineContext } = require("./user-prompt-submit.js");
      const fp1 = mkTelemetryFile({
        last_ctx_k: 85, turn_count: 10, idle_secs: 5,
        five_hour_pct: 10, seven_day_pct: 20,
      });
      assert.strictEqual(stateLineContext("sid-hyst", fp1), "[tkr: ctx=85K]");
      const fp2 = mkTelemetryFile({
        last_ctx_k: 70, turn_count: 10, idle_secs: 5,
        five_hour_pct: 10, seven_day_pct: 20,
      });
      assert.strictEqual(stateLineContext("sid-hyst", fp2), "[tkr: ctx=70K]");
    } finally {
      if (prevMode === undefined) delete process.env.TKR_STATE_LINE_MODE;
      else process.env.TKR_STATE_LINE_MODE = prevMode;
    }
  });
});

test("PR4: hysteresis — age field does NOT stick", () => {
  withTempStateDir(() => {
    // Legacy cadence pin — see the ctx-hysteresis test above.
    const prevMode = process.env.TKR_STATE_LINE_MODE;
    process.env.TKR_STATE_LINE_MODE = "every-turn";
    try {
      delete require.cache[require.resolve("./user-prompt-submit.js")];
      const { stateLineContext } = require("./user-prompt-submit.js");
      const fp1 = mkTelemetryFile({
        last_ctx_k: 110, turn_count: 120, idle_secs: 250,
        five_hour_pct: 10, seven_day_pct: 20,
      });
      const first = stateLineContext("sid-age", fp1);
      assert.ok(first.includes("age~250s"), `expected age~250s, got: ${first}`);
      const fp2 = mkTelemetryFile({
        last_ctx_k: 110, turn_count: 120, idle_secs: 10,
        five_hour_pct: 10, seven_day_pct: 20,
      });
      const second = stateLineContext("sid-age", fp2);
      assert.ok(!second.includes("age"), `expected no age, got: ${second}`);
      // Other locked fields still surface.
      assert.ok(second.includes("t=120"));
      assert.ok(second.includes("ctx=110K"));
    } finally {
      if (prevMode === undefined) delete process.env.TKR_STATE_LINE_MODE;
      else process.env.TKR_STATE_LINE_MODE = prevMode;
    }
  });
});

// Tier-cross advisories.

test("PR4: tier-cross — 50% fires once", () => {
  withTempStateDir(() => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { tierCrossContext } = require("./user-prompt-submit.js");
    const fp = mkTelemetryFile({ seven_day_pct: 55 });
    const first = tierCrossContext("sid-t50", fp);
    assert.strictEqual(first, "[tkr: 7d=50%]");
    const second = tierCrossContext("sid-t50", fp);
    assert.strictEqual(second, "");
  });
});

test("PR4: tier-cross — 70% fires once", () => {
  withTempStateDir(() => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { tierCrossContext } = require("./user-prompt-submit.js");
    const fp = mkTelemetryFile({ seven_day_pct: 72 });
    const first = tierCrossContext("sid-t70", fp);
    assert.strictEqual(first, "[tkr: 7d=70%]");
    const second = tierCrossContext("sid-t70", fp);
    assert.strictEqual(second, "");
  });
});

test("PR4: tier-cross — 85% fires once", () => {
  withTempStateDir(() => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { tierCrossContext } = require("./user-prompt-submit.js");
    const fp = mkTelemetryFile({ seven_day_pct: 88 });
    const first = tierCrossContext("sid-t85", fp);
    assert.strictEqual(first, "[tkr: 7d=85%]");
    const second = tierCrossContext("sid-t85", fp);
    assert.strictEqual(second, "");
  });
});

test("PR4: L2 precedence — suppresses 70% advisory", () => {
  withTempStateDir((dir) => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { tierCrossContext, l2StatePath } = require("./user-prompt-submit.js");
    // Pre-seed L2 fired state.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(l2StatePath("sid-l2-70"), JSON.stringify({ fired: true, fire_at: 1 }));
    const fp = mkTelemetryFile({ seven_day_pct: 72 });
    assert.strictEqual(tierCrossContext("sid-l2-70", fp), "");
  });
});

test("PR4: L2 precedence — suppresses 85% advisory", () => {
  withTempStateDir((dir) => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { tierCrossContext, l2StatePath } = require("./user-prompt-submit.js");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(l2StatePath("sid-l2-85"), JSON.stringify({ fired: true, fire_at: 1 }));
    const fp = mkTelemetryFile({ seven_day_pct: 88 });
    assert.strictEqual(tierCrossContext("sid-l2-85", fp), "");
  });
});

test("PR4: L2 precedence — does NOT suppress 50% advisory", () => {
  withTempStateDir((dir) => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { tierCrossContext, l2StatePath } = require("./user-prompt-submit.js");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(l2StatePath("sid-l2-50"), JSON.stringify({ fired: true, fire_at: 1 }));
    const fp = mkTelemetryFile({ seven_day_pct: 55 });
    assert.strictEqual(
      tierCrossContext("sid-l2-50", fp),
      "[tkr: 7d=50%]",
    );
  });
});

// Corruption tolerance.

test("PR4: state-line — corrupt JSON tolerated; fresh emit succeeds", () => {
  withTempStateDir((dir) => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { stateLineContext, stateLineFilePath } = require("./user-prompt-submit.js");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateLineFilePath("sid-corrupt-sl"), "not-json");
    const fp = mkTelemetryFile({
      last_ctx_k: 85, turn_count: 10, idle_secs: 5,
      five_hour_pct: 10, seven_day_pct: 20,
    });
    assert.strictEqual(
      stateLineContext("sid-corrupt-sl", fp),
      "[tkr: ctx=85K]",
    );
  });
});

test("PR4: tier-cross — corrupt JSON tolerated; fresh emit succeeds", () => {
  withTempStateDir((dir) => {
    delete require.cache[require.resolve("./user-prompt-submit.js")];
    const { tierCrossContext, tierCrossFilePath } = require("./user-prompt-submit.js");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tierCrossFilePath("sid-corrupt-tc"), "garbage");
    const fp = mkTelemetryFile({ seven_day_pct: 55 });
    assert.strictEqual(
      tierCrossContext("sid-corrupt-tc", fp),
      "[tkr: 7d=50%]",
    );
  });
});

// Hook spawn integration tests. (Legacy-path spawn tests deleted with
// the V2=0 branch — INV-073.)

test("PR4: spawn no env — no legacy brevity/pressure artifacts", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({ seven_day_pct: 70, five_hour_pct: 10 });
    const r = spawnHook(
      { session_id: "sid-v2-default", prompt: "do something" },
      { TKR_STATE_DIR: process.env.TKR_STATE_DIR, TMPDIR: path.dirname(fp) },
    );
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes("[tkr brevity:"), `legacy brevity should be dropped: ${r.stdout}`);
    assert.ok(!r.stdout.includes("[tkr pressure:"), `legacy pressure should be dropped: ${r.stdout}`);
  });
});

test("PR4: spawn quiet telemetry — no state line, no tier-cross", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      last_ctx_k: 50, turn_count: 10, idle_secs: 5,
      five_hour_pct: 10, seven_day_pct: 20,
    });
    const r = spawnHook(
      { session_id: "sid-v2-quiet", prompt: "do something" },
      {
        TKR_STATE_DIR: process.env.TKR_STATE_DIR,
        TMPDIR: path.dirname(fp),
      },
    );
    assert.strictEqual(r.status, 0);
    assert.ok(!r.stdout.includes("[tkr brevity:"), `brevity should be dropped: ${r.stdout}`);
    assert.ok(!r.stdout.includes("[tkr pressure:"), `pressure should be dropped: ${r.stdout}`);
    assert.ok(!r.stdout.includes("[tkr: "), `quiet state — no tkr tags: ${r.stdout}`);
  });
});

test("PR1: writer bench p95 < 5ms (1000 iter, in-process)", () => {
  withTempStateDir(() => {
    const fp = mkTelemetryFile({
      turn_count: 87,
      last_ctx_k: 142,
      idle_secs: 33,
      five_hour_pct: 41,
      seven_day_pct: 64,
    });
    const { writeInjectionLogRow: write } = freshUPSRequire();
    const input = { session_id: "sid-bench", prompt: "bench prompt" };
    const emitted = "[tkr brevity: full — fragments]\n[tkr pressure: 7d=64% 5h=41%]";

    const N = 1000;
    const samples = new BigInt64Array(N);
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      write(input, emitted, fp);
      samples[i] = process.hrtime.bigint() - t0;
    }
    const sorted = Array.from(samples).sort((a, b) => (a < b ? -1 : 1));
    const p95 = sorted[Math.floor(N * 0.95)];
    const p95Ms = Number(p95) / 1_000_000;
    // CLIX-004: absolute-time gates flake on shared CI runners; CI workflows
    // set TKR_BENCH_BUDGET_MULT=3 for headroom, local runs stay tight. This
    // gate predated the convention and was the one straggler still asserting
    // a bare 5ms — it fails whenever the box is busy, which for `node --test
    // hooks/**/*.test.js` (how CI invokes it) means whenever a sibling suite
    // happens to be spawning hooks in a parallel child process.
    const budgetMs = 5 * Math.max(1, Number(process.env.TKR_BENCH_BUDGET_MULT) || 1);
    assert.ok(p95Ms < budgetMs, `p95 ${p95Ms.toFixed(3)}ms ≥ ${budgetMs}ms budget`);
  });
});

// ────────────────────────────────────────────────────────────────────
// PLAN-3 T8 — route-inject branch (ADR-0010 §6)
//
// These tests seed a verdict and assert on what the hook does WITH it, so
// the classifier stays off (TKR_ROUTE_SYNC=0, set per test below).
// routeInjectContext classifies once per prompt by design; leaving it on
// would run a real `tkr route classify` on any machine with tkr installed
// — the normal state for anyone developing this repo — overwriting each
// seeded entry with a real verdict and failing the assertions for reasons
// unrelated to injection.
// ────────────────────────────────────────────────────────────────────

// withRouteSyncOff runs fn with the synchronous classifier disabled and
// restores the previous value afterwards.
function withRouteSyncOff(fn) {
  const prev = process.env.TKR_ROUTE_SYNC;
  process.env.TKR_ROUTE_SYNC = "0";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TKR_ROUTE_SYNC;
    else process.env.TKR_ROUTE_SYNC = prev;
  }
}

// Helper: write a valid route cache JSON file for the given prompt text.
// Returns the cache file path so callers can verify or remove it.
function writeRouteCache(promptText, overrides = {}) {
  const crypto = require("node:crypto");
  const sha1 = crypto.createHash("sha1").update(promptText).digest("hex");
  const cacheFile = path.join(os.tmpdir(), "tkr-route-" + sha1 + ".json");
  const payload = {
    task_class: overrides.task_class ?? "implement",
    effort: overrides.effort ?? "medium",
    why: overrides.why ?? "single module, local pattern",
    written_at: overrides.written_at ?? new Date().toISOString(),
  };
  fs.writeFileSync(cacheFile, JSON.stringify(payload));
  return cacheFile;
}

// Helper: delete a route cache file silently (cleanup after test).
function removeRouteCache(promptText) {
  try {
    const crypto = require("node:crypto");
    const sha1 = crypto.createHash("sha1").update(promptText).digest("hex");
    fs.rmSync(path.join(os.tmpdir(), "tkr-route-" + sha1 + ".json"), { force: true });
  } catch {}
}

test("route-inject: cache hit appends bracketed line", () => {
  const prompt = "implement the frobnicate endpoint";
  writeRouteCache(prompt, {
    task_class: "implement",
    effort: "medium",
    why: "bounded module change",
  });
  try {
    const { routeInjectContext } = freshUPSRequire();
    const out = withRouteSyncOff(() => routeInjectContext({ prompt }));
    assert.ok(
      out.includes("[tkr route: implement → effort=medium (bounded module change)]"),
      `expected bracketed route line, got: ${out}`,
    );
  } finally {
    removeRouteCache(prompt);
  }
});

test("route-inject: cache miss does NOT inject this turn", () => {
  const prompt = "route-miss-test-unique-prompt-xyz-12345";
  removeRouteCache(prompt); // ensure absent
  const { routeInjectContext } = freshUPSRequire();
  const out = withRouteSyncOff(() => routeInjectContext({ prompt }));
  assert.strictEqual(out, "", `expected empty on miss, got: ${out}`);
});

test("route-inject: expired cache treated as miss", () => {
  const prompt = "expired-cache-test-prompt-abc";
  const sixtyTwoSecsAgo = new Date(Date.now() - 62_000).toISOString();
  writeRouteCache(prompt, {
    task_class: "bugfix",
    effort: "low",
    why: "expired",
    written_at: sixtyTwoSecsAgo,
  });
  try {
    const { routeInjectContext } = freshUPSRequire();
    const out = withRouteSyncOff(() => routeInjectContext({ prompt }));
    assert.strictEqual(out, "", `expected empty on expired cache, got: ${out}`);
  } finally {
    removeRouteCache(prompt);
  }
});

test("route-inject: corrupt cache treated as miss (no throw)", () => {
  const crypto = require("node:crypto");
  const prompt = "corrupt-cache-test-prompt-def";
  const sha1 = crypto.createHash("sha1").update(prompt).digest("hex");
  const cacheFile = path.join(os.tmpdir(), "tkr-route-" + sha1 + ".json");
  fs.writeFileSync(cacheFile, "not valid json {{{");
  try {
    const { routeInjectContext } = freshUPSRequire();
    let out;
    let threw = false;
    try {
      out = withRouteSyncOff(() => routeInjectContext({ prompt }));
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, "routeInjectContext must not throw on corrupt cache");
    assert.strictEqual(out, "", `expected empty on corrupt cache, got: ${out}`);
  } finally {
    try { fs.rmSync(cacheFile, { force: true }); } catch {}
  }
});

test("route-subagent-skip: input.subagent_type set → no injection", () => {
  const prompt = "subagent-skip-test-prompt-ghi";
  writeRouteCache(prompt, { task_class: "implement", effort: "high", why: "complex" });
  try {
    const { routeInjectContext } = freshUPSRequire();
    const out = routeInjectContext({ prompt, subagent_type: "task" });
    assert.strictEqual(out, "", `subagent dispatch must skip injection, got: ${out}`);
  } finally {
    removeRouteCache(prompt);
  }
});

test("route-subagent-skip: input.scope === 'subagent' → no injection", () => {
  const prompt = "scope-subagent-skip-test-prompt-jkl";
  writeRouteCache(prompt, { task_class: "implement", effort: "medium", why: "normal" });
  try {
    const { routeInjectContext } = freshUPSRequire();
    const out = routeInjectContext({ prompt, scope: "subagent" });
    assert.strictEqual(out, "", `scope=subagent must skip injection, got: ${out}`);
  } finally {
    removeRouteCache(prompt);
  }
});

test("route-inject: TKR_ROUTE_DISABLED=1 → no injection", () => {
  const prompt = "disabled-env-test-prompt-mno";
  writeRouteCache(prompt, { task_class: "refactor", effort: "medium", why: "cleanup" });
  const prev = process.env.TKR_ROUTE_DISABLED;
  process.env.TKR_ROUTE_DISABLED = "1";
  try {
    const { routeInjectContext } = freshUPSRequire();
    const out = routeInjectContext({ prompt });
    assert.strictEqual(out, "", `TKR_ROUTE_DISABLED=1 must suppress injection, got: ${out}`);
  } finally {
    if (prev === undefined) delete process.env.TKR_ROUTE_DISABLED;
    else process.env.TKR_ROUTE_DISABLED = prev;
    removeRouteCache(prompt);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Regression: stale-injection on new session
//
// Bug: per-project statusline file (claude-statusline-<slug>.json) was
// shared across sessions. The first UserPromptSubmit of a new session
// read the previous session's turn_count / last_ctx_k and emitted
// `[tkr: t=216 ctx=217K]` on turn 1 of a fresh session.
//
// Fix (per-session): path includes session_id. stateLineContext("sid-B")
// reads claude-statusline-<slug>-sid-B.json — which is empty for a brand
// new session — and returns "".
// ──────────────────────────────────────────────────────────────────────

test("regression: stale session-A payload does NOT leak into session-B's stateLineContext", () => {
  // Seed a per-session file for SID-A with high values that, if read,
  // would lock both turn and ctx fields and emit `[tkr: t=216 ctx=217K]`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-regression-"));
  const prevTmp = process.env.TMPDIR;
  const prevSid = process.env.TKR_SESSION_ID;
  const prevStatuslinePath = process.env.TKR_STATUSLINE_PATH;
  const prevCwd = process.cwd();
  try {
    process.env.TMPDIR = tmp;
    delete process.env.TKR_STATUSLINE_PATH; // ensure path-helper computes from sid
    process.chdir(tmp);

    const { slugifyCwd } = require("./lib/statusline-path");
    const slug = slugifyCwd(process.cwd());
    const sidA = "sid-A-prev";
    const sidB = "sid-B-fresh";

    // Bucket-mode emission is stateful per sid (last_emitted persists
    // in TKR_STATE_DIR, which this test does NOT temp-isolate); clear
    // leftovers from a previous run of this suite so the sanity
    // assertion below observes a first emission.
    const { stateLineFilePath: slfp } = require("./user-prompt-submit.js");
    try { fs.rmSync(slfp(sidA), { force: true }); } catch {}
    try { fs.rmSync(slfp(sidB), { force: true }); } catch {}

    // Seed SID-A with values that would cross both ctx and turn thresholds.
    fs.writeFileSync(
      path.join(tmp, `claude-statusline-${slug}-${sidA}.json`),
      JSON.stringify({
        last_ctx_k: 217,
        turn_count: 216,
        idle_secs: 5,
        five_hour_pct: 20,
        seven_day_pct: 30,
      }),
    );

    // Spawn the hook with SID-B as a fresh session — no seeded file.
    process.env.TKR_SESSION_ID = sidB;
    const { stateLineContext } = freshUPSRequire();
    const out = stateLineContext(sidB);

    assert.strictEqual(
      out,
      "",
      `session-B must not read session-A's payload (got: ${JSON.stringify(out)})`,
    );

    // Sanity: when we DO point at SID-A, the same code emits the line.
    process.env.TKR_SESSION_ID = sidA;
    const { stateLineContext: sl2 } = freshUPSRequire();
    const outA = sl2(sidA);
    assert.ok(
      outA.startsWith("[tkr: "),
      `expected state line when reading own session file, got: ${outA}`,
    );
  } finally {
    process.chdir(prevCwd);
    if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
    if (prevSid === undefined) delete process.env.TKR_SESSION_ID; else process.env.TKR_SESSION_ID = prevSid;
    if (prevStatuslinePath === undefined) delete process.env.TKR_STATUSLINE_PATH;
    else process.env.TKR_STATUSLINE_PATH = prevStatuslinePath;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// INV-039 regression: a stale TKR_SESSION_ID inherited from the process env
// (launch-time pin from the pre-fix `tkr claude` wrapper) must NOT beat the
// payload's session_id. Pre-fix, the `!process.env.TKR_SESSION_ID` guard kept
// the pinned sid and the hook read the previous session's telemetry, injecting
// its pressure/ctx into a fresh session's first prompt ("367K at ctx:3%").
// Spawns the real hook so the runMain env-assignment path is exercised.
test("regression INV-039: payload sid beats stale env sid in spawned hook", () => {
  const { spawnSync } = require("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-inv039-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-inv039-state-"));
  try {
    const { slugifyCwd } = require("./lib/statusline-path");
    const slug = slugifyCwd(tmp);
    const sidStale = "sid-stale-pinned";
    const sidFresh = "sid-fresh-payload";

    // Stale session's telemetry: 7d far above the state-line disclosure
    // threshold, so the "7d=88%" state line fires iff the wrong file is
    // read. (Was pressureContext pre-INV-073; stateLineContext now
    // carries the leak-detection role.)
    fs.writeFileSync(
      path.join(tmp, `claude-statusline-${slug}-${sidStale}.json`),
      JSON.stringify({ seven_day_pct: 88, five_hour_pct: 70, last_ctx_k: 367 }),
    );

    const env = { ...process.env, TMPDIR: tmp, TKR_STATE_DIR: stateDir };
    env.TKR_SESSION_ID = sidStale; // the launch-time pin
    env.TKR_ROUTE_DISABLED = "1";
    delete env.TKR_STATUSLINE_PATH;

    const run = (payload) =>
      spawnSync(process.execPath, [path.join(__dirname, "user-prompt-submit.js")], {
        input: JSON.stringify(payload),
        env,
        cwd: tmp,
        encoding: "utf8",
      });

    // Fresh session: payload carries its own sid (no telemetry file yet) —
    // nothing from the stale file may leak into the injection.
    const fresh = run({ prompt: "hello", session_id: sidFresh });
    assert.ok(
      !String(fresh.stdout).includes("tkr pressure"),
      `fresh session leaked stale-session telemetry: ${fresh.stdout}`,
    );

    // Sanity: payload without a sid legitimately falls back to the env sid
    // and reads the seeded file — proves the seeding/threshold actually fire.
    const pinned = run({ prompt: "hello" });
    assert.ok(
      String(pinned.stdout).includes("7d=88%"),
      `expected env-sid fallback to read seeded file: ${pinned.stdout}`,
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  }
});

// Issue #123: `tkr top`'s real EFFORT column reads effort-<sid>.json, which
// must refresh on every turn (not just SessionStart) so a mid-session
// /effort change is visible to a process with no view into this session's
// live env vars. Spawns the real hook so runMain's persistSessionEffort
// call is exercised end to end.
test("runMain refreshes effort-<sid>.json every turn from the live env", () => {
  const { spawnSync } = require("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-effort-turn-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-effort-turn-state-"));
  try {
    const sid = "sid-effort-turn";
    const effortPath = path.join(stateDir, `effort-${sid}.json`);
    fs.writeFileSync(effortPath, JSON.stringify({ effort: "low", source: "stale", ts: "2020-01-01T00:00:00Z" }));

    const env = { ...process.env, TMPDIR: tmp, TKR_STATE_DIR: stateDir, CLAUDE_CODE_EFFORT_LEVEL: "xhigh" };
    env.TKR_ROUTE_DISABLED = "1";
    delete env.TKR_STATUSLINE_PATH;
    delete env.TKR_SESSION_ID;

    const res = spawnSync(process.execPath, [path.join(__dirname, "user-prompt-submit.js")], {
      input: JSON.stringify({ prompt: "hello", session_id: sid }),
      env,
      cwd: tmp,
      encoding: "utf8",
    });
    assert.strictEqual(res.status, 0, `hook exited nonzero: ${res.stderr}`);

    const parsed = JSON.parse(fs.readFileSync(effortPath, "utf8"));
    assert.strictEqual(parsed.effort, "xhigh", "mid-session env effort must overwrite the stale snapshot");
    assert.strictEqual(parsed.source, "CLAUDE_CODE_EFFORT_LEVEL");
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  }
});

// #278 — recordManualSkillInvocation writes the skill-invoked row directly
// on the turn that carries CC's <command-name> scaffold, since
// skill-invoked.js's PreToolUse(Skill) handler structurally never fires
// for a typed slash command (see hooks/lib/slash-marker.js).
function readInstructionsLedger(dir) {
  const fp = path.join(dir, "instructions-load.jsonl");
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("recordManualSkillInvocation writes a manual row for a tagged command", () => {
  withTempStateDir((dir) => {
    const { recordManualSkillInvocation } = freshUPSRequire();
    recordManualSkillInvocation({
      prompt: "<local-command-caveat>...</local-command-caveat>\n<command-name>/handoff</command-name>\n<command-message>handoff</command-message>",
      session_id: "sid-manual-1",
    });
    const rows = readInstructionsLedger(dir).filter((r) => r.event === "skill-invoked");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].skill_name, "handoff");
    assert.strictEqual(rows[0].invocation_source, "manual");
    assert.strictEqual(rows[0].session_id, "sid-manual-1");
  });
});

test("recordManualSkillInvocation normalizes a plugin-qualified tag", () => {
  withTempStateDir((dir) => {
    const { recordManualSkillInvocation } = freshUPSRequire();
    recordManualSkillInvocation({
      prompt: "<command-name>/tkr:continue</command-name>",
      session_id: "sid-manual-2",
    });
    const rows = readInstructionsLedger(dir).filter((r) => r.event === "skill-invoked");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].skill_name, "continue");
  });
});

test("recordManualSkillInvocation writes nothing without a command tag", () => {
  withTempStateDir((dir) => {
    const { recordManualSkillInvocation } = freshUPSRequire();
    recordManualSkillInvocation({ prompt: "summarize the diff", session_id: "sid-manual-3" });
    assert.deepStrictEqual(readInstructionsLedger(dir), []);
  });
});

test("recordManualSkillInvocation honors TKR_SKILL_AUDIT_DISABLED", () => {
  withTempStateDir((dir) => {
    const { recordManualSkillInvocation } = freshUPSRequire();
    const prev = process.env.TKR_SKILL_AUDIT_DISABLED;
    process.env.TKR_SKILL_AUDIT_DISABLED = "1";
    try {
      recordManualSkillInvocation({
        prompt: "<command-name>/compress</command-name>",
        session_id: "sid-manual-4",
      });
    } finally {
      if (prev === undefined) delete process.env.TKR_SKILL_AUDIT_DISABLED;
      else process.env.TKR_SKILL_AUDIT_DISABLED = prev;
    }
    assert.deepStrictEqual(readInstructionsLedger(dir), []);
  });
});

test("recordManualSkillInvocation honors TKR_HOOKS_DISABLED", () => {
  withTempStateDir((dir) => {
    const { recordManualSkillInvocation } = freshUPSRequire();
    const prev = process.env.TKR_HOOKS_DISABLED;
    process.env.TKR_HOOKS_DISABLED = "1";
    try {
      recordManualSkillInvocation({
        prompt: "<command-name>/compress</command-name>",
        session_id: "sid-manual-5",
      });
    } finally {
      if (prev === undefined) delete process.env.TKR_HOOKS_DISABLED;
      else process.env.TKR_HOOKS_DISABLED = prev;
    }
    assert.deepStrictEqual(readInstructionsLedger(dir), []);
  });
});

test("recordSlashMarker also writes the manual ledger row (integration)", () => {
  withTempStateDir((dir) => {
    const { recordSlashMarker } = freshUPSRequire();
    recordSlashMarker({
      prompt: "<command-name>/status</command-name>",
      session_id: "sid-manual-6",
      prompt_id: "p1",
    });
    // Both the (defense-in-depth) marker file and the direct ledger row
    // are written from the same call.
    const markerFiles = fs.readdirSync(dir).filter((f) => f.startsWith("slash-marker-"));
    assert.strictEqual(markerFiles.length, 1);
    const rows = readInstructionsLedger(dir).filter((r) => r.event === "skill-invoked");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].skill_name, "status");
    assert.strictEqual(rows[0].invocation_source, "manual");
  });
});
