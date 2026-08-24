// Tests for detectSessionIngestLabel's tool coverage.
//
// The mcp__ branch is the whole reason MCP output can be digested at all:
// session-ingest runs at post-tool-call.js:280, before the non-Bash gate at
// :309 returns early. See
// docs/reports/2026-08-23-mcp-response-compression-feasibility.md section 5.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectSessionIngestLabel,
  SESSION_INGEST_MIN_BYTES,
} = require("./session-ingest");

test("labels an MCP tool by its server name", () => {
  assert.equal(
    detectSessionIngestLabel({ tool_name: "mcp__team-hub__list_tasks" }, ""),
    "mcp-team-hub",
  );
  assert.equal(
    detectSessionIngestLabel({ tool_name: "mcp__plugin_blueprint_aiqa__scan" }, ""),
    "mcp-plugin-blueprint-aiqa",
  );
});

test("falls back to a bare mcp label when the server segment is empty", () => {
  assert.equal(detectSessionIngestLabel({ tool_name: "mcp__" }, ""), "mcp");
});

test("skips tkr's own search tool — indexing index results is circular", () => {
  assert.equal(
    detectSessionIngestLabel({ tool_name: "mcp__tkr__tkr_search" }, ""),
    null,
  );
  assert.equal(
    detectSessionIngestLabel({ tool_name: "mcp__plugin_tkr_tkr__tkr_search" }, ""),
    null,
  );
});

test("other tkr MCP tools are still eligible", () => {
  assert.equal(
    detectSessionIngestLabel({ tool_name: "mcp__tkr__tkr_read" }, ""),
    "mcp-tkr",
  );
});

test("existing WebFetch and Bash labels are unchanged", () => {
  assert.equal(detectSessionIngestLabel({ tool_name: "WebFetch" }, ""), "webfetch");
  assert.equal(
    detectSessionIngestLabel({ tool_name: "Bash" }, "grep -r foo ."),
    "bash-grep",
  );
  assert.equal(
    detectSessionIngestLabel({ tool_name: "Bash" }, "curl https://x"),
    "bash-curl",
  );
  assert.equal(
    detectSessionIngestLabel({ tool_name: "Bash" }, "tkr search foo"),
    null,
  );
  assert.equal(detectSessionIngestLabel({ tool_name: "Bash" }, "ls"), null);
});

test("non-MCP, non-Bash tools stay ineligible", () => {
  assert.equal(detectSessionIngestLabel({ tool_name: "Read" }, ""), null);
  assert.equal(detectSessionIngestLabel({}, ""), null);
});

test("the 8KB floor is what gated the oversized MCP calls in the corpus", () => {
  assert.equal(SESSION_INGEST_MIN_BYTES, 8 * 1024);
});
