#!/usr/bin/env node
// Probe test for hooks/post-tool-call.js — verifies cap-nudge replaces
// Claude Code's native Glob/Grep truncation markers with tkr-flavored
// guidance.
//
// Run: node hooks/post-tool-call.test.js

const test = require("node:test");
const assert = require("node:assert");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  applyCapNudge,
  GLOB_TRUNC_MARKER,
  GREP_TRUNC_MARKER,
  ctxBreakpointContext,
  ctxBreakpointStatePath,
  CTX_BREAKPOINT_ADVISORIES,
} = require("./post-tool-call.js");

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-pt-test-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

const GLOB_NATIVE =
  "(Results are truncated. Consider using a more specific path or pattern.)";

function globEvent(text) {
  return {
    tool_name: "Glob",
    tool_response: { content: text },
  };
}

function grepEvent(text) {
  return {
    tool_name: "Grep",
    tool_response: { content: text },
  };
}

function info(text) {
  return { field: "content", text };
}

test("Glob result with truncation marker → replaced with tkr nudge", () => {
  const text = "src/a.ts\nsrc/b.ts\n" + GLOB_NATIVE;
  const result = applyCapNudge(globEvent(text), info(text));
  assert.ok(result, "expected replacement string");
  assert.ok(result.includes("[tkr] Glob hit 100-file cap"));
  assert.ok(result.includes("tkr search"));
  assert.ok(!result.includes(GLOB_NATIVE), "native marker should be replaced");
  assert.ok(result.includes("src/a.ts"), "filenames should be preserved");
});

test("Glob result without truncation marker → null (passthrough)", () => {
  const text = "src/a.ts\nsrc/b.ts\n";
  const result = applyCapNudge(globEvent(text), info(text));
  assert.strictEqual(result, null);
});

test("Grep result with default limit:250 marker → replaced", () => {
  const text =
    "match line 1\nmatch line 2\n[Showing results with pagination = limit: 250]";
  const result = applyCapNudge(grepEvent(text), info(text));
  assert.ok(result);
  assert.ok(result.includes("[tkr] Grep hit 250-line cap"));
  assert.ok(result.includes("head_limit=0"));
  assert.ok(!result.includes("[Showing results with pagination"));
});

test("Grep result with custom limit:100 marker → preserves the limit number", () => {
  const text = "x\n[Showing results with pagination = limit: 100]";
  const result = applyCapNudge(grepEvent(text), info(text));
  assert.ok(result);
  assert.ok(result.includes("100-line cap"));
});

test("Grep result with limit + offset → still replaces", () => {
  const text =
    "x\n[Showing results with pagination = limit: 250, offset: 100]";
  const result = applyCapNudge(grepEvent(text), info(text));
  assert.ok(result);
  assert.ok(result.includes("250-line cap"));
});

test("Grep result without marker → null", () => {
  const text = "match line 1\nmatch line 2\n";
  const result = applyCapNudge(grepEvent(text), info(text));
  assert.strictEqual(result, null);
});

test("Non-Glob/Grep tool → null", () => {
  const text = "anything " + GLOB_NATIVE;
  const event = { tool_name: "Read", tool_response: { content: text } };
  const result = applyCapNudge(event, info(text));
  assert.strictEqual(result, null);
});

test("TKR_CAP_NUDGE_DISABLED=1 → null", () => {
  const text = "src/a.ts\n" + GLOB_NATIVE;
  process.env.TKR_CAP_NUDGE_DISABLED = "1";
  try {
    const result = applyCapNudge(globEvent(text), info(text));
    assert.strictEqual(result, null);
  } finally {
    delete process.env.TKR_CAP_NUDGE_DISABLED;
  }
});

test("Empty outputInfo → null", () => {
  const result = applyCapNudge(globEvent("x"), null);
  assert.strictEqual(result, null);
});

test("Empty text → null", () => {
  const result = applyCapNudge(globEvent(""), info(""));
  assert.strictEqual(result, null);
});

test("Null event → null (no crash)", () => {
  const result = applyCapNudge(null, info("x"));
  assert.strictEqual(result, null);
});

test("GLOB_TRUNC_MARKER regex matches native string exactly", () => {
  assert.ok(GLOB_TRUNC_MARKER.test(GLOB_NATIVE));
});

test("GREP_TRUNC_MARKER captures the limit number", () => {
  const m = "[Showing results with pagination = limit: 42]".match(
    GREP_TRUNC_MARKER,
  );
  assert.ok(m);
  assert.strictEqual(m[1], "42");
});

