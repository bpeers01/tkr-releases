"use strict";

// What is left of the bundled-skill module after #664.
//
// This file used to hold the INV-095 gate policy and the bundle measurement —
// ~600 lines answering "how big is the tree behind skill X" and "given that
// size, what should the hook do". Its only hook consumer was
// hooks/skill-invoked.js, which is now the native `tkr hook skill-invoked`
// verb, so the policy moved with it: it lives in internal/skillbundle, and
// hooks/lib/skill-bundle.test.js's 45 tests were ported to Go before the JS
// was deleted rather than after.
//
// Keeping a second copy here would have re-created exactly the duplication
// hooks/CLAUDE.md's stability rules call out for the memory classifier: two
// implementations of one policy, with a standing obligation to change both in
// the same commit that nobody remembers on the sixth month.
//
// # Why the file survives at all
//
// hooks/lib/skill-scrape.js — the scraper that WRITES skill-manifest.json,
// ~1,100 lines of pattern-matching over the minified Claude Code binary, still
// JS and still spawned by sessionstart.SpawnSkillManifestRefresh — imports
// these two constants. They name the file the scraper writes and the schema it
// stamps, and the Go side that now READS that file mirrors them in
// internal/skillbundle/manifest.go.
//
// So the values exist in three places: here, in internal/skillbundle, and in
// sessionstart.SkillManifestFile / SkillManifestSchema (which the SessionStart
// staleness check consults before deciding to respawn the scraper). Nothing
// enforces the pairing automatically for the third, but the producer/consumer
// pair IS pinned: internal/skillbundle's TestJSScraperAndGoReaderAgree runs
// this scraper's own writeManifest through node and asserts the Go reader
// accepts what it produced, schema constant included.
//
// A mismatch fails in the safe direction regardless — an unrecognized schema
// reads as "no manifest", which degrades to the pre-#263 ungated first
// invocation rather than to a wrongly blocked skill.
//
// DELETE this file when hooks/lib/skill-scrape.js is ported or the gate is
// redesigned to need no scrape. Both are open; neither is scheduled.

const MANIFEST_FILE = "skill-manifest.json";
const MANIFEST_SCHEMA = 1;

module.exports = {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
};
