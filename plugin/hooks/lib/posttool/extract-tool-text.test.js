// Tests for extractToolText's payload-shape coverage.
//
// The load-bearing case is the BARE ARRAY: MCP tools hand PostToolUse
// `tool_response: [{type:"text",text}]`, not the `{content:[...]}` wrapper.
// Verified live against Claude Code 2.1.241 — see
// docs/reports/2026-08-23-mcp-response-compression-feasibility.md.
//
// Before that branch existed every mcp__* call extracted to null, so no
// filter could ever see MCP output even with the non-Bash gate lifted.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractToolText } = require("./bash-filter");

test("extractToolText reads a bare-array (live MCP) tool_response", () => {
  const got = extractToolText({
    tool_name: "mcp__probe__big_payload",
    tool_response: [{ type: "text", text: "payload" }],
  });

  assert.deepEqual(got, { field: "content", text: "payload", rootArray: true });
});

test("extractToolText joins multiple MCP content blocks", () => {
  const got = extractToolText({
    tool_response: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
  });

  assert.equal(got.text, "first\n\nsecond");
  assert.equal(got.rootArray, true);
});

test("extractToolText returns null for an array carrying no text blocks", () => {
  assert.equal(
    extractToolText({ tool_response: [{ type: "image", data: "..." }] }),
    null,
  );
  assert.equal(extractToolText({ tool_response: [] }), null);
});

test("extractToolText still handles the wrapped content-array shape", () => {
  const got = extractToolText({
    tool_response: { content: [{ type: "text", text: "hello" }] },
  });

  assert.deepEqual(got, { field: "content", text: "hello", asArray: true });
  assert.equal(got.rootArray, undefined);
});

test("extractToolText still handles stdout/output/content strings", () => {
  assert.deepEqual(extractToolText({ tool_response: { stdout: "a" } }), {
    field: "stdout",
    text: "a",
  });
  assert.deepEqual(extractToolText({ tool_response: { output: "b" } }), {
    field: "output",
    text: "b",
  });
  assert.deepEqual(extractToolText({ tool_response: { content: "c" } }), {
    field: "content",
    text: "c",
  });
});

test("extractToolText returns null for a shapeless response", () => {
  // ToolSearch's native shape — no text-bearing field at all.
  assert.equal(
    extractToolText({
      tool_name: "ToolSearch",
      tool_response: { matches: ["x"], query: "q", total_deferred_tools: 3 },
    }),
    null,
  );
  assert.equal(extractToolText({}), null);
});
