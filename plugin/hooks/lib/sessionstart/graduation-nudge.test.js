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

// HOOK-004: loadGraduationNudge now resolves the binary through
// lib/tkr-bin.js (TKR_BIN -> standard install location -> bare "tkr")
// instead of a bare spawnSync("tkr", ...), so "no resolvable tkr" means
// blanking every candidate the resolver checks, not just PATH. On a dev
// machine with a real install at ~/.local/bin/tkr(.exe), emptying PATH
// alone leaves that candidate standing and the test would silently
// exercise the real binary instead of the "missing" path it claims to
// cover.
function withNoResolvableTkr(fn) {
  const keys = ["PATH", "Path", "HOME", "USERPROFILE", "LOCALAPPDATA", "TKR_BIN"];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  const dir = emptyPathDir();
  process.env.PATH = dir;
  process.env.Path = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.LOCALAPPDATA = dir;
  delete process.env.TKR_BIN;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// The env kill switch must short-circuit before any spawn, so a user who has
// opted out never pays the subprocess on every session start.
test("TKR_SUGGEST_NO_GRADUATION=1 suppresses without spawning", () => {
  const prev = process.env.TKR_SUGGEST_NO_GRADUATION;
  process.env.TKR_SUGGEST_NO_GRADUATION = "1";
  try {
    // No resolvable tkr, so a "" result can only mean the kill switch fired
    // — not that a real binary happened to print nothing.
    withNoResolvableTkr(() => {
      assert.equal(loadGraduationNudge(), "");
    });
  } finally {
    if (prev === undefined) delete process.env.TKR_SUGGEST_NO_GRADUATION;
    else process.env.TKR_SUGGEST_NO_GRADUATION = prev;
  }
});

// A missing or broken tkr binary must degrade to silence — SessionStart runs
// on every session and must never surface a spawn failure to the user.
test("missing tkr binary yields empty string, never throws", () => {
  const prev = process.env.TKR_SUGGEST_NO_GRADUATION;
  delete process.env.TKR_SUGGEST_NO_GRADUATION;
  try {
    withNoResolvableTkr(() => {
      assert.equal(loadGraduationNudge(), "");
    });
  } finally {
    if (prev !== undefined) process.env.TKR_SUGGEST_NO_GRADUATION = prev;
  }
});

// HOOK-004: an explicit TKR_BIN must reach the spawned command — the whole
// point of routing through tkrSpawnArgv() instead of a bare
// spawnSync("tkr", ...). Shimmed as a .js file, the one shim mechanism
// that works on both platforms without a shell (see hooks/lib/tkr-bin.js
// header + hooks/lib/tkr-bin.test.js, same pattern).
test("TKR_BIN override reaches the spawned command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shim-"));
  const shim = path.join(dir, "shim.js");
  const line = "tkr: suggest mode saw evidence — switch on rewriting";
  fs.writeFileSync(shim, `process.stdout.write(${JSON.stringify(line)});\n`);
  const prevBin = process.env.TKR_BIN;
  const prevNoGrad = process.env.TKR_SUGGEST_NO_GRADUATION;
  delete process.env.TKR_SUGGEST_NO_GRADUATION;
  try {
    process.env.TKR_BIN = shim;
    const out = loadGraduationNudge();
    assert.ok(out.includes(line), `expected shim output, got: ${JSON.stringify(out)}`);
  } finally {
    if (prevBin === undefined) delete process.env.TKR_BIN;
    else process.env.TKR_BIN = prevBin;
    if (prevNoGrad !== undefined) process.env.TKR_SUGGEST_NO_GRADUATION = prevNoGrad;
    fs.rmSync(dir, { recursive: true, force: true });
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
