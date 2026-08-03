// Wave 9 — cache-bust-warn.js test cases.
// Run: node --test hooks/cache-bust-warn.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "cache-bust-warn.js");
const lib = require("./cache-bust-warn.js");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-l5-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(payload, opts = {}) {
  const { env = {}, pinnedBudget, statusline } = opts;
  return withTempDir((dir) => {
    if (pinnedBudget) {
      fs.writeFileSync(path.join(dir, "pinned-budget.json"), JSON.stringify(pinnedBudget));
    }
    let extraEnv = { ...env };
    let tmpdirOverride = null;
    if (statusline) {
      tmpdirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-l5-tmp-"));
      const statuslinePath = path.join(tmpdirOverride, "claude-statusline.json");
      fs.writeFileSync(statuslinePath, JSON.stringify(statusline));
      extraEnv.TMPDIR = tmpdirOverride;
      extraEnv.TKR_STATUSLINE_PATH = statuslinePath;
    }
    try {
      const res = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        env: { ...process.env, TKR_STATE_DIR: dir, ...extraEnv },
        encoding: "utf8",
      });
      let ledger = [];
      const lp = path.join(dir, "playbook-events.jsonl");
      if (fs.existsSync(lp)) {
        ledger = fs.readFileSync(lp, "utf8").split("\n").filter(Boolean).map(JSON.parse);
      }
      return { res, ledger, dir };
    } finally {
      if (tmpdirOverride) fs.rmSync(tmpdirOverride, { recursive: true, force: true });
    }
  });
}

// ---- Path classification ----

test("classifyPath detects each prefix-critical basename", () => {
  for (const base of [
    "CLAUDE.md",
    "AGENTS.md",
    "MEMORY.md",
    "settings.json",
    "settings.local.json",
    "plugin.json",
  ]) {
    assert.strictEqual(lib.classifyPath(`/some/path/${base}`), base);
    assert.strictEqual(lib.classifyPath(`C:\\some\\path\\${base}`), base);
  }
});

test("classifyPath detects .claude/rules/* paths", () => {
  assert.strictEqual(lib.classifyPath("/repo/.claude/rules/cache.md"), ".claude/rules/*");
  assert.strictEqual(lib.classifyPath("C:\\repo\\.claude\\rules\\anything.md"), ".claude/rules/*");
});

test("classifyPath returns empty for non-critical paths", () => {
  for (const p of [
    "/repo/src/foo.go",
    "/repo/README.md",
    "C:\\repo\\package.json",
    "/repo/.claude/settings_other.json",
    "",
  ]) {
    assert.strictEqual(lib.classifyPath(p), "", `false positive: ${p}`);
  }
});

test("classifyPath returns empty for null/undefined", () => {
  assert.strictEqual(lib.classifyPath(null), "");
  assert.strictEqual(lib.classifyPath(undefined), "");
});

// ---- Cost estimation ----

test("estimateRebuildCostUSD computes prefix_size * 5min cw rate (TTL=300)", () => {
  // 12000 tok * $18.75/M = $0.225
  const got = lib.estimateRebuildCostUSD(12000, 300);
  assert.ok(Math.abs(got - 0.225) < 1e-6, `got ${got}`);
});

test("estimateRebuildCostUSD uses 1h rate when TTL=3600", () => {
  // 12000 tok * $1.50/M = $0.018
  const got = lib.estimateRebuildCostUSD(12000, 3600);
  assert.ok(Math.abs(got - 0.018) < 1e-6, `got ${got}`);
});

test("estimateRebuildCostUSD defaults to 5min rate when ttlSeconds undefined", () => {
  // undefined < 3600 is false, so falls through to 5min rate
  const got = lib.estimateRebuildCostUSD(12000, undefined);
  assert.ok(Math.abs(got - 0.225) < 1e-6, `got ${got}`);
});

test("formatHint includes bucket + cost + prefix size (5min tier)", () => {
  const hint = lib.formatHint("CLAUDE.md", 12000, 0.23, 300);
  assert.ok(hint.includes("CLAUDE.md"));
  assert.ok(hint.includes("$0.23"));
  assert.ok(hint.includes("12000tok"));
  assert.ok(hint.includes("L5 cache-bust"));
  assert.ok(hint.includes("5min"));
});

