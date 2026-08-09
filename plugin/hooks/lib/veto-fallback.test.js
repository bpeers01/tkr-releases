#!/usr/bin/env node
// hooks/lib/veto-fallback.test.js — #143 finding 1.
//
// These run on EVERY platform, which is the point. The veto tests in
// hooks/agent-search-inject.test.js observe behavior through a `tkr` shim
// that is an extensionless #!/bin/sh file, so they are skipped wholesale
// on Windows — and the fail-open regression they were meant to catch
// shipped from a Windows box. Putting the decision itself in a plain
// module makes it directly assertable with no shim, no PATH games, and no
// platform gate.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const veto = require("./veto-fallback");

function withStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-veto-mode-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
}

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

// ── budget ───────────────────────────────────────────────────────────

test("vetoTimeoutMs: default is the measured budget, not the old 500ms", (t) => {
  withEnv(t, "TKR_VETO_TIMEOUT_MS", undefined);
  assert.strictEqual(veto.vetoTimeoutMs(), veto.VETO_TIMEOUT_MS);
  assert.ok(
    veto.VETO_TIMEOUT_MS >= 2000,
    "a fail-closed branch behind a tight budget turns host load into false denials",
  );
});

test("vetoTimeoutMs: override applies; garbage and non-positive fall back", (t) => {
  withEnv(t, "TKR_VETO_TIMEOUT_MS", "25");
  assert.strictEqual(veto.vetoTimeoutMs(), 25);
  for (const bad of ["", "abc", "0", "-1", "NaN"]) {
    process.env.TKR_VETO_TIMEOUT_MS = bad;
    assert.strictEqual(
      veto.vetoTimeoutMs(),
      veto.VETO_TIMEOUT_MS,
      `${JSON.stringify(bad)} must fall back, never disable the check`,
    );
  }
});

// ── profile scope ────────────────────────────────────────────────────

test("profileForbidsEdits: read-only profiles only; unknown reads as not read-only", () => {
  for (const p of ["tkr:explore-haiku", "tkr:isolate-research", "tkr:research-sonnet"]) {
    assert.strictEqual(veto.profileForbidsEdits(p), true, p);
  }
  for (const p of [
    "tkr:implement-sonnet",
    "tkr:debug-sonnet",
    "tkr:sweep-sonnet",
    "tkr:isolate-implement",
    "tkr:not-a-profile",
    "general-purpose",
    "",
    undefined,
  ]) {
    assert.strictEqual(
      veto.profileForbidsEdits(p),
      false,
      `${p} must not acquire a denial nobody wrote`,
    );
  }
});

// ── mutation intent ──────────────────────────────────────────────────

test("mutationIntent: recognizes unambiguous change requests", () => {
  for (const p of [
    "Edit internal/foo.go and rename X to Y",
    "implement the retry budget",
    "Please commit and push the fix",
    "MIGRATE the schema",
    "refactor this module",
    "wipe the cache directory",
  ]) {
    assert.strictEqual(veto.mutationIntent(p), true, p);
  }
});

test("mutationIntent: read-only contracts stay allowed", () => {
  for (const p of [
    "Find where the veto verdict is parsed.",
    "Which packages have no test files?",
    "Summarize the architecture doc.",
    "",
    undefined,
  ]) {
    assert.strictEqual(veto.mutationIntent(p), false, String(p));
  }
});

test("mutationIntent: negated verbs do not count (INV-088)", () => {
  // The advise rubric tells coordinators to state constraints explicitly,
  // so this shape is common in exactly the best-written spawn contracts.
  for (const p of [
    "Locate the caller. Do not edit anything.",
    "Read only — don't modify any file.",
    "Report findings without editing or writing files",
    "no need to implement it",
  ]) {
    assert.strictEqual(veto.mutationIntent(p), false, p);
  }
  // But a negator does not bind across a clause, and one un-negated verb
  // is still a change signal.
  assert.strictEqual(
    veto.mutationIntent("Do not guess. Edit the config to match."),
    true,
  );
});

test("mutationIntent: matches whole tokens, never substrings", () => {
  for (const p of ["credit the source", "editorial review", "removals list", "pushback"]) {
    assert.strictEqual(veto.mutationIntent(p), false, p);
  }
});

