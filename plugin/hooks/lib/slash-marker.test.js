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
  parseCommandTag,
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

// #278: a real skill-backed slash command's expanded prompt does not
// start with a bare "/" — it carries CC's <command-name> scaffold
// somewhere inside caveat/preamble text. These cover that shape.
test("parseCommandTag reads the tag regardless of what precedes it", () => {
  assert.strictEqual(
    parseCommandTag("<local-command-caveat>...</local-command-caveat>\n<command-name>/handoff</command-name>\n<command-message>handoff</command-message>"),
    "handoff"
  );
  assert.strictEqual(parseCommandTag("<command-name>/compress</command-name>"), "compress");
});

test("parseCommandTag normalizes a plugin-qualified tag", () => {
  assert.strictEqual(parseCommandTag("<command-name>/tkr:continue</command-name>"), "continue");
});

test("parseCommandTag accepts the tag with no leading slash", () => {
  assert.strictEqual(parseCommandTag("<command-name>compress</command-name>"), "compress");
});

test("parseCommandTag returns empty with no tag present", () => {
  assert.strictEqual(parseCommandTag("/compress"), "");
  assert.strictEqual(parseCommandTag("just talking about /compress"), "");
  assert.strictEqual(parseCommandTag(""), "");
  assert.strictEqual(parseCommandTag(undefined), "");
});

test("parseSlashCommand prefers the tag over a bare leading slash", () => {
  // Real expanded prompt: starts with scaffold, not "/", and disagrees
  // with what a naive leading-slash reading of the same text would find.
  assert.strictEqual(
    parseSlashCommand("<command-name>/tkr:continue</command-name>\n<command-args>foo.md</command-args>"),
    "continue"
  );
});

test("parseSlashCommand still falls back to a bare leading slash", () => {
  // No scaffold present — the pre-#278 behavior is preserved.
  assert.strictEqual(parseSlashCommand("/compress"), "compress");
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