test("PR5-c1: legacy brevityContext pre-compose pattern stays deleted", () => {
  // History: this test originally documented the pre-compose-once /
  // use-many-callsites brevityContext pattern as a live architectural
  // risk, with instructions to flip the assertions once the legacy path
  // was deleted. INV-073 (2026-07-23) deleted the V2=0 legacy branch and
  // brevityContext itself — assertions now guard against re-introduction.

  const hookContent = fs.readFileSync(
    path.join(__dirname, "post-tool-call.js"),
    "utf8",
  );

  // ASSERTION 1: the pre-composition callsite is gone.
  assert.ok(
    !hookContent.includes("const ctx = brevityContext(sessionID);"),
    "INV-073: pre-composition brevityContext callsite must stay deleted",
  );

  // ASSERTION 2: brevityContext no longer exists in the brevity module.
  const brevityContent = fs.readFileSync(
    path.join(__dirname, "lib", "posttool", "brevity.js"),
    "utf8",
  );
  assert.ok(
    !brevityContent.includes("function brevityContext"),
    "INV-073: brevityContext function must stay deleted from lib/posttool/brevity.js",
  );

  // ASSERTION 3: composition threads the ctx-breakpoint advisory single-
  // source result (Risk #15 pattern), not a per-turn brevity re-anchor.
  assert.ok(
    hookContent.includes("ctxBreakpointContext(sessionID)"),
    "composition must source from ctxBreakpointContext",
  );
});

// ────────────────────────────────────────────────────────────────────
// PR #5 c2 — Channel 2: ctx-breakpoint detector tests.
// The detector is unconditional since INV-073 deleted the V2=0 legacy
// branch (the gate had been default-ON since 2026-05-13).

function withFakeStatusline(payload, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-pt-stl-"));
  const file = path.join(dir, "claude-statusline.json");
  fs.writeFileSync(file, JSON.stringify(payload));
  try {
    return fn(file);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function readBreakpointState(sid) {
  try {
    return JSON.parse(fs.readFileSync(ctxBreakpointStatePath(sid), "utf8"));
  } catch {
    return null;
  }
}

function writeBreakpointState(sid, state) {
  fs.mkdirSync(path.dirname(ctxBreakpointStatePath(sid)), { recursive: true });
  fs.writeFileSync(ctxBreakpointStatePath(sid), JSON.stringify(state));
}

// INV-073: composition is unconditional — no env gate, no legacy branch.
test("PR5-c2: composition is ungated and legacy dispatch stays deleted", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "post-tool-call.js"),
    "utf8",
  );
  assert.ok(
    src.includes("ctxBreakpointContext(sessionID)"),
    "composition must call ctxBreakpointContext",
  );
  assert.ok(
    !src.includes("injectionV2Active"),
    "INV-073: injectionV2Active dispatch must stay deleted",
  );
  assert.ok(
    !src.includes("brevityContext("),
    "INV-073: legacy brevityContext callsite must stay deleted",
  );
});

// Test 3: V2=1 fresh session, ctx < 100K → no advisory.
test("PR5-c2 V2: ctx=80K, fresh state → empty string", () => {
  withTempStateDir(() => {
    withFakeStatusline({ last_ctx_k: 80 }, (file) => {
      const result = ctxBreakpointContext("sid-below", file);
      assert.strictEqual(result, "");
      // No state write on no-emit.
      assert.strictEqual(readBreakpointState("sid-below"), null);
    });
  });
});

// Tests 4-8: single-threshold crossings, fresh state.
test("PR5-c2 V2: ctx=110K fresh → 100K advisory", () => {
  withTempStateDir(() => {
    withFakeStatusline({ last_ctx_k: 110 }, (file) => {
      const result = ctxBreakpointContext("sid-100", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[100]);
      assert.deepStrictEqual(readBreakpointState("sid-100"), { high_water_k: 100 });
    });
  });
});

test("PR5-c2 V2: ctx=160K fresh → 150K advisory", () => {
  withTempStateDir(() => {
    withFakeStatusline({ last_ctx_k: 160 }, (file) => {
      const result = ctxBreakpointContext("sid-150", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[150]);
      assert.deepStrictEqual(readBreakpointState("sid-150"), { high_water_k: 150 });
    });
  });
});

test("PR5-c2 V2: ctx=210K fresh → 200K advisory", () => {
  withTempStateDir(() => {
    withFakeStatusline({ last_ctx_k: 210 }, (file) => {
      const result = ctxBreakpointContext("sid-200", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[200]);
      assert.deepStrictEqual(readBreakpointState("sid-200"), { high_water_k: 200 });
    });
  });
});

