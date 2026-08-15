const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkExplorationPattern } = require("./explore-nudge");
const { makeResponse } = require("./response");

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-response-test-"));
  const previous = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("makeResponse uses Claude Code's shape-preserving replacement field", () => {
  const event = {
    tool_response: {
      type: "text",
      content: [{ type: "text", text: "original" }],
      metadata: { preserved: true },
    },
  };

  const response = makeResponse(
    event,
    { field: "content", asArray: true },
    "replacement",
    "context",
  );

  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: {
        type: "text",
        content: [{ type: "text", text: "replacement" }],
        metadata: { preserved: true },
      },
      additionalContext: "context",
    },
  });
  assert.ok(
    !Object.hasOwn(response.hookSpecificOutput, "updatedToolResponse"),
  );
});

test("exploration nudge uses the same PostToolUse replacement contract", () => {
  withTempStateDir(() => {
    const event = {
      tool_name: "Read",
      tool_input: {},
      tool_response: { type: "text", output: "original" },
    };

    assert.equal(checkExplorationPattern(event), null);
    assert.equal(checkExplorationPattern(event), null);
    const response = checkExplorationPattern(event);

    assert.equal(response.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(
      response.hookSpecificOutput.updatedToolOutput.output,
      /^original[\s\S]+tkr search/,
    );
    assert.ok(
      !Object.hasOwn(response.hookSpecificOutput, "updatedToolResponse"),
    );
  });
});