test("formatHint shows 1h tier label when TTL=3600", () => {
  const hint = lib.formatHint("AGENTS.md", 12000, 0.018, 3600);
  assert.ok(hint.includes("1h"));
  assert.ok(!hint.includes("5min"));
});

// ---- End-to-end hook ----

test("hook fires on Edit of CLAUDE.md + emits L5 event", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-edit-1",
    },
    {
      pinnedBudget: { actual_tok: 18000, budget_tok: 12000 },
      statusline: { turn_count: 50 },
    },
  );
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  assert.ok(out.hookSpecificOutput.additionalContext.includes("L5 cache-bust"));
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(ledger[0].layer, "L5");
  assert.strictEqual(ledger[0].trigger_state.bucket, "CLAUDE.md");
  assert.strictEqual(ledger[0].trigger_state.prefix_size_tok, 18000);
  assert.ok(ledger[0].trigger_state.est_rebuild_cost_usd > 0);
});

test("hook fires on Write of plugin.json", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Write",
      tool_input: { file_path: "/repo/.claude-plugin/plugin.json" },
      session_id: "sid-write-1",
    },
    { statusline: { turn_count: 50 } },
  );
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  assert.strictEqual(ledger[0].trigger_state.bucket, "plugin.json");
});

test("hook silent on non-Edit/Write tools", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: "git status" },
      session_id: "sid-bash",
    },
    { statusline: { turn_count: 50 } },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook silent when file is not prefix-critical", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/src/main.go" },
      session_id: "sid-src",
    },
    { statusline: { turn_count: 50 } },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook skips warning during build-pattern turns (≤5 into session)", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-build-1",
    },
    { statusline: { turn_count: 3 } },
  );
  assert.strictEqual(res.stdout.trim(), "{}", "build-pattern turns must be silent");
  assert.strictEqual(ledger.length, 0);
});

test("hook fires past build-pattern turn boundary", () => {
  const { res } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-build-2",
    },
    { statusline: { turn_count: 6 } },
  );
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput, "turn 6 should fire (>5 boundary)");
});

test("hook fires when statusline is missing (no turn count)", () => {
  // Per design — turn_count == -1 (unavailable) does NOT trigger build
  // pattern protection; the warning fires.
  const { res } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-no-stat",
    },
    {},
  );
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
});

test("hook respects TKR_PLAYBOOK_L5_DISABLED kill switch", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-k1",
    },
    { env: { TKR_PLAYBOOK_L5_DISABLED: "1" }, statusline: { turn_count: 50 } },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook respects TKR_PLAYBOOK_EXTENSIONS_DISABLED kill switch", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-k2",
    },
    { env: { TKR_PLAYBOOK_EXTENSIONS_DISABLED: "1" }, statusline: { turn_count: 50 } },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook respects global TKR_PLAYBOOK_DISABLED kill switch", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-k3",
    },
    { env: { TKR_PLAYBOOK_DISABLED: "1" }, statusline: { turn_count: 50 } },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook tolerates malformed stdin", () => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: "{not json",
    env: { ...process.env, TKR_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "x-")) },
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), "{}");
});

// ---- Anti-spam ----

test("per-file dedup: same file second time stays silent", () => {
  withTempDir((dir) => {
    const tmpdirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-l5-tmp-"));
    const statuslinePath = path.join(tmpdirOverride, "claude-statusline.json");
    fs.writeFileSync(statuslinePath, JSON.stringify({ turn_count: 50 }));
    const env = { ...process.env, TKR_STATE_DIR: dir, TMPDIR: tmpdirOverride, TKR_STATUSLINE_PATH: statuslinePath };
    try {
      const payload = {
        tool_name: "Edit",
        tool_input: { file_path: "/repo/CLAUDE.md" },
        session_id: "sid-dedup",
      };
      const a = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        env,
        encoding: "utf8",
      });
      assert.notStrictEqual(a.stdout.trim(), "{}", "first fire expected");

      const b = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        env,
        encoding: "utf8",
      });
      assert.strictEqual(b.stdout.trim(), "{}", "second fire same file must be silent");

      const ledger = fs
        .readFileSync(path.join(dir, "playbook-events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean);
      assert.strictEqual(ledger.length, 1);
    } finally {
      fs.rmSync(tmpdirOverride, { recursive: true, force: true });
    }
  });
});

