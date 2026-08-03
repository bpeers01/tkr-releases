#!/usr/bin/env node
// Unit test for hooks/lib/posttool/commit-refresh.js.
// Run: node hooks/lib/posttool/commit-refresh.test.js

const test = require("node:test");
const assert = require("node:assert");

const {
  shouldFire,
  GIT_MUTATING_RE,
} = require("./commit-refresh.js");

function bash(cmd) {
  return { tool_name: "Bash", tool_input: { command: cmd } };
}

test("matches mutating git verbs", () => {
  const verbs = [
    "git commit -m 'x'",
    "git merge feature/foo",
    "git cherry-pick abc123",
    "git rebase -i HEAD~3",
    "git reset --hard HEAD~1",
  ];
  for (const cmd of verbs) {
    assert.ok(GIT_MUTATING_RE.test(cmd), `should match: ${cmd}`);
    assert.strictEqual(shouldFire(bash(cmd)), true, `shouldFire: ${cmd}`);
  }
});

test("does not match read-only git verbs", () => {
  const verbs = [
    "git status",
    "git log",
    "git diff",
    "git show HEAD",
    "git fetch",
    "git stash",
  ];
  for (const cmd of verbs) {
    assert.strictEqual(GIT_MUTATING_RE.test(cmd), false, `should NOT match: ${cmd}`);
    assert.strictEqual(shouldFire(bash(cmd)), false, `shouldFire: ${cmd}`);
  }
});

test("does not match git-prefixed words", () => {
  assert.strictEqual(GIT_MUTATING_RE.test("github commit"), false);
  assert.strictEqual(GIT_MUTATING_RE.test("mygit commit"), false);
  assert.strictEqual(GIT_MUTATING_RE.test("git-committer"), false);
  // `git committed-changes` (no whitespace between commit and -)
  // is rejected by the trailing \b.
  assert.strictEqual(GIT_MUTATING_RE.test("git committed-changes"), false);
});

test("non-Bash events are ignored", () => {
  assert.strictEqual(
    shouldFire({ tool_name: "Edit", tool_input: { command: "git commit" } }),
    false,
  );
  assert.strictEqual(
    shouldFire({ tool_name: "Read", tool_input: { command: "git commit" } }),
    false,
  );
});

test("missing tool_input.command is tolerated", () => {
  assert.strictEqual(shouldFire({ tool_name: "Bash" }), false);
  assert.strictEqual(shouldFire({ tool_name: "Bash", tool_input: {} }), false);
  assert.strictEqual(
    shouldFire({ tool_name: "Bash", tool_input: { command: null } }),
    false,
  );
});

test("TKR_POST_COMMIT_REFRESH_DISABLED=1 short-circuits", () => {
  const prev = process.env.TKR_POST_COMMIT_REFRESH_DISABLED;
  process.env.TKR_POST_COMMIT_REFRESH_DISABLED = "1";
  try {
    assert.strictEqual(shouldFire(bash("git commit -m 'x'")), false);
  } finally {
    if (prev === undefined) delete process.env.TKR_POST_COMMIT_REFRESH_DISABLED;
    else process.env.TKR_POST_COMMIT_REFRESH_DISABLED = prev;
  }
});

test("TKR_SESSION_REFRESH_DISABLED=1 short-circuits (shared with SessionStart)", () => {
  const prev = process.env.TKR_SESSION_REFRESH_DISABLED;
  process.env.TKR_SESSION_REFRESH_DISABLED = "1";
  try {
    assert.strictEqual(shouldFire(bash("git commit -m 'x'")), false);
  } finally {
    if (prev === undefined) delete process.env.TKR_SESSION_REFRESH_DISABLED;
    else process.env.TKR_SESSION_REFRESH_DISABLED = prev;
  }
});

test("matches verb anywhere in a compound command", () => {
  // `cd repo && git commit -m 'x'` — verb appears after the shell join.
  assert.ok(GIT_MUTATING_RE.test("cd repo && git commit -m 'x'"));
  assert.strictEqual(
    shouldFire(bash("cd repo && git commit -m 'x'")),
    true,
  );
});
