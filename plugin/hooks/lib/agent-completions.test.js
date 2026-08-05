// Tests for hooks/lib/agent-completions.js (#134 R0.1).
//
// The schema cases assert the two properties the ledger exists for:
// exact join anchors, and absence-over-zero for every numeric a given
// Claude Code build might not supply (the R0.3 hard gate). The privacy
// cases assert that worker content is parsed and discarded, never
// stored — same discipline as subagent-outcomes.jsonl.
//
// Run: node --test hooks/lib/agent-completions.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildRow,
  recordAgentCompletion,
  SCHEMA_VERSION,
} = require("./agent-completions.js");

// A payload shaped like what current Claude Code records for a
// foreground (completed) Agent call — field names verified against
// live session transcripts, 2026-08-04.
function completedEvent(overrides) {
  return Object.assign(
    {
      session_id: "sid-1",
      prompt_id: "pid-1",
      tool_use_id: "toolu_01",
      tool_name: "Agent",
      tool_response: {
        status: "completed",
        agentId: "a6b3234fa669e5d3b",
        agentType: "general-purpose",
        prompt: "SECRET-PROMPT-TEXT",
        content: [{ type: "text", text: "worker final message" }],
        resolvedModel: "claude-sonnet-5",
        totalDurationMs: 880628,
        totalTokens: 103210,
        totalToolUseCount: 27,
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_creation_input_tokens: 33,
          cache_read_input_tokens: 44,
          service_tier: "standard",
        },
      },
    },
    overrides || {},
  );
}

test("a completed Agent response maps to a full row", () => {
  const row = buildRow(completedEvent());
  assert.strictEqual(row.event, "agent-completion");
  assert.strictEqual(row.schema_version, SCHEMA_VERSION);
  assert.strictEqual(row.session_id, "sid-1");
  assert.strictEqual(row.prompt_id, "pid-1");
  assert.strictEqual(row.tool_use_id, "toolu_01");
  assert.strictEqual(row.status, "completed");
  assert.strictEqual(row.agent_id, "a6b3234fa669e5d3b");
  assert.strictEqual(row.agent_type, "general-purpose");
  assert.strictEqual(row.resolved_model, "claude-sonnet-5");
  assert.strictEqual(row.total_duration_ms, 880628);
  assert.strictEqual(row.total_tokens, 103210);
  assert.strictEqual(row.total_tool_use_count, 27);
  assert.deepStrictEqual(row.usage, {
    input_tokens: 11,
    output_tokens: 22,
    cache_creation_input_tokens: 33,
    cache_read_input_tokens: 44,
  });
});

test("missing numerics are absent keys, never 0 (R0.3 hard gate)", () => {
  // The async-launch shape: no usage, no totals — a build/state that
  // did not report cost must be unmistakable from one that reported 0.
  const row = buildRow(
    completedEvent({
      tool_response: {
        status: "async_launched",
        agentId: "a55e8e16f6836eae5",
        isAsync: true,
        outputFile: "C:\\temp\\agent-output.txt",
      },
    }),
  );
  assert.strictEqual(row.status, "async_launched");
  assert.ok(!("total_tokens" in row), "total_tokens must be absent");
  assert.ok(!("total_duration_ms" in row), "total_duration_ms must be absent");
  assert.ok(!("total_tool_use_count" in row), "count must be absent");
  assert.ok(!("usage" in row), "usage must be absent");
});

test("non-finite, negative, and non-numeric totals are dropped", () => {
  const row = buildRow(
    completedEvent({
      tool_response: {
        status: "completed",
        totalTokens: -5,
        totalDurationMs: Infinity,
        totalToolUseCount: "27",
        usage: { input_tokens: NaN, output_tokens: -1 },
      },
    }),
  );
  assert.ok(!("total_tokens" in row));
  assert.ok(!("total_duration_ms" in row));
  assert.ok(!("total_tool_use_count" in row));
  assert.ok(!("usage" in row));
});

