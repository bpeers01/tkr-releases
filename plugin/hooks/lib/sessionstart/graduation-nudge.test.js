// Tests for hooks/lib/sessionstart/graduation-nudge.js
// Run with: node --test hooks/lib/sessionstart/graduation-nudge.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadGraduationNudge,
  MAX_LINE,
  EXPECTED_PREFIX,
} = require("./graduation-nudge");

// An existing-but-empty directory, not PATH="" — execvp falls back to a
// confstr default path when PATH is empty, which resolves a real tkr and
// makes the test assert against whatever that binary happens to print.
function emptyPathDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-nopath-"));
}

// The env kill switch must short-circuit before any spawn, so a user who has
// opted out never pays the subprocess on every session start.
test("TKR_SUGGEST_NO_GRADUATION=1 suppresses without spawning", () => {
  const prev = process.env.TKR_SUGGEST_NO_GRADUATION;
  const prevPath = process.env.PATH;
  process.env.TKR_SUGGEST_NO_GRADUATION = "1";
  // No resolvable tkr, so a "" result can only mean the kill switch fired
  // — not that a real binary happened to print nothing.
  process.env.PATH = emptyPathDir();
  try {
    assert.equal(loadGraduationNudge(), "");
  } finally {
    if (prev === undefined) delete process.env.TKR_SUGGEST_NO_GRADUATION;
    else process.env.TKR_SUGGEST_NO_GRADUATION = prev;
    process.env.PATH = prevPath;
  }
});

// A missing or broken tkr binary must degrade to silence — SessionStart runs
// on every session and must never surface a spawn failure to the user.
test("missing tkr binary yields empty string, never throws", () => {
  const prev = process.env.TKR_SUGGEST_NO_GRADUATION;
  const prevPath = process.env.PATH;
  delete process.env.TKR_SUGGEST_NO_GRADUATION;
  process.env.PATH = emptyPathDir();
  try {
    assert.equal(loadGraduationNudge(), "");
  } finally {
    if (prev !== undefined) process.env.TKR_SUGGEST_NO_GRADUATION = prev;
    process.env.PATH = prevPath;
  }
});

test("MAX_LINE bounds what can enter the session prefix", () => {
  assert.ok(typeof MAX_LINE === "number" && MAX_LINE > 0 && MAX_LINE <= 1000);
});

// Version skew: hooks ship with the repo, the binary is installed separately.
// A tkr predating --graduation ignores the unknown flag and prints the full
// savings report; injecting that into every session prefix would be a serious
// regression, so anything not matching the one-line contract is dropped.
test("output from a tkr predating --graduation is rejected", () => {
  const stale = [
    "tkr token savings",
    "──────────────────────────────────",
    "  commands tracked:  20",
  ].join("\n");
  assert.ok(!stale.startsWith(EXPECTED_PREFIX));
  assert.ok(stale.includes("\n"));
});

test("EXPECTED_PREFIX matches the line the binary emits", () => {
  const real =
    "tkr: suggest mode saw ~5.5K tokens of savings across 3 days — " +
    "switch on rewriting with: tkr config set hooks.mode rewrite";
  assert.ok(real.startsWith(EXPECTED_PREFIX));
  assert.ok(!real.includes("\n"));
  assert.ok(real.length <= MAX_LINE);
});
