#!/usr/bin/env node
// Manual-vs-auto skill attribution.
//
// The failure this guards is over-claiming: crediting an auto trigger as
// a manual invocation makes a skill look less useful than it is, and the
// reverse makes trigger accuracy look better than it is. Most of what
// follows is about the boundary between the two.
//
// Run: node --test hooks/lib/slash-marker.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MARKER_TTL_MS,
  parseSlashCommand,
  recordSlashCommand,
  resolveInvocationSource,
} = require("./slash-marker.js");

function withState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-slash-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test("parseSlashCommand reads a leading slash command", () => {
  assert.strictEqual(parseSlashCommand("/compress"), "compress");
  assert.strictEqual(parseSlashCommand("  /handoff  "), "handoff");
  assert.strictEqual(parseSlashCommand("/handoff prune"), "handoff");
});

test("parseSlashCommand normalizes a plugin-qualified name", () => {
  // The user types /tkr:compress; the Skill tool reports `compress`.
  assert.strictEqual(parseSlashCommand("/tkr:compress"), "compress");
});

test("parseSlashCommand ignores prose that merely mentions a command", () => {
  // "run /release when you're done" is talk about a command, not an
  // invocation. Treating it as manual would misattribute a genuine auto
  // trigger that happened to be discussed in the same turn.
  assert.strictEqual(parseSlashCommand("run /release when you're done"), "");
  assert.strictEqual(parseSlashCommand("what does /status show?"), "");
  assert.strictEqual(parseSlashCommand("summarize the changes"), "");
  assert.strictEqual(parseSlashCommand(""), "");
  assert.strictEqual(parseSlashCommand(undefined), "");
});

test("a slash command in the same turn resolves manual", () => {
  withState(() => {
    recordSlashCommand("/compress", "s1", "p1");
    assert.strictEqual(resolveInvocationSource("compress", "s1", "p1"), "manual");
  });
});

test("a different skill in the same turn is auto", () => {
  // The user typed /compress and a search skill also fired. Only the one
  // that was named is manual.
  withState(() => {
    recordSlashCommand("/compress", "s1", "p1");
    assert.strictEqual(resolveInvocationSource("search", "s1", "p1"), "auto");
  });
});

test("a later turn does not inherit an earlier marker", () => {
  // The load-bearing staleness case: a marker written two turns ago must
  // not make today's auto trigger look manual.
  withState(() => {
    recordSlashCommand("/compress", "s1", "p1");
    assert.strictEqual(resolveInvocationSource("compress", "s1", "p2"), "auto");
  });
});

test("with no prompt ids to match, an old marker expires", () => {
  // Claude Code may supply no prompt id. The TTL is the backstop, and it
  // is short because a slash command and its Skill dispatch are the same
  // turn milliseconds apart.
  withState(() => {
    recordSlashCommand("/compress", "s1", "");
    const now = Date.now();
    assert.strictEqual(resolveInvocationSource("compress", "s1", "", now), "manual");
    assert.strictEqual(
      resolveInvocationSource("compress", "s1", "", now + MARKER_TTL_MS + 1),
      "auto"
    );
  });
});

test("no marker at all means auto, not unknown", () => {
  // Most turns are not slash commands, so a missing file is the common
  // case and a real answer — keeping "unknown" here would hide a
  // measurement behind a hedge that no longer applies.
  withState(() => {
    assert.strictEqual(resolveInvocationSource("compress", "s1", "p1"), "auto");
  });
});

test("an ordinary prompt writes no marker file at all", () => {
  // This runs on every prompt. Non-slash turns must cost a regex and no
  // I/O whatsoever.
  withState((dir) => {
    recordSlashCommand("please summarize the diff", "s1", "p1");
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("slash-marker-"));
    assert.deepStrictEqual(files, []);
  });
});

test("a corrupt marker resolves auto rather than throwing", () => {
  withState((dir) => {
    fs.writeFileSync(path.join(dir, "slash-marker-s1.json"), "{not json");
    assert.strictEqual(resolveInvocationSource("compress", "s1", "p1"), "auto");
  });
});

test("a hostile session id cannot escape the state dir", () => {
  withState((dir) => {
    recordSlashCommand("/compress", "../../etc/passwd", "p1");
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("slash-marker-"));
    assert.deepStrictEqual(files, ["slash-marker-default.json"]);
  });
});

test("an unwritable state dir does not throw", () => {
  withState((dir) => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    process.env.TKR_STATE_DIR = path.join(blocker, "nested");
    assert.doesNotThrow(() => recordSlashCommand("/compress", "s1", "p1"));
  });
});
