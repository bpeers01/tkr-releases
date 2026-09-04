// hooks/lib/veto-fallback.js
//
// Issue #143 finding 1 — what PreToolUse(Agent) does when
// `tkr route veto-check` does not answer in time.
//
// This is the SECOND half of finding 1. The first half shipped in
// e38cc59: the veto path stopped failing open silently and began naming
// why an attempted check produced no verdict, as `veto_unavailable`
// (timeout | unreachable | bad_response) in task-spawns.jsonl. That
// commit deliberately left the 500ms default alone, on the grounds that
// the right value "cannot be picked from a Linux box" and had to wait on
// timeout counts measured on the platform with the problem. This module
// is that measurement, applied.
//
// Fail-open stays correct for every failure meaning the check COULD NOT
// RUN — no binary, nonzero exit, unparseable JSON. tkr is not installed
// or not working, and a spawn must not depend on one that isn't. It is
// wrong only for "the check ran and was cut off" at a budget so tight a
// busy host tripped it routinely: measured live, 3 of 5 checks exceeded
// the old 500ms, so the guard was absent exactly when the machine was
// under load.
//
// This module holds the two parts of that fix which are pure enough to
// test directly on every platform: the measured budget, and the narrow
// class of spawns for which a timeout denies rather than allows.
//
// SCOPE OF THE FAIL-CLOSED PATH. A timeout denies only when all three
// hold:
//
//   1. the target profile withholds Edit/Write (READONLY_PROFILES), and
//   2. the task text carries mutation intent (mutationIntent), and
//   3. a previous successful check in this environment reported an
//      enforcing work mode (lastKnownMode).
//
// That is the one deny route.VetoCheck takes whose fail-open cost is not
// recoverable: a read-only worker handed a mutating task does not fail
// loudly — the change either never happens, or lands unreviewed through
// the Bash tool those profiles still carry (INV-087). Every other deny
// route stays fail-open on timeout on purpose. cost_ceiling_exceeded
// costs money on one spawn and is visible in the ledger; unknown_profile
// is a naming error Claude Code surfaces on its own. Blocking legitimate
// spawns because a Windows host was busy is the larger harm, and it is
// the harm the narrow scope exists to avoid.
//
// NOT A PORT OF route.Mutating(). mutationIntent below is deliberately a
// small, independent, high-confidence SUBSET of internal/route/intent.go's
// vocabulary, and it carries no obligation to track that file — unlike the
// former memory-health.js, which had to move in lockstep with its Go twin
// until #664 deleted it. The
// asymmetry is structural: this function never produces a verdict. It
// only decides which spawns lose the benefit of the doubt in the seconds
// when tkr is unreachable, so the two possible divergences are bounded
// and both are survivable —
//
//   JS sees mutation, Go would not  → one spawn blocked while tkr hangs
//   JS misses mutation, Go would not → fail open, i.e. today's behavior
//
// The subset is chosen to keep the first case near zero: Go's list
// includes "run", "set", "apply", "check" and other words that appear
// constantly in read-only spawn contracts. Recognizing fewer words means
// missing some real mutations, which is the status quo, not a regression.
//
// READONLY_PROFILES is the one thing here that IS a copy of a Go fact
// (internal/route/profiles.go, ForbidsEdits) and it is kept honest by a
// test on the Go side that reads this file — see
// internal/route/veto_fallback_sync_test.go. Three entries, changing only
// when a profile is added, is a far smaller sync surface than a verb list
// with negation handling.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// VETO_TIMEOUT_MS — the spawnSync budget for `tkr route veto-check`.
//
// Derived from measurement, not chosen as a round number (#143). Timings
// on a Ryzen 9 7950X / Windows dev box, 2026-08-07, taken through the
// hook's exact spawnSync options:
//
//   idle                          n=75  p50 47ms   max  56ms
//   8 concurrent checks           n=80  p50 56ms   max  90ms
//   under a full `go test ./...`  n=120 p50 101ms  max 168ms
//   cold binary (fresh copy, so
//     no page cache and no AV
//     verdict cache)              n=5   106-134ms
//   whole hook, node included     n=36  p50 103ms  max 298ms
//
// Neither input size (16KB prompts), nor cwd (repo, worktree, home), nor
// cold exec moved the figure materially; only host CPU contention did.
// The live-session samples that motivated this issue (176 and 365ms
// allowed, three more cut off at the 500ms kill) are right-censored — a
// killed call reports the kill, not its own latency — so no percentile
// can honestly be read off them, and none is claimed here.
//
// RE-MEASURED 2026-08-08, same box, idle, n=60 per row, through the same
// spawnSync options — the table above does NOT reproduce:
//
//   tkr route veto-check          p50 131ms  p90 142ms
//   tkr version (bare startup)    p50 130ms  p90 138ms
//   -> veto-check's own work      ~1ms
//   whole hook, node included     p50 209ms (veto on) / 71ms (off)
//
// Identical on installed v5.18.0 and a fresh build of this branch, so the
// gap is not something this change introduced and not a version skew. The
// cost is tkr process startup, not the veto: a 1.8MB Go binary spawns in
// 21ms on this box and tkr is 48MB. Filed as #187, which also carries the
// consequence — the <100ms hot-path guidance in hooks/CLAUDE.md is
// unmeetable by ANY design that spawns tkr once per event, so the "still
// over" note below understates it: the floor alone exceeds the budget.
//
// The budget decision is unaffected. 2500ms is ~19x the re-measured p50
// rather than ~50x, still far outside the range host contention produces.
//
// 2500ms is ~15x the worst latency reproducible under full load and ~3x
// the largest observed live sample. The size is the point: with a
// fail-closed branch behind it, a timeout must mean "this binary is
// hung", never "this box was busy" — a too-tight budget now costs a false
// DENIAL, where before it only cost a missed check. The cost of the
// generous budget is bounded and pays only on the broken path: a
// genuinely hung tkr delays each tkr:* spawn by 2.5s. Typical cost is
// ~130ms (re-measured), over the <100ms hot-path guidance in
// hooks/CLAUDE.md once node startup is counted, as it was before.
const VETO_TIMEOUT_MS = 2500;

