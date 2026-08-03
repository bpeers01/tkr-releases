// hooks/lib/state-dir.test.js — unit tests for stateDir resolver.
// Run with: node --test hooks/lib/state-dir.test.js

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { stateDir } = require("./state-dir");

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

test("TKR_STATE_DIR override wins", () => {
  withEnv({ TKR_STATE_DIR: "/custom/state" }, () => {
    assert.equal(stateDir(), "/custom/state");
  });
});

test("HOME fallback yields $HOME/.tkr", () => {
  withEnv({ TKR_STATE_DIR: null, HOME: "/home/u", USERPROFILE: null }, () => {
    assert.equal(stateDir(), path.join("/home/u", ".tkr"));
  });
});

test("USERPROFILE fallback yields %USERPROFILE%/.tkr on Windows", () => {
  withEnv({ TKR_STATE_DIR: null, HOME: null, USERPROFILE: "C:\\Users\\x" }, () => {
    assert.equal(stateDir(), path.join("C:\\Users\\x", ".tkr"));
  });
});
