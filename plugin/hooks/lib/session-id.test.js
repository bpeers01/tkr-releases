// hooks/lib/session-id.test.js — unit tests for getSessionID.
// Run with: node --test hooks/lib/session-id.test.js

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { getSessionID } = require("./session-id");

const UUID = "0123abcd-4567-89ef-0123-456789abcdef";

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === null) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("transcript_path UUID wins over session_id", () => {
  const event = {
    transcript_path: `/tmp/projects/foo/${UUID}.jsonl`,
    session_id: "other-id",
  };
  assert.equal(getSessionID(event), UUID);
});

test("backslash-style transcript_path matches too", () => {
  const event = { transcript_path: `C:\\Users\\x\\${UUID}.jsonl` };
  assert.equal(getSessionID(event), UUID);
});

test("session_id used when transcript_path absent", () => {
  withEnv({ TKR_SESSION_ID: null, CLAUDE_SESSION_ID: null }, () => {
    assert.equal(getSessionID({ session_id: "sid-1" }), "sid-1");
  });
});

test("camelCase sessionId accepted", () => {
  withEnv({ TKR_SESSION_ID: null, CLAUDE_SESSION_ID: null }, () => {
    assert.equal(getSessionID({ sessionId: "camel" }), "camel");
  });
});

test("TKR_SESSION_ID env used when payload empty", () => {
  withEnv({ TKR_SESSION_ID: "env-tkr", CLAUDE_SESSION_ID: null }, () => {
    assert.equal(getSessionID({}), "env-tkr");
  });
});

test("CLAUDE_SESSION_ID env honored when TKR_SESSION_ID absent", () => {
  withEnv({ TKR_SESSION_ID: null, CLAUDE_SESSION_ID: "claude-env" }, () => {
    assert.equal(getSessionID({}), "claude-env");
  });
});

test("pid-ppid fallback when nothing else is set", () => {
  withEnv({ TKR_SESSION_ID: null, CLAUDE_SESSION_ID: null }, () => {
    assert.equal(getSessionID({}), `pid-${process.ppid}`);
    assert.equal(getSessionID(null), `pid-${process.ppid}`);
    assert.equal(getSessionID(undefined), `pid-${process.ppid}`);
  });
});

test("non-UUID transcript_path falls through to session_id", () => {
  withEnv({ TKR_SESSION_ID: null, CLAUDE_SESSION_ID: null }, () => {
    const event = { transcript_path: "/tmp/not-a-uuid.jsonl", session_id: "sid" };
    assert.equal(getSessionID(event), "sid");
  });
});
