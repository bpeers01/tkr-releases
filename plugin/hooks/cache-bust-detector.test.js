#!/usr/bin/env node
// Tests for hooks/cache-bust-detector.js — pattern matches, escalation,
// state file handling, scope-aware filtering (INV-026).
//
// Run: node --test hooks/cache-bust-detector.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CACHE_CRITICAL_PATTERNS,
  CACHE_CRITICAL_RULES,
  ESCALATION_THRESHOLD,
  isCacheBustEdit,
  isInScope,
  pathStartsWith,
  recordBustEvent,
  formatBustWarning,
  checkCacheBust,
} = require("./cache-bust-detector.js");

function mkTmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cachebust-test-"));
}

// Per-platform prefixes so tests work the same on Windows and Unix.
const HOME = os.homedir();
const isWin = process.platform === "win32";
const PROJ = isWin ? "C:\\repo" : "/repo";
const OTHER_PROJ = isWin ? "C:\\other" : "/other";

function join(...parts) {
  return path.join(...parts);
}

test("CACHE_CRITICAL_PATTERNS exports a non-empty array", () => {
  assert.ok(Array.isArray(CACHE_CRITICAL_PATTERNS));
  assert.ok(CACHE_CRITICAL_PATTERNS.length >= 5);
});

test("CACHE_CRITICAL_RULES is non-empty and parallel to patterns", () => {
  assert.ok(Array.isArray(CACHE_CRITICAL_RULES));
  assert.strictEqual(CACHE_CRITICAL_RULES.length, CACHE_CRITICAL_PATTERNS.length);
  for (const rule of CACHE_CRITICAL_RULES) {
    assert.ok(rule.pattern instanceof RegExp);
    assert.ok(["project-or-home", "installed-plugin"].includes(rule.scope));
  }
});

test("ESCALATION_THRESHOLD is a small positive integer", () => {
  assert.ok(ESCALATION_THRESHOLD >= 2 && ESCALATION_THRESHOLD <= 10);
});

test("pathStartsWith honors separator boundaries", () => {
  assert.ok(pathStartsWith(join(PROJ, "CLAUDE.md"), PROJ));
  assert.ok(pathStartsWith(PROJ, PROJ));
  // Not a descendant — must not match prefix of a sibling.
  const sibling = isWin ? "C:\\repository" : "/repository";
  assert.ok(!pathStartsWith(join(sibling, "x"), PROJ));
  assert.ok(!pathStartsWith("", PROJ));
  assert.ok(!pathStartsWith(PROJ, ""));
});

test("isInScope installed-plugin requires home plugin path", () => {
  const installed = join(HOME, ".claude", "plugins", "tkr", ".claude-plugin", "plugin.json");
  const userLevel = join(HOME, ".claude-plugin", "plugin.json");
  const sourceRepo = join(PROJ, ".claude-plugin", "plugin.json");
  assert.ok(isInScope(installed, "installed-plugin", PROJ, HOME));
  assert.ok(isInScope(userLevel, "installed-plugin", PROJ, HOME));
  assert.ok(!isInScope(sourceRepo, "installed-plugin", PROJ, HOME));
  // No home → fails closed.
  assert.ok(!isInScope(installed, "installed-plugin", PROJ, ""));
});

test("isInScope project-or-home matches active cwd or home", () => {
  const inProj = join(PROJ, "CLAUDE.md");
  const inHome = join(HOME, ".claude", "CLAUDE.md");
  const elsewhere = join(OTHER_PROJ, "CLAUDE.md");
  assert.ok(isInScope(inProj, "project-or-home", PROJ, HOME));
  assert.ok(isInScope(inHome, "project-or-home", PROJ, HOME));
  assert.ok(!isInScope(elsewhere, "project-or-home", PROJ, HOME));
  // No cwd: only home check applies.
  assert.ok(!isInScope(inProj, "project-or-home", "", HOME));
  assert.ok(isInScope(inHome, "project-or-home", "", HOME));
});

test("isCacheBustEdit matches CLAUDE.md inside active cwd", () => {
  const fp = join(PROJ, "CLAUDE.md");
  const event = { tool_name: "Edit", cwd: PROJ, tool_input: { file_path: fp } };
  assert.strictEqual(isCacheBustEdit(event), fp);
});