test("PR5-c2 V2: ctx=260K fresh → 250K SOFT advisory", () => {
  withTempStateDir(() => {
    withFakeStatusline({ last_ctx_k: 260 }, (file) => {
      const result = ctxBreakpointContext("sid-250", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[250]);
      assert.deepStrictEqual(readBreakpointState("sid-250"), { high_water_k: 250 });
    });
  });
});

test("PR5-c2 V2: ctx=310K fresh → 300K HARD advisory", () => {
  withTempStateDir(() => {
    withFakeStatusline({ last_ctx_k: 310 }, (file) => {
      const result = ctxBreakpointContext("sid-300", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[300]);
      assert.deepStrictEqual(readBreakpointState("sid-300"), { high_water_k: 300 });
    });
  });
});

// Test 9: multi-threshold jump — emit highest, skip lower.
test("PR5-c2 V2: ctx=220K fresh → ONLY 200K (skips 100/150)", () => {
  withTempStateDir(() => {
    withFakeStatusline({ last_ctx_k: 220 }, (file) => {
      const result = ctxBreakpointContext("sid-jump", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[200]);
      assert.strictEqual(result.includes("100K"), false);
      assert.strictEqual(result.includes("150K"), false);
      assert.deepStrictEqual(readBreakpointState("sid-jump"), { high_water_k: 200 });
    });
  });
});

// Tests 10-12: high-water dedup behaviors.
test("PR5-c2 V2: high_water_k=100 + ctx=110K → no advisory (already crossed)", () => {
  withTempStateDir(() => {
    writeBreakpointState("sid-dedup", { high_water_k: 100 });
    withFakeStatusline({ last_ctx_k: 110 }, (file) => {
      const result = ctxBreakpointContext("sid-dedup", file);
      assert.strictEqual(result, "");
      assert.deepStrictEqual(readBreakpointState("sid-dedup"), { high_water_k: 100 });
    });
  });
});

test("PR5-c2 V2: high_water_k=100 + ctx=80K → no advisory (ctx below water)", () => {
  withTempStateDir(() => {
    writeBreakpointState("sid-drop", { high_water_k: 100 });
    withFakeStatusline({ last_ctx_k: 80 }, (file) => {
      const result = ctxBreakpointContext("sid-drop", file);
      assert.strictEqual(result, "");
      assert.deepStrictEqual(readBreakpointState("sid-drop"), { high_water_k: 100 });
    });
  });
});

test("PR5-c2 V2: drop-and-recross sequence preserves high-water", () => {
  withTempStateDir(() => {
    // First call: ctx=110K crosses 100K.
    withFakeStatusline({ last_ctx_k: 110 }, (file) => {
      assert.strictEqual(
        ctxBreakpointContext("sid-drr", file),
        CTX_BREAKPOINT_ADVISORIES[100],
      );
    });
    // Drop: ctx=80K, no advisory.
    withFakeStatusline({ last_ctx_k: 80 }, (file) => {
      assert.strictEqual(ctxBreakpointContext("sid-drr", file), "");
    });
    // Re-cross 100K: still no advisory (100 > 100 is false).
    withFakeStatusline({ last_ctx_k: 110 }, (file) => {
      assert.strictEqual(ctxBreakpointContext("sid-drr", file), "");
    });
    assert.deepStrictEqual(readBreakpointState("sid-drr"), { high_water_k: 100 });
  });
});

// Test 13: high_water=200 + ctx=260K → emit 250K.
test("PR5-c2 V2: high_water_k=200 + ctx=260K → 250K SOFT advisory", () => {
  withTempStateDir(() => {
    writeBreakpointState("sid-step", { high_water_k: 200 });
    withFakeStatusline({ last_ctx_k: 260 }, (file) => {
      const result = ctxBreakpointContext("sid-step", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[250]);
      assert.deepStrictEqual(readBreakpointState("sid-step"), { high_water_k: 250 });
    });
  });
});

// Tests 14-15: corruption tolerance.
test("PR5-c2 V2: corrupt state (not JSON) → treated as fresh", () => {
  withTempStateDir(() => {
    fs.mkdirSync(path.dirname(ctxBreakpointStatePath("sid-corrupt")), {
      recursive: true,
    });
    fs.writeFileSync(ctxBreakpointStatePath("sid-corrupt"), "not-json");
    withFakeStatusline({ last_ctx_k: 110 }, (file) => {
      const result = ctxBreakpointContext("sid-corrupt", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[100]);
      assert.deepStrictEqual(readBreakpointState("sid-corrupt"), { high_water_k: 100 });
    });
  });
});

