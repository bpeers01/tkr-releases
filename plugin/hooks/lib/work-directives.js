// hooks/lib/work-directives.js
//
// Native-work-routing §14 — one ledger row per coordinator directive that
// actually went out.
//
// WHY THIS EXISTS. The funnel needs "how many directives were emitted?"
// as the denominator for "how many did the coordinator act on?", and
// nothing else can supply it. The route decision row is written by the Go
// binary before the JS hook decides whether to emit, so it records that a
// plan existed, not that anyone was told. The spawn row records
// followable=true, but only for turns where the coordinator spawned an
// Agent at all — which silently drops the single most interesting outcome,
// a directive that produced no spawn whatsoever. Measuring follow rate
// against a denominator that excludes every total refusal would report a
// number that can only go up.
//
// WHERE IT WRITES. ~/.tkr/decisions.jsonl, the existing shared audit
// ledger, under a new `event` value — §14 says to use existing stores
// rather than add another general ledger, and this file already carries
// event-discriminated rows from three writers (route-classified, delegate,
// autoroute). Readers filter on `event`, so a new value is invisible to
// all of them.
//
// RATE. One append per EMITTED directive, never per prompt. That needs a
// non-off mode and a native-worker plan, both of which are off by default,
// so on a default install this file is never touched. The per-prompt
// receipt (work-route-state.js) stays a single overwritten file precisely
// because it does fire every turn; this is the low-rate half and can
// afford to be append-only.
//
// Best-effort: any write error is swallowed. UserPromptSubmit is the
// hottest path tkr has.

"use strict";

const fs = require("fs");
const path = require("path");

const { rotateIfLarge } = require("./rotate-jsonl");
const { stateDir } = require("./state-dir");

const SCHEMA_VERSION = 1;

// EVENT is duplicated in internal/signals/outcomes.go
// (WorkDirectiveEvent). Change both or the reader counts zero directives
// forever, which reads as "the coordinator was never told" rather than
// "the reader is looking for the wrong string".
const EVENT = "work-directive";

function ledgerPath() {
  if (process.env.TKR_DECISIONS_PATH) return process.env.TKR_DECISIONS_PATH;
  return path.join(stateDir(), "decisions.jsonl");
}

// emitWorkDirective records that `planID` was named to the coordinator on
// this turn. Callers must invoke it ONLY when a directive was genuinely
// emitted — this ledger's whole value is that its rows cannot be produced
// by a plan that stayed silent.
//
// `ts`, not `at`: signals.LoadRecords and every other decisions.jsonl
// reader keys on ts, and a row with the wrong timestamp field is a row
// with no timestamp.
function emitWorkDirective(fields) {
  const f = fields || {};
  const planID = String(f.planID || "");
  if (!planID) return;
  if (process.env.TKR_HOOKS_DISABLED === "1") return;
  if (process.env.TKR_WORK_ROUTE_DISABLED === "1") return;
  try {
    const target = ledgerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfLarge(target);
    fs.appendFileSync(
      target,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: EVENT,
        schema_version: SCHEMA_VERSION,
        session_id: String(f.sessionID || ""),
        // Carried so a directive is joinable to the spawns of the same
        // turn. Same anchor the spawn and outcome ledgers use.
        prompt_id: String(f.promptID || ""),
        plan_id: planID,
        // The profile the directive actually named, parsed back out of
        // the emitted text rather than re-read from the plan — the row
        // then describes what the model was told, which is the only thing
        // a follow rate can be measured against.
        //
        // No `mode` field: the route-classified row for this same plan_id
        // is in this same file and already carries work_mode. Writing it
        // twice invites the two copies to disagree about the mode a plan
        // was computed under, which is the exact confusion work_mode was
        // added to end.
        profile: String(f.profile || ""),
        // §15 vocabulary, present only when the directive carried it —
        // legacy-format directives (pre-vocabulary plans) leave both
        // empty. Additive; still schema v1, same tolerance the Go reader
        // (internal/signals/outcomes.go) already documents.
        route_objective: String(f.objective || ""),
        model_strategy: String(f.modelStrategy || ""),
      }) + "\n",
    );
  } catch {
    // best-effort
  }
}

module.exports = { EVENT, SCHEMA_VERSION, emitWorkDirective, ledgerPath };
