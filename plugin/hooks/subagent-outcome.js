#!/usr/bin/env node
// tkr SubagentStop hook — subagent outcome ledger (native-work-routing
// §14.4).
//
// Appends one row to ~/.tkr/subagent-outcomes.jsonl every time Claude
// Code reports a subagent stopping. This is the closing half of the
// routing evidence funnel: task-spawns.jsonl records what was DISPATCHED,
// this records what was OBSERVED TO STOP, and `tkr route stats` joins the
// two. Two sibling ledgers of the same rate class rather than one, because
// a spawn and a stop are separate observations that can each exist without
// the other — a spawn whose stop never arrives is exactly the interesting
// case, and folding them into one row would have no place to put it.
//
// WHAT THIS HOOK RECORDS IS ONLY WHAT THE EVENT PROVES.
//
// The payload gives session_id, prompt_id, agent_id, agent_type and
// last_assistant_message. It carries no exit status, no error flag, no
// duration, and no indication of whether the work was any good. So:
//
//   completion   = "stopped". Not "completed". A stop event means the
//                  subagent stopped, which is compatible with success,
//                  refusal, an error, and a user interrupt alike. Writing
//                  "completed" here would manufacture the single most
//                  load-bearing claim in the whole feature out of nothing.
//   verification = "not_observed", always, still. Nothing in tkr validates
//                  worker output. The field exists so the distinction
//                  between "stopped" and "verified" is visible in the data
//                  rather than living in a comment.
//
// SELF-REPORT (schema v2) IS NOT VERIFICATION.
//
// Worker profiles in agents/ now close with a fenced `tkr-handoff` block
// declaring what the worker believes it did: whether the objective was
// answered, and how many gaps and assumptions it is aware of. When such a
// block is present this hook records it in `declared_*` fields.
//
// Those fields are deliberately NOT folded into `verification`, and
// `verification` deliberately still reads "not_observed" on a row that
// carries a self-report. A worker asserting about itself is a scope claim,
// not a quality verdict — it is exactly as trustworthy as the worker, and
// the whole point of the verification field is to record what tkr
// observed. Keeping them in separate fields makes summing a self-report
// into a verification count structurally impossible rather than merely
// discouraged. See docs/routing-outcomes.md.
//
// What a self-report IS good for: a worker that declares three unchecked
// gaps has told the coordinator where to look next, and a run where every
// worker declares "unanswered" is a routing problem visible without
// reading a single transcript.
//
// This hook does NOT join. It writes observed facts and returns; plan
// attribution happens at read time in Go (internal/signals/outcomes.go),
// where it is pure, table-testable, re-runnable against a corrected
// implementation, and — the part that matters on the hot path — free.
// A hook that joined would have to read the spawn ledger on every stop.
//
// PRIVACY. last_assistant_message and transcript_path are deliberately
// NOT recorded. They are the worker's output and a filesystem path into
// the user's projects; neither is needed to answer "did this plan produce
// a worker that ran?", and a local ledger is a poor place to accumulate
// transcript text. Identifiers and categorical fields only.
//
// Schema v2 READS last_assistant_message but still records none of it.
// The handoff parser extracts an enum and two small integers and discards
// the string; no free-text field is derived from it, and no path to one
// exists — `declared_outcome` is drawn from a fixed vocabulary, and a
// value outside that vocabulary is dropped rather than passed through.
// The existing tests asserting no transcript text reaches the ledger are
// the guardrail for this, and a correct implementation leaves them green.
//
// Kill switches (in order, both no-op the hook):
//   1. TKR_HOOKS_DISABLED=1 — master tkr-hooks kill switch (M-12)
//   2. TKR_SUBAGENT_OUTCOMES_DISABLED=1 — this ledger only
//
// TKR_ROUTE_DISABLED is deliberately NOT honored here. Routing being off
// is the baseline this ledger exists to measure against: the unrouted
// spawns are the control group, and dropping them would leave a funnel
// whose denominator moves whenever the feature is toggled.
//
// Output contract: empty `{}` on stdout. Pure observability.

"use strict";