test("mutationIntent: ambiguous verbs are deliberately NOT recognized", () => {
  // These are in route.Mutating's vocabulary and omitted here on purpose
  // (module header): they saturate read-only spawn contracts, and this
  // detector only decides who loses the benefit of the doubt while tkr is
  // unreachable. Missing them is the pre-#143 behavior, not a regression;
  // acting on them would be a false denial on a busy host.
  for (const p of [
    "run the test suite and report failures",
    "check the set of open issues",
    "apply your judgment and add context",
  ]) {
    assert.strictEqual(veto.mutationIntent(p), false, p);
  }
});

// ── mode cache ───────────────────────────────────────────────────────

test("lastKnownMode: absent, stale, and malformed all read as no evidence", (t) => {
  withStateDir(t);
  assert.strictEqual(veto.lastKnownMode(), "", "no cache yet");

  veto.rememberMode("advisory");
  assert.strictEqual(veto.lastKnownMode(), "advisory");

  const p = veto.modeCachePath();
  const old = (Date.now() - veto.MODE_CACHE_MAX_AGE_MS - 60_000) / 1000;
  fs.utimesSync(p, old, old);
  assert.strictEqual(veto.lastKnownMode(), "", "stale cache must not enforce");

  fs.writeFileSync(p, "{not json");
  assert.strictEqual(veto.lastKnownMode(), "", "unreadable cache must not enforce");
});

test("rememberMode: an empty mode is not cached as a mode", (t) => {
  withStateDir(t);
  veto.rememberMode("");
  veto.rememberMode(undefined);
  assert.strictEqual(veto.lastKnownMode(), "");
});

// ── the decision ─────────────────────────────────────────────────────

const SPAWN = {
  subagentType: "tkr:explore-haiku",
  model: "",
  prompt: "Edit internal/foo.go and rename X to Y",
};

test("timeoutVerdict: denies only the mutation-to-read-only class", (t) => {
  withStateDir(t);
  veto.rememberMode("advisory");

  const v = veto.timeoutVerdict(SPAWN);
  assert.ok(v, "the one class whose fail-open cost is unrecoverable");
  assert.strictEqual(v.verdict, "deny");
  assert.strictEqual(v.enforce, true);
  assert.strictEqual(v.evaluated, false, "policy never looked");
  assert.strictEqual(v.local, true, "decided here, so the ledger must not claim a check ran");
  assert.strictEqual(v.timeout, true);
  assert.strictEqual(v.reason, "veto_check_timeout");
  assert.match(v.detail, /TKR_WORK_VETO_DISABLED/, "a blocked user needs the way out");
});

// assertFailOpen — the out-of-class answer. Allow, but still marked as a
// timeout: the ledger has to be able to count timeouts that allowed,
// which is the signal whose absence let #143 sit through a release.
function assertFailOpen(v, why) {
  assert.ok(v, `${why}: a fail-open timeout must still produce a row-visible verdict`);
  assert.strictEqual(v.verdict, "allow", why);
  assert.strictEqual(v.enforce, false, why);
  assert.strictEqual(v.timeout, true, `${why}: the timeout must remain visible`);
  assert.strictEqual(v.local, true, why);
}

test("timeoutVerdict: each condition alone is enough to fail open", (t) => {
  withStateDir(t);
  veto.rememberMode("advisory");

  assertFailOpen(
    veto.timeoutVerdict({ ...SPAWN, subagentType: "tkr:implement-sonnet" }),
    "a mutating profile handed a mutating task is not a violation",
  );
  assertFailOpen(
    veto.timeoutVerdict({ ...SPAWN, prompt: "Find where the verdict is parsed." }),
    "no mutation intent, nothing to protect",
  );
  assertFailOpen(
    veto.timeoutVerdict({ subagentType: "tkr:explore-haiku" }),
    "an absent prompt is not mutation intent",
  );
});

test("timeoutVerdict: non-enforcing and unknown modes never deny", (t) => {
  withStateDir(t);
  for (const mode of ["observe", "off", "nonsense"]) {
    veto.rememberMode(mode);
    assertFailOpen(
      veto.timeoutVerdict(SPAWN),
      `${mode} computes nothing a hook may act on`,
    );
  }
  for (const mode of ["advisory", "assisted", "managed"]) {
    veto.rememberMode(mode);
    assert.strictEqual(veto.timeoutVerdict(SPAWN).verdict, "deny", `${mode} enforces`);
  }
});

test("timeoutVerdict: a fresh install with no cached mode fails open", (t) => {
  withStateDir(t);
  assertFailOpen(
    veto.timeoutVerdict(SPAWN),
    "nothing has established that this user runs an enforcing mode",
  );
});