test("isCacheBustEdit ignores CLAUDE.md outside active cwd (INV-026)", () => {
  const event = {
    tool_name: "Edit",
    cwd: PROJ,
    tool_input: { file_path: join(OTHER_PROJ, "CLAUDE.md") },
  };
  assert.strictEqual(isCacheBustEdit(event), null);
});

test("isCacheBustEdit matches user-level ~/.claude/CLAUDE.md regardless of cwd", () => {
  const fp = join(HOME, ".claude", "CLAUDE.md");
  const event = { tool_name: "Edit", cwd: OTHER_PROJ, tool_input: { file_path: fp } };
  assert.strictEqual(isCacheBustEdit(event), fp);
});

test("isCacheBustEdit matches MEMORY.md under ~/.claude/projects", () => {
  const fp = join(HOME, ".claude", "projects", "proj", "memory", "MEMORY.md");
  const event = { tool_name: "Write", cwd: PROJ, tool_input: { file_path: fp } };
  assert.ok(isCacheBustEdit(event));
});

test("isCacheBustEdit matches .claude/rules/*.md inside active cwd", () => {
  const fp = join(PROJ, ".claude", "rules", "cli-corrections.md");
  const event = { tool_name: "Edit", cwd: PROJ, tool_input: { file_path: fp } };
  assert.ok(isCacheBustEdit(event));
});

test("isCacheBustEdit matches .claude/settings.json variants in active cwd", () => {
  for (const name of ["settings.json", "settings.local.json"]) {
    const fp = join(PROJ, ".claude", name);
    const event = { tool_name: "Edit", cwd: PROJ, tool_input: { file_path: fp } };
    assert.ok(isCacheBustEdit(event), `should match ${fp}`);
  }
});

// INV-026 primary gate — source-repo plugin.json edit should be SILENT.
test("isCacheBustEdit ignores source-repo .claude-plugin/plugin.json (INV-026)", () => {
  const fp = join(PROJ, ".claude-plugin", "plugin.json");
  const event = { tool_name: "Write", cwd: PROJ, tool_input: { file_path: fp } };
  assert.strictEqual(
    isCacheBustEdit(event),
    null,
    "source-repo plugin.json must not bust running session's cache"
  );
});

// INV-026 primary gate — installed plugin.json edit SHOULD fire.
test("isCacheBustEdit matches ~/.claude/plugins/<id>/.claude-plugin/plugin.json (INV-026)", () => {
  const fp = join(HOME, ".claude", "plugins", "tkr", ".claude-plugin", "plugin.json");
  const event = { tool_name: "Write", cwd: PROJ, tool_input: { file_path: fp } };
  assert.strictEqual(isCacheBustEdit(event), fp);
});

test("isCacheBustEdit matches ~/.claude-plugin/plugin.json user-level", () => {
  const fp = join(HOME, ".claude-plugin", "plugin.json");
  const event = { tool_name: "Edit", cwd: PROJ, tool_input: { file_path: fp } };
  assert.strictEqual(isCacheBustEdit(event), fp);
});

test("isCacheBustEdit matches AGENTS.md inside active cwd", () => {
  const fp = join(PROJ, "AGENTS.md");
  const event = { tool_name: "Edit", cwd: PROJ, tool_input: { file_path: fp } };
  assert.ok(isCacheBustEdit(event));
});

test("isCacheBustEdit matches MultiEdit on cache-critical file", () => {
  const fp = join(PROJ, "CLAUDE.md");
  const event = { tool_name: "MultiEdit", cwd: PROJ, tool_input: { file_path: fp } };
  assert.ok(isCacheBustEdit(event));
});

test("isCacheBustEdit ignores Read/Bash/Glob/Grep on same paths", () => {
  for (const tool of ["Read", "Bash", "Glob", "Grep"]) {
    const event = {
      tool_name: tool,
      cwd: PROJ,
      tool_input: { file_path: join(PROJ, "CLAUDE.md") },
    };
    assert.strictEqual(isCacheBustEdit(event), null, `tool ${tool} should not match`);
  }
});

test("isCacheBustEdit ignores edits to unrelated files", () => {
  for (const rel of [
    "src/app.go",
    "README.md",
    "notes/CLAUDE.todo",
    ".claude/settings.notyaml",
    "some/CLAUDE.md.bak",
  ]) {
    const event = {
      tool_name: "Edit",
      cwd: PROJ,
      tool_input: { file_path: join(PROJ, rel) },
    };
    assert.strictEqual(isCacheBustEdit(event), null, `should not match ${rel}`);
  }
});