test("PR5-c2 V2: valid JSON missing high_water_k → treated as fresh", () => {
  withTempStateDir(() => {
    writeBreakpointState("sid-empty", {});
    withFakeStatusline({ last_ctx_k: 110 }, (file) => {
      const result = ctxBreakpointContext("sid-empty", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[100]);
      assert.deepStrictEqual(readBreakpointState("sid-empty"), { high_water_k: 100 });
    });
  });
});

// Test 16: statusline file absent.
test("PR5-c2 V2: statusline file missing → no advisory", () => {
  withTempStateDir(() => {
    const result = ctxBreakpointContext(
      "sid-nostat",
      "/nonexistent/claude-statusline.json",
    );
    assert.strictEqual(result, "");
    assert.strictEqual(readBreakpointState("sid-nostat"), null);
  });
});

// Test 17: golden wording — state-only strings (stage 2).
// Hooks report state; the verb lives in the system prompt.
test("PR5-c2 V2: state-only advisory wording exact strings", () => {
  assert.strictEqual(CTX_BREAKPOINT_ADVISORIES[100], "[tkr: ctx≈100K]");
  assert.strictEqual(CTX_BREAKPOINT_ADVISORIES[150], "[tkr: ctx≈150K]");
  assert.strictEqual(CTX_BREAKPOINT_ADVISORIES[200], "[tkr: ctx≈200K]");
  assert.strictEqual(CTX_BREAKPOINT_ADVISORIES[250], "[tkr: ctx≈250K]");
  assert.strictEqual(CTX_BREAKPOINT_ADVISORIES[300], "[tkr: ctx≈300K]");
});

// Test 18: config override — subset only.
test("PR5-c2 V2: cfg.injection.ctx_breakpoints subset = [50,100] falls back to defaults", () => {
  // 50 is NOT in default set, so subset rule rejects entire user array.
  // Result: defaults apply; ctx=60K → no advisory (60 < 100).
  withTempStateDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        injection: { ctx_breakpoints: [50, 100] },
      }),
    );
    withFakeStatusline({ last_ctx_k: 60 }, (file) => {
      const result = ctxBreakpointContext("sid-cfg", file);
      assert.strictEqual(result, "");
    });
  });
});

test("PR5-c2 V2: cfg subset = [100, 200] (valid subset) honored, 150K excluded", () => {
  withTempStateDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ injection: { ctx_breakpoints: [100, 200] } }),
    );
    // ctx=160K — 150 not in user set, so highest matching is 100.
    withFakeStatusline({ last_ctx_k: 160 }, (file) => {
      const result = ctxBreakpointContext("sid-sub", file);
      assert.strictEqual(result, CTX_BREAKPOINT_ADVISORIES[100]);
    });
  });
});

// Cross-test: ctxBreakpointContext reads dedup state FRESH each call.
// Risk #15 architectural rule — verified by source inspection.
test("PR5-c2 V2: ctxBreakpointContext reads dedup state fresh inside function body", () => {
  // ctxBreakpointContext moved to lib/posttool/ctx-breakpoint.js during #16
  // god-hook decomp; the orchestrator still has exactly one call site.
  const moduleSrc = fs.readFileSync(
    path.join(__dirname, "lib", "posttool", "ctx-breakpoint.js"),
    "utf8",
  );
  // Function body must read state via readCtxBreakpointState(sid) AFTER entering
  // the function — not pre-computed at caller.
  const fnStart = moduleSrc.indexOf("function ctxBreakpointContext(");
  assert.ok(fnStart > 0, "function defined in lib/posttool/ctx-breakpoint.js");
  const fnEnd = moduleSrc.indexOf("\nmodule.exports", fnStart);
  const body = moduleSrc.slice(fnStart, fnEnd);
  assert.ok(
    body.includes("readCtxBreakpointState(sid)"),
    "ctxBreakpointContext must read dedup state inside its own body",
  );
  // Only ONE call site of ctxBreakpointContext exists in processEvent —
  // single-source-passed-through is fine; pre-compose-many-callsites is not.
  const orchestratorSrc = fs.readFileSync(
    path.join(__dirname, "post-tool-call.js"),
    "utf8",
  );
  const callSites = (orchestratorSrc.match(/ctxBreakpointContext\(sessionID\)/g) || []).length;
  assert.strictEqual(
    callSites,
    1,
    "ctxBreakpointContext must be called from exactly one site in processEvent",
  );
});