const fs = require("fs");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { rotateIfLarge } = require("./lib/rotate-jsonl");
const { stateDir } = require("./lib/state-dir");
const { getSessionID } = require("./lib/session-id");
const {
  popOldestSnapshot,
  currentGitStatus,
  diffTrackedMutations,
} = require("./lib/git-status-snapshot");

// v1 -> v2: added the declared_* self-report fields, parsed from the
// worker's fenced tkr-handoff block. Every v2 field is omitted when the
// worker emitted no block, so a v2 row from a worker that stayed silent
// is byte-identical to a v1 row apart from this number. Readers use it to
// tell "the writer could not record this" from "there was nothing to
// record" — see internal/signals/outcomes.go for the same distinction on
// the sibling spawn ledger.
const SCHEMA_VERSION = 2;

// LEDGER_BASENAME is duplicated in internal/signals/outcomes.go
// (SubagentOutcomesPath). Change both or the reader silently reports an
// empty funnel.
const LEDGER_BASENAME = "subagent-outcomes.jsonl";

function outcomesDisabled() {
  return process.env.TKR_SUBAGENT_OUTCOMES_DISABLED === "1";
}

function ledgerPath() {
  if (process.env.TKR_SUBAGENT_OUTCOMES_PATH) {
    return process.env.TKR_SUBAGENT_OUTCOMES_PATH;
  }
  return path.join(stateDir(), LEDGER_BASENAME);
}

// Bounded: every field is a short identifier or a fixed enum value, and
// each is clamped so a hostile or malformed payload cannot write an
// unbounded row into an append-only file.
const MAX_FIELD = 256;

function field(v) {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

// ── Handoff self-report (schema v2) ──────────────────────────────────
//
// Contract, mirrored in agents/*.md: the worker's final message may end
// with
//
//   ```tkr-handoff
//   outcome: answered | partial | unanswered
//   gaps: <integer>
//   assumptions: <integer>
//   ```
//
// Anything not matching is silently ignored. A worker that emits no
// block, a malformed block, or a block with an unrecognized outcome is
// indistinguishable in the ledger from the v1 behavior — absence of a
// self-report is the default, never an error, because the alternative is
// a hook that penalizes workers for a contract they may predate.

// HANDOFF_SCAN_BYTES bounds how much of the final message is examined.
// The block is a trailer by contract, so the tail is sufficient, and a
// runaway or hostile message cannot turn a hot-path hook into a
// full-transcript scan.
const HANDOFF_SCAN_BYTES = 4096;

// MAX_DECLARED_COUNT clamps the integer fields. These are "how many gaps
// did you notice", not a quantity anything downstream sizes a buffer
// from; a worker claiming 10^9 assumptions is malformed, not informative.
const MAX_DECLARED_COUNT = 99;

const DECLARED_OUTCOMES = new Set(["answered", "partial", "unanswered"]);

// Non-greedy body capture, applied to the tail. Scanning for the LAST
// match matters: a worker that explains the format mid-answer and then
// emits a real block must be read as declaring the second one.
const HANDOFF_FENCE = /```tkr-handoff[ \t]*\r?\n([\s\S]*?)```/g;

function parseDeclaredCount(raw) {
  // Deliberately strict: /^\d+$/ and not parseInt, which would read
  // "3 gaps remain" as 3 and silently invent precision from prose.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n > MAX_DECLARED_COUNT ? MAX_DECLARED_COUNT : n;
}

// parseHandoff returns {outcome, gaps, assumptions} with absent keys
// omitted, or null when no well-formed block is present. `outcome` is
// required: a block declaring only counts has not said the one thing the
// field exists to capture, and recording counts without it would imply a
// completeness claim the worker never made.
function parseHandoff(msg) {
  if (typeof msg !== "string" || msg === "") return null;
  const tail =
    msg.length > HANDOFF_SCAN_BYTES ? msg.slice(-HANDOFF_SCAN_BYTES) : msg;

  let body = null;
  HANDOFF_FENCE.lastIndex = 0;
  for (let m = HANDOFF_FENCE.exec(tail); m !== null; m = HANDOFF_FENCE.exec(tail)) {
    body = m[1];
  }
  if (body === null) return null;

  const out = {};
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "outcome") {
      const v = val.toLowerCase();
      if (DECLARED_OUTCOMES.has(v)) out.outcome = v;
    } else if (key === "gaps" || key === "assumptions") {
      const n = parseDeclaredCount(val);
      if (n !== null) out[key] = n;
    }
  }
  return out.outcome ? out : null;
}