test("isCacheBustEdit fails closed when cwd is missing for project files", () => {
  // No cwd + path outside ~/.claude/ → cannot verify scope → no match.
  const event = {
    tool_name: "Edit",
    tool_input: { file_path: join(PROJ, "CLAUDE.md") },
  };
  assert.strictEqual(isCacheBustEdit(event), null);
});

test("isCacheBustEdit tolerates malformed events", () => {
  assert.strictEqual(isCacheBustEdit(null), null);
  assert.strictEqual(isCacheBustEdit(undefined), null);
  assert.strictEqual(isCacheBustEdit({}), null);
  assert.strictEqual(isCacheBustEdit({ tool_name: "Edit" }), null);
  assert.strictEqual(
    isCacheBustEdit({ tool_name: "Edit", tool_input: {} }),
    null
  );
});

test("recordBustEvent increments counter across calls", () => {
  const dir = mkTmpStateDir();
  process.env.TKR_STATE_DIR = dir;
  const sid = "test-session-incr";
  const c1 = recordBustEvent(sid, join(PROJ, "CLAUDE.md"));
  const c2 = recordBustEvent(sid, join(PROJ, "CLAUDE.md"));
  const c3 = recordBustEvent(sid, join(PROJ, "MEMORY.md"));
  assert.ok(c2 > c1);
  assert.ok(c3 > c2);
  assert.strictEqual(c3, c1 + 2);
});

test("recordBustEvent isolates counts per session id", () => {
  const a = recordBustEvent("test-session-A", join(PROJ, "CLAUDE.md"));
  const b = recordBustEvent("test-session-B", join(PROJ, "CLAUDE.md"));
  assert.strictEqual(a, b);
});

test("formatBustWarning escalates wording at threshold", () => {
  const fp = join(PROJ, "CLAUDE.md");
  const below = formatBustWarning(fp, ESCALATION_THRESHOLD - 1);
  const at = formatBustWarning(fp, ESCALATION_THRESHOLD);
  assert.ok(!below.includes("Strongly consider"));
  assert.ok(at.includes("Strongly consider"));
  // Both should mention the basename, not the full path.
  assert.ok(below.includes("CLAUDE.md"));
  assert.ok(!below.includes(PROJ));
});

test("checkCacheBust returns null when no edit pattern matches", () => {
  const event = {
    tool_name: "Read",
    cwd: PROJ,
    tool_input: { file_path: join(PROJ, "CLAUDE.md") },
  };
  assert.strictEqual(checkCacheBust(event, "any-sid"), null);
});

test("checkCacheBust returns warning text on hit", () => {
  const event = {
    tool_name: "Edit",
    cwd: PROJ,
    tool_input: { file_path: join(PROJ, "CLAUDE.md") },
  };
  const warning = checkCacheBust(event, "test-session-checkhit");
  assert.ok(warning);
  assert.ok(warning.includes("CLAUDE.md"));
  assert.ok(warning.includes("cache"));
});

test("checkCacheBust returns null on source-repo plugin.json edit (INV-026)", () => {
  const event = {
    tool_name: "Write",
    cwd: PROJ,
    tool_input: { file_path: join(PROJ, ".claude-plugin", "plugin.json") },
  };
  assert.strictEqual(checkCacheBust(event, "inv026-source"), null);
});

test("checkCacheBust completes well under 5ms hot path", () => {
  const event = {
    tool_name: "Edit",
    cwd: PROJ,
    tool_input: { file_path: join(PROJ, "CLAUDE.md") },
  };
  // CLIX-004: absolute-time gates flake on shared CI runners; CI workflows
  // set TKR_BENCH_BUDGET_MULT=3 for headroom, local runs stay tight.
  const mult = Math.max(1, Number(process.env.TKR_BENCH_BUDGET_MULT) || 1);
  const budgetMs = 5 * mult;
  // Warm-up so JIT stabilizes.
  for (let i = 0; i < 3; i++) checkCacheBust(event, "warmup");
  const start = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) checkCacheBust(event, "perf-test");
  const elapsedNs = process.hrtime.bigint() - start;
  const avgMs = Number(elapsedNs) / 1_000_000 / 100;
  assert.ok(avgMs < budgetMs, `avg ${avgMs.toFixed(2)}ms per call exceeds ${budgetMs}ms gate`);
});