// TKR_VETO_TIMEOUT_MS overrides it, registered in cmd/tkr/envvars.go.
// This function is the ONE definition of the budget: agent-search-inject.js
// imports it rather than keeping its own copy, because the timeout value
// and the rule for what a timeout MEANS now have to agree, and two
// constants that must agree are one constant with extra steps.
//
// Garbage and non-positive values fall back to the default rather than
// disabling the check — a budget of 0 would make every check time out,
// which with a fail-closed branch behind it is the worst reachable state.
function vetoTimeoutMs() {
  const raw = parseInt(String(process.env.TKR_VETO_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : VETO_TIMEOUT_MS;
}

// Work modes in which route.VetoCheck gives a finding teeth. Mirrors the
// `enforce` expression in internal/route/veto.go. Off and observe compute
// nothing a hook may act on, so a timeout under them denies nothing.
const ENFORCING_MODES = new Set(["advisory", "assisted", "managed"]);

// Profiles whose contract withholds Edit/Write (ProfileSpec.ForbidsEdits
// in internal/route/profiles.go). Kept in sync by
// internal/route/veto_fallback_sync_test.go, which parses this literal.
// An unlisted profile reads as NOT read-only, so a profile added on the
// Go side without updating this list keeps today's fail-open behavior
// rather than acquiring a denial nobody wrote.
const READONLY_PROFILES = new Set([
  "tkr:explore-haiku",
  "tkr:isolate-research",
  "tkr:research-sonnet",
]);

function profileForbidsEdits(subagentType) {
  return READONLY_PROFILES.has(String(subagentType || ""));
}

// High-confidence subset of internal/route/intent.go's mutationVerbs.
// Every entry here appears there; the reverse does not hold, and must
// not — see the module header for why the omissions are the design.
const MUTATION_VERBS = new Set([
  "write", "edit", "modify", "rewrite", "rename",
  "delete", "remove", "refactor", "implement", "migrate",
  "patch", "install", "commit", "push", "revert",
  "deploy", "rollback", "revoke", "purge", "wipe",
  "truncate", "provision",
]);

// INV-088: the advise rubric tells coordinators to STATE constraints in
// the spawn contract, so "Do not edit anything." is a read-only prompt
// that names a mutation verb. Without this, the best-written contracts
// would be exactly the ones a timeout blocked.
const NEGATORS = new Set([
  "not", "no", "never", "without", "avoid", "avoiding", "cannot",
  "dont", "doesnt", "wont", "cant", "mustnt", "shouldnt",
]);

// How many tokens back of a verb a negator still binds. Same window as
// the Go scanner, for the same reason: it covers "do not edit", "don't
// just fix", "no need to edit" without reaching across a clause.
const NEGATION_WINDOW = 3;

// CLAUSE_BREAK stands in for any run of punctuation or newlines. A
// negator must not reach across one — "Do not guess. Edit the config."
// carries a real instruction — and the Go scanner gets the same effect by
// stopping its backward walk at the first byte that is neither a word
// byte nor an apostrophe. The sentinel is punctuation, which the
// tokenizer strips out of the input before inserting it, so no real
// token can ever equal it.
const CLAUSE_BREAK = "|";

// mutationIntent reports whether the task text asks for a change, using
// whole-token matching with a bounded negation lookback. Apostrophes are
// stripped first so "don't" and "dont" both read as negators.
function mutationIntent(prompt) {
  const tokens = String(prompt || "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9 \t]+/g, " " + CLAUSE_BREAK + " ")
    .split(/[ \t]+/)
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (!MUTATION_VERBS.has(tokens[i])) continue;
    let negated = false;
    for (let back = 1; back <= NEGATION_WINDOW && i - back >= 0; back++) {
      const prev = tokens[i - back];
      if (prev === CLAUSE_BREAK) break;
      if (NEGATORS.has(prev)) {
        negated = true;
        break;
      }
    }
    if (!negated) return true;
  }
  return false;
}

// ── work-mode cache ──────────────────────────────────────────────────
//
// Condition 3 of the fail-closed scope needs the current work mode, and
// the process that knows it is the one that just timed out. Rather than
// grow a second JS reader of the Go config — a parallel port with all the
// drift that implies — every SUCCESSFUL verdict leaves its `mode` behind,
// and the timeout path reads that.
//
// Absence is decisive in the safe direction: no cache, a stale one, or an
// unreadable one all mean "no positive evidence the mode enforces", and
// the timeout falls open. So the very first timeout on a fresh install
// never denies, which is correct — nothing has yet established that this
// user runs an enforcing mode at all.

const MODE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function stateDir() {
  return process.env.TKR_STATE_DIR || path.join(os.homedir(), ".tkr");
}

function modeCachePath() {
  return path.join(stateDir(), "veto-mode.json");
}

// rememberMode records the mode from a verdict that actually came back.
// Best-effort in both directions: an unwritable state dir costs nothing
// but a later fail-open, and an empty/absent mode is not recorded at all
// rather than cached as "".
function rememberMode(mode) {
  const m = String(mode || "");
  if (!m) return;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      modeCachePath(),
      JSON.stringify({ mode: m, at: new Date().toISOString() }),
    );
  } catch {
    // best-effort — a missing cache only ever costs a fail-open
  }
}

