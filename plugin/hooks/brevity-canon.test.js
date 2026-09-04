// BREV-002 drift guard: internal/hooks/sessionstart/data/brevity-sections.json
// is the single source of truth for the per-level brevity rule text.
// The session-start injector (internal/hooks/sessionstart/brevity.go)
// go:embed's it; skills/brevity/SKILL.md must quote each level's body
// verbatim (whitespace-normalized). Editing one copy without the other
// fails here.
//
// The path moved at the #664 Phase 4 cutover: the JS copy this guard used
// to read, hooks/data/sessionstart/brevity-sections.json, was deleted with
// the rest of the JS session-start tree. The guard itself still belongs in
// JS because the other side of the comparison is a markdown skill file, not
// Go.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SECTIONS_PATH = path.join(
  __dirname, "..", "internal", "hooks", "sessionstart", "data",
  "brevity-sections.json",
);
const SKILL_PATH = path.join(
  __dirname, "..", "skills", "brevity", "SKILL.md",
);

// Collapse all whitespace runs to single spaces so markdown wrapping
// differences don't count as drift — only wording does.
function squash(text) {
  return text.replace(/\s+/g, " ").trim();
}

test("brevity-sections.json has exactly the three known levels", () => {
  const sections = JSON.parse(fs.readFileSync(SECTIONS_PATH, "utf8"));
  assert.deepStrictEqual(Object.keys(sections).sort(), ["full", "lite", "ultra"]);
  for (const [level, body] of Object.entries(sections)) {
    assert.ok(body.trim().length > 0, `${level} body must be non-empty`);
  }
});

test("SKILL.md quotes each level's canonical body verbatim", () => {
  const sections = JSON.parse(fs.readFileSync(SECTIONS_PATH, "utf8"));
  const skill = squash(fs.readFileSync(SKILL_PATH, "utf8"));
  for (const [level, body] of Object.entries(sections)) {
    assert.ok(
      skill.includes(squash(body)),
      `skills/brevity/SKILL.md drifted from brevity-sections.json for level "${level}" — ` +
        "update the Intensity section to quote the JSON body verbatim (BREV-002)",
    );
  }
});
