"use strict";

// The skill-invoked ledger has two writers in two languages, and this pins
// them together.
//
// Since #664 the AUTO writer is Go — internal/hooks/skillinvoked.go, dispatched
// as `tkr hook skill-invoked` on PreToolUse(Skill). The MANUAL writer is still
// JS: hooks/user-prompt-submit.js's recordManualSkillInvocation, which fires on
// the turn a typed slash command is observed, because PreToolUse(Skill)
// structurally never fires for that case (#205 dogfood, #278).
//
// Both append `event: "skill-invoked"` rows to instructions-load.jsonl, and
// every reader (scripts/ctx-audit.py, cmd/tkr/cmd_playbook_roi.go) treats them
// as one population distinguished only by invocation_source. So the two
// writers' schema_version must be the same number. Before the port they shared
// one constant through a require(); across a language boundary they cannot, so
// the pairing is asserted here instead of assumed.
//
// Same shape as the INTERACTIVE_TOOLS parity test in
// lib/keepalive-interactive-answer.test.js, which reads the Python tuple
// directly rather than restating it: a one-sided edit fails.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

test("skill-invoked schema_version agrees across the Go and JS writers", () => {
  const goSrc = fs.readFileSync(
    path.join(REPO, "internal", "hooks", "skillinvoked.go"),
    "utf8"
  );
  const goMatch = /skillInvokedSchemaVersion\s*=\s*(\d+)/.exec(goSrc);
  assert.ok(
    goMatch,
    "internal/hooks/skillinvoked.go must declare skillInvokedSchemaVersion = <n>"
  );

  const jsSrc = fs.readFileSync(
    path.join(REPO, "hooks", "user-prompt-submit.js"),
    "utf8"
  );
  const jsMatch = /SKILL_INVOKED_SCHEMA_VERSION\s*=\s*(\d+)/.exec(jsSrc);
  assert.ok(
    jsMatch,
    "hooks/user-prompt-submit.js must declare SKILL_INVOKED_SCHEMA_VERSION = <n>"
  );

  assert.strictEqual(
    jsMatch[1],
    goMatch[1],
    "the manual (JS) and auto (Go) skill-invoked writers disagree on " +
      "schema_version — bump both, or a reader cannot tell which fields a row " +
      "was allowed to carry"
  );
});

test("the manual writer no longer requires the deleted JS hook", () => {
  const jsSrc = fs.readFileSync(
    path.join(REPO, "hooks", "user-prompt-submit.js"),
    "utf8"
  );
  assert.ok(
    !/require\(["'][^"']*skill-invoked(\.js)?["']\)/.test(jsSrc),
    "hooks/skill-invoked.js is gone (ported to `tkr hook skill-invoked`); " +
      "a require() of it would throw MODULE_NOT_FOUND on every prompt"
  );
});