// lastKnownMode returns the cached mode, or "" when there is none, it is
// older than MODE_CACHE_MAX_AGE_MS, or anything about reading it failed.
function lastKnownMode() {
  try {
    const target = modeCachePath();
    const age = Date.now() - fs.statSync(target).mtimeMs;
    if (age > MODE_CACHE_MAX_AGE_MS) return "";
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return parsed && typeof parsed.mode === "string" ? parsed.mode : "";
  } catch {
    return "";
  }
}

// timeoutVerdict answers what a timed-out check means for THIS spawn.
//
// Always returns a verdict shaped like route.VetoVerdict — allow for
// every spawn outside the narrow class above — so the hook's deny branch
// needs no special case and, just as importantly, so the LEDGER sees a
// timeout either way. #143 went unnoticed for a release because a
// timed-out check was indistinguishable from one that allowed: both
// produced silence. An allow verdict here is still fail-open behavior;
// it is fail-open that leaves a trace.
//
// Two fields the Go struct has no reason to carry:
//
//   local:   this verdict was decided here, not by policy. The ledger
//            uses it to avoid claiming a check ran.
//   timeout: why.
//
// evaluated is false for the same reason: policy never looked.
function timeoutVerdict(spawn) {
  const subagentType = (spawn && spawn.subagentType) || "";
  const prompt = (spawn && spawn.prompt) || "";
  const mode = lastKnownMode();
  const failOpen = {
    verdict: "allow",
    enforce: false,
    evaluated: false,
    local: true,
    timeout: true,
    mode,
    reason: "veto_check_timeout",
  };
  if (!profileForbidsEdits(subagentType)) return failOpen;
  if (!mutationIntent(prompt)) return failOpen;
  if (!ENFORCING_MODES.has(mode)) return failOpen;
  return {
    ...failOpen,
    verdict: "deny",
    enforce: true,
    detail:
      "tkr route veto-check did not answer within " +
      vetoTimeoutMs() +
      "ms, and this spawn is in the class the veto exists to catch: " +
      subagentType +
      " is read-only (no Edit/Write) and the task carries mutation " +
      "intent, which would either not happen or land unreviewed via " +
      "Bash. Re-issue with a mutating profile (tkr:implement-sonnet, " +
      "tkr:sweep-sonnet, tkr:debug-sonnet), drop the edit ask, or — if " +
      "tkr itself is wedged — set TKR_WORK_VETO_DISABLED=1 and retry.",
  };
}

module.exports = {
  ENFORCING_MODES,
  MODE_CACHE_MAX_AGE_MS,
  READONLY_PROFILES,
  VETO_TIMEOUT_MS,
  lastKnownMode,
  modeCachePath,
  mutationIntent,
  profileForbidsEdits,
  rememberMode,
  timeoutVerdict,
  vetoTimeoutMs,
};
