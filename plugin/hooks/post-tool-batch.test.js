// Tests for hooks/post-tool-batch.js (#134 R0.2).
//
// The classification cases pin the enum; the shape cases pin the R0.3
// rule that an unreadable payload is recorded as "unavailable" rather
// than classified; the stdin cases drive the hook as a process the way
// Claude Code would.
//
// Run: node --test hooks/post-tool-batch.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildRow, classify, toolNamesFrom } = require("./post-tool-batch.js");

const HOOK = path.join(__dirname, "post-tool-batch.js");

function batchEvent(toolNames, overrides) {
  return Object.assign(
    {
      hook_event_name: "PostToolBatch",
      session_id: "sid-1",
      prompt_id: "pid-1",
      tool_calls: toolNames.map((n, i) => ({
        tool_use_id: `toolu_${i}`,
        tool_name: n,
        tool_input: {},
      })),
    },
    overrides || {},
  );
}

test("all-Agent batch classifies agent_first", () => {
  assert.strictEqual(classify(["Agent"]), "agent_first");
  assert.strictEqual(classify(["Agent", "Task"]), "agent_first");
});

test("read/search-only batch classifies direct_read_search_first", () => {
  assert.strictEqual(classify(["Read", "Grep"]), "direct_read_search_first");
  assert.strictEqual(
    classify(["mcp__tkr__tkr_search", "Glob"]),
    "direct_read_search_first",
  );
});

test("agent + non-agent classifies mixed_parallel_batch", () => {
  assert.strictEqual(classify(["Agent", "Read"]), "mixed_parallel_batch");
  assert.strictEqual(classify(["Bash", "Task"]), "mixed_parallel_batch");
});

test("anything else classifies other", () => {
  assert.strictEqual(classify(["Bash"]), "other");
  assert.strictEqual(classify(["Edit", "Read"]), "other");
  assert.strictEqual(classify([]), "other");
});

test("an unreadable payload is unavailable, never classified", () => {
  assert.strictEqual(classify(null), "unavailable");
  const row = buildRow({
    hook_event_name: "PostToolBatch",
    session_id: "sid-1",
    prompt_id: "pid-1",
    // no tool_calls / tool_uses / toolUses at all
  });
  assert.strictEqual(row.first_action, "unavailable");
  assert.strictEqual(row.payload_shape, "unavailable");
  assert.deepStrictEqual(row.tool_names, []);
});

test("legacy/SDK namings (tool_uses, toolUses) are tolerated", () => {
  assert.deepStrictEqual(
    toolNamesFrom({ tool_uses: [{ tool_use_id: "t1", tool_name: "Agent" }] }),
    ["Agent"],
  );
  assert.deepStrictEqual(
    toolNamesFrom({ toolUses: [{ toolUseId: "t1", toolName: "Agent" }] }),
    ["Agent"],
  );
});

test("errored entries are excluded from classification", () => {
  const names = toolNamesFrom({
    tool_calls: [
      { tool_name: "Agent", tool_response: { is_error: true } },
      { tool_name: "Read" },
    ],
  });
  assert.deepStrictEqual(names, ["Read"]);
});

test("a misrouted event produces no row", () => {
  assert.strictEqual(
    buildRow({ hook_event_name: "PostToolUse", tool_calls: [] }),
    null,
  );
});

test("row carries join anchors and batch size", () => {
  const row = buildRow(batchEvent(["Agent", "Read"]));
  assert.strictEqual(row.event, "first-batch");
  assert.strictEqual(row.session_id, "sid-1");
  assert.strictEqual(row.prompt_id, "pid-1");
  assert.strictEqual(row.batch_size, 2);
  assert.strictEqual(row.first_action, "mixed_parallel_batch");
  assert.strictEqual(row.payload_shape, "tool_calls");
});

// ── Process-level: synthetic stdin, temp state dir ──────────────────

function runHook(input, env) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    env: Object.assign({}, process.env, env),
    encoding: "utf8",
    timeout: 10000,
  });
}

function withStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-first-batch-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readRows(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, "first-batch.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("first batch of a prompt is recorded once; later batches skipped", () => {
  withStateDir((dir) => {
    const env = { TKR_STATE_DIR: dir };
    let res = runHook(batchEvent(["Agent"]), env);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, "{}");
    res = runHook(batchEvent(["Read", "Grep"]), env); // same prompt_id
    assert.strictEqual(res.status, 0);

    const rows = readRows(dir);
    assert.strictEqual(rows.length, 1, "second batch on one prompt must be skipped");
    assert.strictEqual(rows[0].first_action, "agent_first");
  });
});

test("a new prompt gets its own row", () => {
  withStateDir((dir) => {
    const env = { TKR_STATE_DIR: dir };
    runHook(batchEvent(["Agent"]), env);
    runHook(batchEvent(["Read"], { prompt_id: "pid-2" }), env);
    const rows = readRows(dir);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].prompt_id, "pid-2");
    assert.strictEqual(rows[1].first_action, "direct_read_search_first");
  });
});

test("kill switches suppress the write and still answer {}", () => {
  withStateDir((dir) => {
    for (const env of [
      { TKR_STATE_DIR: dir, TKR_FIRST_BATCH_DISABLED: "1" },
      { TKR_STATE_DIR: dir, TKR_HOOKS_DISABLED: "1" },
    ]) {
      const res = runHook(batchEvent(["Agent"]), env);
      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.stdout, "{}");
    }
    assert.strictEqual(readRows(dir).length, 0);
  });
});

test("malformed stdin answers {} and writes nothing", () => {
  withStateDir((dir) => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "not json",
      env: Object.assign({}, process.env, { TKR_STATE_DIR: dir }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, "{}");
    assert.strictEqual(readRows(dir).length, 0);
  });
});