// buildRow shapes the payload. Exported for tests so the schema can be
// asserted without spawning a process.
function buildRow(input) {
  const ev = input && typeof input === "object" ? input : {};
  const row = {
    at: new Date().toISOString(),
    event: "subagent-stop",
    schema_version: SCHEMA_VERSION,
    session_id: field(getSessionID(ev)),
    // The join anchors. Empty means Claude Code did not supply one, and
    // the reader treats that as unjoinable rather than substituting a
    // guess — see the join precedence in internal/signals/outcomes.go.
    prompt_id: field(ev.prompt_id),
    agent_id: field(ev.agent_id),
    agent_type: field(ev.agent_type),
    // See the header: these are the two claims this event can support,
    // and neither of them is "it worked".
    completion: "stopped",
    verification: "not_observed",
  };
  // The worker's own account, when it left one. Kept out of
  // `verification` on purpose — see the SELF-REPORT block in the header.
  // Absent keys rather than zero values: "declared no gaps" and "did not
  // say" are different claims, and only one of them is evidence.
  const declared = parseHandoff(ev.last_assistant_message);
  if (declared) {
    row.declared_outcome = declared.outcome;
    if (declared.gaps !== undefined) row.declared_gaps = declared.gaps;
    if (declared.assumptions !== undefined) {
      row.declared_assumptions = declared.assumptions;
    }
  }
  return row;
}

function appendRow(row) {
  const target = ledgerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  rotateIfLarge(target);
  fs.appendFileSync(target, JSON.stringify(row) + "\n");
}

// checkStateMutation is the SubagentStop half of INV-097: pop the oldest
// pending git-status snapshot recorded for this session at Agent spawn
// (agent-search-inject.js), diff it against the current tracked-file
// state, and return a human-readable warning string when tracked files
// changed that the snapshot did not already show as dirty — the exact
// gap a self-report cannot close, since a gate reading the mutated file
// cannot tell a falsified value from a correct one.
//
// Returns null on "nothing to report" AND on any failure (no snapshot,
// no git, not a repo) — fails open, never throws. Best-effort only: see
// hooks/lib/git-status-snapshot.js for why the snapshot/stop correlation
// is FIFO-approximate rather than an exact join.
function checkStateMutation(ev) {
  try {
    const sid = getSessionID(ev);
    const before = popOldestSnapshot(sid);
    if (!before) return null;
    const after = currentGitStatus();
    if (after === null) return null;
    const mutated = diffTrackedMutations(before.lines, after);
    if (mutated.length === 0) return null;
    return (
      "tkr: this subagent's spawn left tracked-file changes on disk that " +
      "its own report did not account for (INV-097) — " +
      mutated.slice(0, 10).map(field).join("; ")
    );
  } catch {
    return null;
  }
}

function main() {
  if (hooksDisabled() || outcomesDisabled()) {
    process.stdout.write("{}");
    return;
  }
  readStdinWithTimeout(2000)
    .then((raw) => {
      let input = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        process.stdout.write("{}");
        return;
      }
      // Guard against a misrouted matcher or a future event that reuses
      // this handler: a row claiming to be a subagent stop must come from
      // one. An absent name is tolerated because synthesized test stdin
      // and older Claude Code builds both omit it.
      const name = input.hook_event_name;
      if (name && name !== "SubagentStop") {
        process.stdout.write("{}");
        return;
      }
      try {
        appendRow(buildRow(input));
      } catch {
        // Best-effort telemetry; a full disk must not stall a subagent.
      }
      const warning = checkStateMutation(input);
      if (warning) {
        process.stdout.write(JSON.stringify({ systemMessage: warning }));
      } else {
        process.stdout.write("{}");
      }
    })
    .catch(() => {
      process.stdout.write("{}");
    });
}

// Test surface
module.exports = {
  SCHEMA_VERSION,
  LEDGER_BASENAME,
  MAX_DECLARED_COUNT,
  buildRow,
  ledgerPath,
  outcomesDisabled,
  parseHandoff,
  checkStateMutation,
};

if (require.main === module) {
  main();
}
