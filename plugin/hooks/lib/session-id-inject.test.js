// hooks/lib/session-id-inject.test.js
//
// INV-121 regression pin: the rewritten command handed back to Claude Code
// must carry the real session id as a --session-id flag so the spawned tkr
// process keys delta snapshots on it instead of falling back to
// pid-<ppid> (a fresh id per invocation that can never produce a hit).

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { injectSessionID, injectIDs, SAFE_SID } = require("./session-id-inject");

test("single command: flag inserted right after the tkr token", () => {
  const out = injectSessionID("tkr grep -n foo bar.go", "abc123-def");
  assert.strictEqual(out, "tkr --session-id abc123-def grep -n foo bar.go");
});

test("compound command: flag inserted into every tkr segment", () => {
  const out = injectSessionID("cd /repo && tkr git status", "sid1");
  assert.strictEqual(out, "cd /repo && tkr --session-id sid1 git status");
});

test("multiple tkr segments in one compound command all get the flag", () => {
  const out = injectSessionID("tkr git status && tkr git diff", "sid1");
  assert.strictEqual(out, "tkr --session-id sid1 git status && tkr --session-id sid1 git diff");
});

test("env-prefixed rewrite keeps the prefix before tkr", () => {
  const out = injectSessionID("AWS_PROFILE=foo tkr aws logs describe-log-streams", "sid1");
  assert.strictEqual(out, "AWS_PROFILE=foo tkr --session-id sid1 aws logs describe-log-streams");
});

test("|| and ; separators are also treated as segment boundaries", () => {
  assert.strictEqual(
    injectSessionID("tkr git status || tkr git log", "s"),
    "tkr --session-id s git status || tkr --session-id s git log",
  );
  assert.strictEqual(
    injectSessionID("tkr git status ; tkr git log", "s"),
    "tkr --session-id s git status ; tkr --session-id s git log",
  );
});

test("pipe is not a segment boundary — only the leading tkr gets the flag", () => {
  const out = injectSessionID("tkr grep foo | wc -l", "s");
  assert.strictEqual(out, "tkr --session-id s grep foo | wc -l");
});

test("word containing tkr as a substring is not matched", () => {
  const out = injectSessionID("echo 'tkr' && tkr git status", "s");
  assert.strictEqual(out, "echo 'tkr' && tkr --session-id s git status");
});

test("unsafe session id is left unattached", () => {
  const dangerous = "s; rm -rf /";
  const out = injectSessionID("tkr grep foo", dangerous);
  assert.strictEqual(out, "tkr grep foo");
});

test("missing or empty session id is left unattached", () => {
  assert.strictEqual(injectSessionID("tkr grep foo", ""), "tkr grep foo");
  assert.strictEqual(injectSessionID("tkr grep foo", undefined), "tkr grep foo");
  assert.strictEqual(injectSessionID("tkr grep foo", null), "tkr grep foo");
});

test("empty or non-string rewritten command passes through untouched", () => {
  assert.strictEqual(injectSessionID("", "sid1"), "");
  assert.strictEqual(injectSessionID(undefined, "sid1"), undefined);
});

test("SAFE_SID rejects shell metacharacters and accepts uuid-shaped ids", () => {
  assert.ok(SAFE_SID.test("3f7b1e2a-9c4d-4b3a-8e1f-2d5c6a7b8e9f"));
  assert.ok(SAFE_SID.test("pid-1234"));
  assert.ok(!SAFE_SID.test("s; rm -rf /"));
  assert.ok(!SAFE_SID.test("s space"));
  assert.ok(!SAFE_SID.test("$(whoami)"));
});

// #584: injectIDs generalizes injectSessionID to also attach tool_use_id
// and prompt_id, independently of each other and of the session id.

test("injectIDs: all three ids attached in fixed order", () => {
  const out = injectIDs("tkr grep -n foo bar.go", {
    sid: "sid1",
    toolUseId: "toolu_012pUuAJ4A8Yq1vHj1aezfav",
    promptId: "prompt-1",
  });
  assert.strictEqual(
    out,
    "tkr --session-id sid1 --tool-use-id toolu_012pUuAJ4A8Yq1vHj1aezfav --prompt-id prompt-1 grep -n foo bar.go",
  );
});

test("injectIDs: each id is independent — a missing one doesn't block the others", () => {
  assert.strictEqual(
    injectIDs("tkr grep foo", { toolUseId: "toolu_1" }),
    "tkr --tool-use-id toolu_1 grep foo",
  );
  assert.strictEqual(
    injectIDs("tkr grep foo", { sid: "sid1", promptId: "prompt-1" }),
    "tkr --session-id sid1 --prompt-id prompt-1 grep foo",
  );
});

test("injectIDs: an unsafe id is left out while safe ones still attach", () => {
  const out = injectIDs("tkr grep foo", { sid: "sid1", toolUseId: "s; rm -rf /" });
  assert.strictEqual(out, "tkr --session-id sid1 grep foo");
});

test("injectIDs: no safe ids leaves the command unchanged", () => {
  assert.strictEqual(injectIDs("tkr grep foo", {}), "tkr grep foo");
  assert.strictEqual(injectIDs("tkr grep foo", undefined), "tkr grep foo");
});

test("injectIDs: compound command attaches to every tkr segment", () => {
  const out = injectIDs("tkr git status && tkr git diff", { toolUseId: "toolu_1" });
  assert.strictEqual(
    out,
    "tkr --tool-use-id toolu_1 git status && tkr --tool-use-id toolu_1 git diff",
  );
});

test("injectSessionID delegates to injectIDs (sid-only)", () => {
  assert.strictEqual(injectSessionID("tkr grep foo", "sid1"), "tkr --session-id sid1 grep foo");
});
