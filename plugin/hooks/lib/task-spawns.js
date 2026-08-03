// hooks/lib/task-spawns.js
//
// INV-023 P1 — task-spawn observation ledger.
//
// PreToolUse(Agent|Task) hooks call emitTaskSpawn to append one JSONL row
// to ~/.tkr/task-spawns.jsonl every time Claude Code dispatches a subagent.
// The diagnose at docs/proposals/2026-05-20-inv-023-subagent-awareness-
// diagnose.md explains why this ledger lives separate from
// decisions.jsonl (explicit `tkr mcp delegate` semantics) and
// playbook-events.jsonl (L0-L6 playbook layer events): different
// observability concern, different consumers.
//
// Schema (v3):
//   {
//     "at":              "2026-05-20T15:48:45.123Z",
//     "session_id":      "<uuid>",
//     "tool_name":       "Agent" | "Task",
//     "subagent_type":   "Explore" | "blueprint:reviewer" | "" | ...,
//     "description":     "<tool_input.description>",
//     "model":           "" | "opus" | "sonnet" | "haiku",
//     "background":      false,
//     "schema_version":  3,
//
//     // Lifecycle join anchors (v3). Both come straight off the
//     // PreToolUse payload; neither is derived or guessed.
//     "prompt_id":       "<uuid>",       // the turn this spawn belongs to
//     "tool_use_id":     "toolu_...",    // this Agent call's own identity
//
//     // Work-routing join (native-work-routing §14.2), present only when
//     // a work plan was current for this spawn:
//     "plan_id":           "wr-...",
//     "plan_mode":         "observe" | "advisory" | "assisted",
//     "planned_profile":   "tkr:explore-haiku",
//     "planned_model":     "haiku",
//     "requested_profile": "Explore",   // what the coordinator asked for
//     "requested_model":   "",
//     "emitted_profile":   "Explore",   // what this hook emitted
//     "emitted_model":     "",
//     "rewrite_mode":      "none" | "assisted",
//     "claim_denied":      false,        // lost the one-plan-one-spawn claim
//     "followable":        false,
//
//     // Follow scoring — present only when followable is true
//     // (advisory/assisted/managed). Absent in observe, where the
//     // coordinator was never told the plan existed.
//     "profile_followed":  false,
//     "model_followed":    true,
//     "route_followed":    false
//   }
//
// "emitted", not "actual": these are what this hook put on the tool call,
// which a later hook or a global subagent-model override can still
// change. Nothing here observes what ultimately ran.
//
// prompt_id and tool_use_id (v3) exist so a later SubagentStop can be
// attributed to the spawn that caused it. Claude Code gives the two
// events no shared identifier of their own — PreToolUse carries
// tool_use_id but no child agent id, SubagentStop carries agent_id but no
// tool_use_id — so prompt_id plus the agent type is the strongest join
// available, and it is only trustworthy when it resolves to exactly one
// spawn. The reader enforces that; see internal/signals/outcomes.go.
//
// Version bumps are purely additive, and the version exists to keep the
// metrics honest rather than to gate parsing: an absent plan_id on a v2
// row means "no plan was current", while on a v1 row it means "this
// writer never recorded one". Averaging those together would silently
// understate follow rate. Same for prompt_id across v2 and v3 — on a v3
// row it means Claude Code supplied none, on a v2 row it means this
// writer never asked. The Go readers decode only the fields they know
// and ignore the rest, so no reader needs to change in step.
//
// Best-effort: any write error is swallowed. Hot path lives in
// hooks/agent-search-inject.js; this module must stay allocation-light.

"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 3;

function ledgerPath() {
  if (process.env.TKR_TASK_SPAWNS_PATH) return process.env.TKR_TASK_SPAWNS_PATH;
  if (process.env.TKR_STATE_DIR) {
    return path.join(process.env.TKR_STATE_DIR, "task-spawns.jsonl");
  }
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".tkr", "task-spawns.jsonl");
}

function globallyDisabled() {
  return process.env.TKR_TASK_SPAWNS_DISABLED === "1";
}

// Rotation: single-generation .1 backup once the file crosses 10 MB (the
// shared default) — the .1 file is the prior window, anything older is
// dropped.
//
// This used to be a private copy that removed the old .1 before renaming
// over it. hooks/CLAUDE.md requires hot-path JSONL writers to use the
// shared rotator, and the copy is exactly why that rule exists: #86 fixed
// the remove-then-rename data-loss race in rotate-jsonl.js and this copy
// kept it. PreToolUse(Agent) hooks run as parallel processes whenever
// Claude dispatches several agents at once, so two rotators racing here
// is a normal occurrence, not a corner case.
const { rotateIfLarge } = require("./rotate-jsonl");

