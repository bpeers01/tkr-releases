#!/usr/bin/env node
// Tests for isSubagentContext (hooks/lib/subagent-context.js) — the single
// shared predicate for "does this hook invocation come from inside a
// subagent?" INV-074 residue audit (2026-08-22): a previous field-audit
// lead claimed roughly four call sites hand-rolled this check inline
// instead of calling the helper; this file pins the predicate's own
// contract so that lead's fix (routing those sites through here) cannot
// silently regress, and so the SPAWN TARGET distinction — the thing that
// makes this helper easy to get wrong — has a permanent, direct test.
//
// Run: node --test hooks/lib/subagent-context.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { isSubagentContext } = require("./subagent-context");

test("agent_id alone is sufficient (documented marker)", () => {
  assert.strictEqual(isSubagentContext({ agent_id: "a6b3234f" }), true);
});

test("agent_type alone is sufficient (documented marker)", () => {
  assert.strictEqual(isSubagentContext({ agent_type: "Explore" }), true);
});

test("scope === 'subagent' is sufficient (undocumented mirror)", () => {
  assert.strictEqual(isSubagentContext({ scope: "subagent" }), true);
});

test("a non-empty top-level subagent_type is sufficient (undocumented mirror)", () => {
  assert.strictEqual(isSubagentContext({ subagent_type: "tkr:explore-haiku" }), true);
});

test("an empty top-level subagent_type is not a marker", () => {
  assert.strictEqual(isSubagentContext({ subagent_type: "" }), false);
});

// The load-bearing distinction: tool_input.subagent_type is the SPAWN
// TARGET — what a coordinator is dispatching, i.e. main-session traffic —
// and must NEVER be read by this predicate. A refactor that hoists this
// check to also accept `event.tool_input.subagent_type` would misclassify
// every coordinator spawn as subagent traffic.
test("tool_input.subagent_type (the SPAWN TARGET) is never consulted", () => {
  assert.strictEqual(
    isSubagentContext({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore" },
    }),
    false,
  );
});

// Neither marker present → inert. Per the module header, this must never
// be read as "definitely the main session" — it is a "no evidence either
// way" result, and callers must keep whatever protection they had
// underneath rather than treat this as a safe default on its own.
test("no marker present → false (inert, caller's underlying protection applies)", () => {
  assert.strictEqual(isSubagentContext({}), false);
  assert.strictEqual(isSubagentContext(null), false);
  assert.strictEqual(isSubagentContext(undefined), false);
});