test("different files in same session each warn once", () => {
  withTempDir((dir) => {
    const tmpdirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-l5-tmp-"));
    const statuslinePath = path.join(tmpdirOverride, "claude-statusline.json");
    fs.writeFileSync(statuslinePath, JSON.stringify({ turn_count: 50 }));
    const env = { ...process.env, TKR_STATE_DIR: dir, TMPDIR: tmpdirOverride, TKR_STATUSLINE_PATH: statuslinePath };
    try {
      const sid = "sid-multi";
      let fires = 0;
      for (const fp of ["/repo/CLAUDE.md", "/repo/AGENTS.md", "/repo/MEMORY.md"]) {
        const res = spawnSync(process.execPath, [HOOK], {
          input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: fp }, session_id: sid }),
          env,
          encoding: "utf8",
        });
        if (res.stdout.trim() !== "{}") fires++;
      }
      assert.strictEqual(fires, 3, "each distinct prefix-critical file should warn once");
    } finally {
      fs.rmSync(tmpdirOverride, { recursive: true, force: true });
    }
  });
});

test("falls back to default pinned size when cache missing", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-fallback",
    },
    { statusline: { turn_count: 50 } },
  );
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  assert.strictEqual(ledger[0].trigger_state.prefix_size_tok, lib.FALLBACK_PINNED_TOK);
});

// ---- TTL-aware rate selection (PLAN-1 T4) ----

test("TTL=3600 via env: cost is smaller than 5min rate for same prefix size", () => {
  // TKR_CACHE_TTL_SECONDS=3600 → config source → 1h rate ($1.50/M instead of $18.75/M)
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/CLAUDE.md" },
      session_id: "sid-ttl-1h",
    },
    {
      env: { TKR_CACHE_TTL_SECONDS: "3600" },
      pinnedBudget: { actual_tok: 12000, budget_tok: 12000 },
      statusline: { turn_count: 50 },
    },
  );
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  // At 1h rate: 12000 * $1.50/M = $0.018
  const costUSD = ledger[0].trigger_state.est_rebuild_cost_usd;
  assert.ok(Math.abs(costUSD - 0.018) < 1e-4, `expected ~0.018, got ${costUSD}`);
  // Hint should mention "1h" tier
  assert.ok(out.hookSpecificOutput.additionalContext.includes("1h"), "hint should reference 1h rate");
  // Telemetry should carry ttl_seconds=3600
  assert.strictEqual(ledger[0].trigger_state.ttl_seconds, 3600);
});

test("TTL=300 via env: cost matches original 5min rate", () => {
  // TKR_CACHE_TTL_SECONDS=300 → config source → 5min rate ($18.75/M)
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/AGENTS.md" },
      session_id: "sid-ttl-5m",
    },
    {
      env: { TKR_CACHE_TTL_SECONDS: "300" },
      pinnedBudget: { actual_tok: 12000, budget_tok: 12000 },
      statusline: { turn_count: 50 },
    },
  );
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  // At 5min rate: 12000 * $18.75/M = $0.225
  const costUSD = ledger[0].trigger_state.est_rebuild_cost_usd;
  assert.ok(Math.abs(costUSD - 0.225) < 1e-4, `expected ~0.225, got ${costUSD}`);
  assert.ok(out.hookSpecificOutput.additionalContext.includes("5min"), "hint should reference 5min rate");
  assert.strictEqual(ledger[0].trigger_state.ttl_seconds, 300);
});

test("TTL_DETECTION_DISABLED: falls back to 5min rate (default behavior preserved)", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/MEMORY.md" },
      session_id: "sid-ttl-disabled",
    },
    {
      env: { TKR_TTL_DETECTION_DISABLED: "1" },
      pinnedBudget: { actual_tok: 12000, budget_tok: 12000 },
      statusline: { turn_count: 50 },
    },
  );
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  // Default TTL=300 → 5min rate
  const costUSD = ledger[0].trigger_state.est_rebuild_cost_usd;
  assert.ok(Math.abs(costUSD - 0.225) < 1e-4, `expected ~0.225, got ${costUSD}`);
  assert.ok(out.hookSpecificOutput.additionalContext.includes("5min"));
});
