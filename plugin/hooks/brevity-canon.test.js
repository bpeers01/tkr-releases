// BREV-002 drift guard: hooks/data/sessionstart/brevity-sections.json
// is the single source of truth for the per-level brevity rule text.
// The session-start injector (hooks/lib/sessionstart/brevity.js) reads
// it directly; skills/brevity/SKILL.md must quote each level's body
// verbatim (whitespace-normalized). Editing one copy without the other
// fails here.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SECTIONS_PATH = path.join(
  __dirname, "data", "sessionstart", "brevity-sections.json",
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