test("worker content and prompt are parsed, never stored", () => {
  const row = buildRow(completedEvent());
  const json = JSON.stringify(row);
  assert.ok(!json.includes("SECRET-PROMPT-TEXT"), "prompt leaked into row");
  assert.ok(!json.includes("worker final message"), "content leaked into row");
  assert.ok(!json.includes("outputFile"), "outputFile leaked into row");
});

test("a tkr-handoff trailer in the final text block becomes declared_*", () => {
  const row = buildRow(
    completedEvent({
      tool_response: {
        status: "completed",
        content: [
          { type: "text", text: "preamble" },
          {
            type: "text",
            text:
              "done.\n```tkr-handoff\noutcome: partial\ngaps: 2\nassumptions: 1\n```",
          },
        ],
      },
    }),
  );
  assert.strictEqual(row.declared_outcome, "partial");
  assert.strictEqual(row.declared_gaps, 2);
  assert.strictEqual(row.declared_assumptions, 1);
});

test("no handoff block leaves all declared_* keys absent", () => {
  const row = buildRow(completedEvent());
  assert.ok(!("declared_outcome" in row));
  assert.ok(!("declared_gaps" in row));
  assert.ok(!("declared_assumptions" in row));
});

test("string content is tolerated for the handoff parse", () => {
  const row = buildRow(
    completedEvent({
      tool_response: {
        status: "completed",
        content: "```tkr-handoff\noutcome: answered\n```",
      },
    }),
  );
  assert.strictEqual(row.declared_outcome, "answered");
});

test("non-Agent tools produce no row", () => {
  assert.strictEqual(buildRow(completedEvent({ tool_name: "Bash" })), null);
  assert.strictEqual(buildRow({}), null);
  assert.strictEqual(buildRow(null), null);
});

test("Task tool_name is accepted alongside Agent", () => {
  const row = buildRow(completedEvent({ tool_name: "Task" }));
  assert.strictEqual(row.tool_name, "Task");
});

test("oversized fields are clamped and models_used is capped", () => {
  const row = buildRow(
    completedEvent({
      tool_response: {
        status: "completed",
        agentId: "x".repeat(1000),
        modelsUsed: Array.from({ length: 20 }, (_, i) => `model-${i}`),
      },
    }),
  );
  assert.strictEqual(row.agent_id.length, 256);
  assert.strictEqual(row.models_used.length, 8);
});

test("models_used is absent when the payload has none", () => {
  const row = buildRow(completedEvent());
  assert.ok(!("models_used" in row));
});

function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-agent-completions-"));
  const ledger = path.join(dir, "agent-completions.jsonl");
  const saved = process.env.TKR_AGENT_COMPLETIONS_PATH;
  process.env.TKR_AGENT_COMPLETIONS_PATH = ledger;
  try {
    return fn(ledger);
  } finally {
    if (saved === undefined) delete process.env.TKR_AGENT_COMPLETIONS_PATH;
    else process.env.TKR_AGENT_COMPLETIONS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("recordAgentCompletion appends one parseable row", () => {
  withLedger((ledger) => {
    recordAgentCompletion(completedEvent());
    const lines = fs
      .readFileSync(ledger, "utf8")
      .split("\n")
      .filter(Boolean);
    assert.strictEqual(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.strictEqual(row.tool_use_id, "toolu_01");
  });
});

test("the kill switch suppresses the write", () => {
  withLedger((ledger) => {
    process.env.TKR_AGENT_COMPLETIONS_DISABLED = "1";
    try {
      recordAgentCompletion(completedEvent());
    } finally {
      delete process.env.TKR_AGENT_COMPLETIONS_DISABLED;
    }
    assert.ok(!fs.existsSync(ledger), "row written despite kill switch");
  });
});

test("recordAgentCompletion never throws on a hostile event", () => {
  withLedger(() => {
    recordAgentCompletion(undefined);
    recordAgentCompletion({ tool_name: "Agent", tool_response: 42 });
    recordAgentCompletion({
      tool_name: "Agent",
      tool_response: { content: [{ type: "text", text: null }] },
    });
  });
});