// emitTaskSpawn appends one row. Caller passes a normalized record
// (the hook handler is responsible for shaping). Throws nothing; any
// fs failure is swallowed because the hot path must not crash on
// observability writes.
function emitTaskSpawn(record) {
  if (globallyDisabled()) return;
  if (!record || typeof record !== "object") return;

  const row = {
    at: new Date().toISOString(),
    session_id: String(record.session_id || ""),
    tool_name: String(record.tool_name || ""),
    subagent_type: String(record.subagent_type || ""),
    description: String(record.description || ""),
    model: String(record.model || ""),
    background: record.background === true,
    schema_version: SCHEMA_VERSION,
    // Always written, empty when Claude Code supplied nothing. Recording
    // the absence is the point: an empty prompt_id is what tells the
    // reader an outcome can never be joined to this row, as opposed to
    // the reader having failed to look.
    prompt_id: String(record.prompt_id || ""),
    tool_use_id: String(record.tool_use_id || ""),
  };

  // Work-routing join (§14.2). All-or-nothing on plan_id: a row either
  // describes a spawn that had a plan, or it says nothing about routing.
  // Half-populated rows would make "planned_profile absent" ambiguous
  // between "no plan" and "plan without a profile".
  const planID = String(record.plan_id || "");
  if (planID) {
    row.plan_id = planID;
    row.plan_mode = String(record.plan_mode || "");
    row.planned_profile = String(record.planned_profile || "");
    row.planned_model = String(record.planned_model || "");
    row.requested_profile = String(record.requested_profile || "");
    row.requested_model = String(record.requested_model || "");
    row.emitted_profile = String(record.emitted_profile || "");
    row.emitted_model = String(record.emitted_model || "");
    row.rewrite_mode = String(record.rewrite_mode || "none");
    // "One plan reshapes at most one spawn" is only checkable if the
    // spawns that were REFUSED the plan say so. Denied means the
    // exclusive claim was not won: another spawn holds it, or it could
    // not be written at all — claimPlan collapses the two and this field
    // does not pretend otherwise.
    row.claim_denied = record.claim_denied === true;
    // Explicit, so a reader never has to infer followability from which
    // fields happen to be present — or worse, from plan_mode, which
    // would put the followable-mode list in two places.
    row.followable = record.followable === true;
    // §15 vocabulary of the plan behind this spawn. Empty on legacy
    // (pre-vocabulary) plans; inside the plan_id block because they
    // describe the plan, and a planless row must stay silent on routing.
    row.route_objective = String(record.route_objective || "");
    row.model_strategy = String(record.model_strategy || "");

    // Follow scoring, and two decisions worth stating.
    //
    // It is computed on what the COORDINATOR REQUESTED, never on what the
    // hook emitted. Scoring the emitted values would make assisted mode
    // report 100% compliance by construction — the hook forced the match
    // — and the question this metric exists to answer is whether the
    // directive persuades the coordinator on its own.
    //
    // It is omitted entirely when the mode is not followable. In observe
    // nothing reaches the model, so a matching profile is coincidence and
    // a mismatch is not a refusal; recording either would quietly poison
    // the rate with spawns the coordinator was never asked about. Absent
    // is the honest value, not false.
    if (record.followable === true) {
      row.profile_followed = row.requested_profile === row.planned_profile;
      // A plan is haiku-shaped economics as much as it is a profile.
      // Naming the planned profile while pinning opus is not a follow —
      // it is the plan's savings claimed and not delivered. An absent
      // model means the profile's own default, which IS the plan.
      row.model_followed =
        !row.requested_model || row.requested_model === row.planned_model;
      row.route_followed = row.profile_followed && row.model_followed;
    }
  }

  try {
    const target = ledgerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfLarge(target);
    fs.appendFileSync(target, JSON.stringify(row) + "\n");
  } catch {
    // best-effort
  }
}

// readSpawns is a test helper. Production consumers should use the Go
// reader once one exists; for now the cmd_gain reconciliation can shell
// to this via a fixture or read the JSONL directly.
function readSpawns(p) {
  const target = p || ledgerPath();
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  emitTaskSpawn,
  readSpawns,
  ledgerPath,
};
