#!/usr/bin/env node
// Probe test for hooks/cli-corrections-injector.js — verifies failure
// detection, command-token extraction, parsing of cli-corrections.md,
// match scoring, and the PostToolUse output schema.
//
// Run: node hooks/cli-corrections-injector.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.resolve(__dirname, "cli-corrections-injector.js");
const mod = require("./cli-corrections-injector.js");

// --- unit tests on exported helpers ---

test("isFailure: is_error true", () => {
  assert.strictEqual(mod.isFailure({ is_error: true }, "anything"), true);
});

test("isFailure: stdout starts with 'Exit code N'", () => {
  assert.strictEqual(mod.isFailure({ stdout: "Exit code 1\nblah" }, "x"), true);
});

test("isFailure: success passes", () => {
  assert.strictEqual(mod.isFailure({ stdout: "ok\n", stderr: "" }, "x"), false);
});

test("commandToken: strips env vars and tkr prefix", () => {
  assert.strictEqual(mod.commandToken("FOO=1 BAR=2 git push"), "git");
  assert.strictEqual(mod.commandToken("tkr ls -la"), "ls");
  assert.strictEqual(mod.commandToken("python -m pytest"), "python");
  assert.strictEqual(mod.commandToken(""), "");
});

test("parseCorrections: skips frontmatter, extracts entries", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cc-test-"));
  const f = path.join(tmp, "cli-corrections.md");
  fs.writeFileSync(
    f,
    "---\npaths:\n  - \"__tkr_disabled__/**\"\n---\n\n" +
      "# CLI Corrections\n\n" +
      "## Frequent Errors\n\n" +
      "- `ls` fails often with: Exit code 2 (600x, 236 sessions)\n" +
      "- `go test` fails often with: FAIL (188x, 56 sessions)\n",
  );
  const got = mod.parseCorrections(f);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].cmd, "ls");
  assert.ok(got[0].error.includes("Exit code 2"));
  assert.strictEqual(got[1].cmd, "go test");
});

test("findMatches: filters by command, ranks by error overlap", () => {
  const corrections = [
    { cmd: "ls", error: "Exit code 2 (600x)", line: "- `ls` fails ..." },
    { cmd: "ls", error: "cannot access '<path>' (60x)", line: "- `ls` cannot ..." },
    { cmd: "git", error: "fatal: ... (10x)", line: "- `git` fails ..." },
  ];
  const matches = mod.findMatches(corrections, "ls", "cannot access /tmp/foo");
  assert.strictEqual(matches.length, 2);
  assert.strictEqual(matches[0].cmd, "ls");
  assert.ok(matches[0].error.includes("cannot access")); // ranked higher
});

test("buildContext: includes guidance + footer", () => {
  const ctx = mod.buildContext(
    [{ cmd: "ls", error: "Exit code 2", line: "- `ls` fails often with: Exit code 2" }],
    "ls",
  );
  assert.ok(ctx.includes("`ls`"));
  assert.ok(ctx.includes("Exit code 2"));
  assert.ok(ctx.includes("tkr learn"));
});

// --- end-to-end via stdin ---

function runHookE2E(event, correctionsFile) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cc-e2e-"));
  const env = { ...process.env, TKR_STATE_DIR: tmpHome };
  // Place corrections file inside event.cwd so findCorrectionsFile picks it up
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cc-proj-"));
  const rulesDir = path.join(projectDir, ".claude", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "cli-corrections.md"), correctionsFile);
  event.cwd = projectDir;
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    env,
    encoding: "utf8",
  });
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  return res;
}

const SAMPLE = "---\npaths:\n  - \"__tkr_disabled__/**\"\n---\n\n" +
  "- `ls` fails often with: Exit code 2 (600x, 236 sessions)\n" +
  "- `go test` fails often with: FAIL (188x, 56 sessions)\n";

test("e2e: failed bash with matching cmd returns additionalContext", () => {
  const res = runHookE2E(
    {
      tool_name: "Bash",
      tool_input: { command: "ls /nonexistent" },
      tool_response: { is_error: true, stdout: "Exit code 2\n" },
    },
    SAMPLE,
  );
  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("`ls`"));
});

test("e2e: success bash returns empty {}", () => {
  const res = runHookE2E(
    {
      tool_name: "Bash",
      tool_input: { command: "ls /tmp" },
      tool_response: { stdout: "ok\n" },
    },
    SAMPLE,
  );
  assert.strictEqual(res.stdout, "{}");
});

test("e2e: non-Bash tool returns empty {}", () => {
  const res = runHookE2E(
    {
      tool_name: "Edit",
      tool_input: { file_path: "x" },
      tool_response: { is_error: true },
    },
    SAMPLE,
  );
  assert.strictEqual(res.stdout, "{}");
});

test("e2e: failed bash with no matching cmd returns empty {}", () => {
  const res = runHookE2E(
    {
      tool_name: "Bash",
      tool_input: { command: "frobnicate --foo" },
      tool_response: { is_error: true, stdout: "Exit code 1\n" },
    },
    SAMPLE,
  );
  assert.strictEqual(res.stdout, "{}");
});

// --- disk cache tests ---

test("disk cache: first invocation walks + writes cache", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cc-disk-cache-1-"));
  const env = { ...process.env, TKR_STATE_DIR: tmpHome };
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cc-proj-disk-1-"));
  const rulesDir = path.join(projectDir, ".claude", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "cli-corrections.md"), SAMPLE);

  // Run hook for the first time with this project cwd
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls /nonexistent" },
      tool_response: { is_error: true, stdout: "Exit code 2\n" },
      cwd: projectDir,
    }),
    env,
    encoding: "utf8",
  });

  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput, "Should return match on first invocation");

  // Verify cache file was written
  const cacheFile = path.join(tmpHome, "cli-corrections-path.json");
  assert.ok(fs.existsSync(cacheFile), "Cache file should exist after walk");
  const cacheData = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const expectedPath = path.join(rulesDir, "cli-corrections.md");
  // Cache key is SHA1 of projectDir
  const crypto = require("crypto");
  const key = crypto.createHash("sha1").update(projectDir).digest("hex");
  assert.ok(cacheData[key], "Cache should have entry for this cwd");
  assert.strictEqual(cacheData[key].path, expectedPath, "Cached path should match");

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("disk cache: stale entry (>24h) triggers re-walk", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cc-disk-cache-stale-"));
  const env = { ...process.env, TKR_STATE_DIR: tmpHome };
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-cc-proj-stale-"));
  const rulesDir = path.join(projectDir, ".claude", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "cli-corrections.md"), SAMPLE);

  // Pre-populate cache with stale entry (25h old)
  const cacheFile = path.join(tmpHome, "cli-corrections-path.json");
  const crypto = require("crypto");
  const key = crypto.createHash("sha1").update(projectDir).digest("hex");
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      [key]: {
        path: path.join(projectDir, ".claude", "rules", "cli-corrections.md"),
        resolved_at: staleTime,
      },
    }),
  );

  // Run hook — should trigger a re-walk despite stale cache
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls /nonexistent" },
      tool_response: { is_error: true, stdout: "Exit code 2\n" },
      cwd: projectDir,
    }),
    env,
    encoding: "utf8",
  });

  assert.strictEqual(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput, "Should find match even with stale cache");

  // Verify cache was updated with fresh timestamp
  const updatedCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const newTime = new Date(updatedCache[key].resolved_at).getTime();
  assert.ok(newTime > Date.now() - 60000, "Cache should be refreshed (within 1min)");

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});
