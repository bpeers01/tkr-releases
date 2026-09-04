#!/usr/bin/env node
// hooks/post-tool-batch.js — #134 R0.2: first-action / first-batch ledger.
//
// PostToolBatch fires once per resolved batch of parallel tool calls.
// This hook records ONE row per prompt — the first batch after each
// user prompt — classifying what the coordinator did first:
//
//   agent_first               every call in the batch was Agent/Task
//   direct_read_search_first  no Agent; every call was a read/search
//   mixed_parallel_batch      Agent(s) and non-Agent call(s) together
//   other                     anything else (edits, bash, unknown mix)
//   unavailable               the event fired but carried no
//                             recognizable tool list (R0.3: an
//                             unreadable payload must say so, never
//                             masquerade as a classification)
//
// "no_successful_tool_action" is deliberately NOT producible here: this
// hook only runs when a batch resolved. Whether a prompt produced no
// successful tool action at all is a read-side derivation (prompts with
// activity elsewhere but no first-batch row), and the reader must first
// establish that PostToolBatch is delivered at all on the running
// Claude Code build — an empty ledger on a build that never emits the
// event means "unavailable", not "the coordinator never acted". Same
// honesty rule as docs/routing-outcomes.md § Reporting rules.
//
// Payload facts, verified against the Claude Code 2.1.221 binary
// (2026-08-04; the public hooks doc lags it): "PostToolBatch" is in the
// CLI's canonical hook-event list, and the input "includes tool_calls
// (array of {tool_name, tool_input, tool_use_id, tool_response})",
// fired "once after every tool call has resolved, before the next
// model request". Earlier builds simply never fire the event; the
// availability gate below and the read side surface that as
// "unavailable" rather than as a coordinator that never acted.
//
// Row (schema v1) → ~/.tkr/first-batch.jsonl:
//   {
//     "at": ISO, "event": "first-batch", "schema_version": 1,
//     "session_id": "", "prompt_id": "",       // join anchors
//     "first_action": <enum above>,
//     "batch_size": n,                          // calls in the batch
//     "tool_names": ["Agent","Read",...],       // ≤16, clamped
//     "payload_shape": "tool_calls" | "unavailable"
//   }
//
// tool_names are categorical identifiers (tool names only — never
// inputs or outputs), inside the privacy line drawn in
// docs/routing-outcomes.md § Privacy.
//
// First-per-prompt dedup: a marker file first-batch-<sid>.json holds
// the last prompt_id recorded; a later batch on the same prompt is
// skipped. Marker files are swept at 24h by `tkr hook session-start`
// (internal/hooks/sessionstart, SweepFirstBatchMarkers) alongside the
// other per-session state.

"use strict";

const fs = require("fs");
const path = require("path");

const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { stateDir } = require("./lib/state-dir");
const { getSessionID } = require("./lib/session-id");
const { rotateIfLarge } = require("./lib/rotate-jsonl");

const SCHEMA_VERSION = 1;

// LEDGER_BASENAME is duplicated in internal/signals/completions.go
// (FirstBatchPath). Change both or the reader silently reports an
// empty ledger.
const LEDGER_BASENAME = "first-batch.jsonl";

const MAX_FIELD = 256;
const MAX_TOOL_NAMES = 16;

const AGENT_TOOLS = new Set(["Agent", "Task"]);
// Direct read/search tools: the built-in read-only exploration surface,
// plus MCP read/search/graph tools (tkr_search, tkr_read, tkr_graph and
// equivalents from other servers).
const READ_SEARCH_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
]);
const MCP_READ_SEARCH = /^mcp__.*(search|read|graph|fetch)/i;

function firstBatchDisabled() {
  return process.env.TKR_FIRST_BATCH_DISABLED === "1";
}

function ledgerPath() {
  if (process.env.TKR_FIRST_BATCH_PATH) {
    return process.env.TKR_FIRST_BATCH_PATH;
  }
  return path.join(stateDir(), LEDGER_BASENAME);
}

function field(v) {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

// toolNamesFrom extracts the batch's tool names. tool_calls is the
// CLI's field (see the header); tool_uses/toolUses are tolerated so a
// rename in a future build degrades to nothing worse than a working
// parse, and anything unrecognizable degrades to "unavailable", not to
// a crash. Entries whose tool_response is marked as an error are
// excluded: the classification is of the first SUCCESSFUL action.
function toolNamesFrom(ev) {
  const calls = Array.isArray(ev?.tool_calls)
    ? ev.tool_calls
    : Array.isArray(ev?.tool_uses)
      ? ev.tool_uses
      : Array.isArray(ev?.toolUses)
        ? ev.toolUses
        : null;
  if (!calls) return null;
  const names = [];
  for (const u of calls) {
    if (!u || typeof u !== "object") continue;
    const result = u.tool_response ?? u.tool_result ?? u.toolResult;
    if (result && typeof result === "object") {
      if (result.is_error === true || result.isError === true) continue;
    }
    const name = u.tool_name ?? u.toolName;
    if (typeof name === "string" && name !== "") names.push(field(name));
  }
  return names;
}

function classify(names) {
  if (names === null) return "unavailable";
  if (names.length === 0) return "other";
  const agents = names.filter((n) => AGENT_TOOLS.has(n)).length;
  if (agents === names.length) return "agent_first";
  if (agents > 0) return "mixed_parallel_batch";
  const readSearch = names.filter(
    (n) => READ_SEARCH_TOOLS.has(n) || MCP_READ_SEARCH.test(n),
  ).length;
  if (readSearch === names.length) return "direct_read_search_first";
  return "other";
}

function markerPath(sessionID) {
  return path.join(stateDir(), `first-batch-${sessionID || "unknown"}.json`);
}

// alreadyRecorded reports whether this prompt's first batch is already
// in the ledger, and claims the marker when it is not. Read-then-write
// is acceptable here (unlike work claims): PostToolBatch is one event
// per batch, and two racing batches on one prompt at worst record two
// rows — the reader dedups on (session_id, prompt_id) keeping the
// earliest, so a duplicate inflates nothing.
function alreadyRecorded(sessionID, promptID) {
  const p = markerPath(sessionID);
  try {
    const cur = JSON.parse(fs.readFileSync(p, "utf8"));
    if (cur && cur.prompt_id === promptID) return true;
  } catch {
    // missing or torn marker — treat as unrecorded
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ prompt_id: promptID, at: new Date().toISOString() }),
    );
  } catch {
    // best-effort: a failed marker write costs a duplicate row at worst
  }
  return false;
}

// buildRow shapes one ledger row. Exported for tests. Returns null when
// the event is some other hook event misrouted here.
function buildRow(event) {
  const ev = event && typeof event === "object" ? event : {};
  const name = ev.hook_event_name;
  if (name && name !== "PostToolBatch") return null;

  const names = toolNamesFrom(ev);
  return {
    at: new Date().toISOString(),
    event: "first-batch",
    schema_version: SCHEMA_VERSION,
    session_id: field(getSessionID(ev)),
    prompt_id: field(ev.prompt_id),
    first_action: classify(names),
    batch_size: names === null ? 0 : names.length,
    tool_names: names === null ? [] : names.slice(0, MAX_TOOL_NAMES),
    payload_shape: names === null ? "unavailable" : "tool_calls",
  };
}

function appendRow(row) {
  const target = ledgerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  rotateIfLarge(target);
  fs.appendFileSync(target, JSON.stringify(row) + "\n");
}

// The 24h sweep of first-batch-<sid>.json markers used to live here and be
// called from session-start.js. It moved to Go with the #664 Phase 4
// cutover — internal/hooks/sessionstart.SweepFirstBatchMarkers, called from
// internal/cmd/hook_sessionstart.go alongside the statusline/mode/work-file
// sweeps, same 24h policy. The JS copy was deleted rather than left
// exported-and-uncalled, which is the unwired-producer shape wiring-guard
// exists to catch.

function main() {
  if (hooksDisabled() || firstBatchDisabled()) {
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
      try {
        const row = buildRow(input);
        if (row && !alreadyRecorded(row.session_id, row.prompt_id)) {
          appendRow(row);
        }
      } catch {
        // Best-effort telemetry; never stall the batch.
      }
      process.stdout.write("{}");
    })
    .catch(() => {
      process.stdout.write("{}");
    });
}

// Test surface
module.exports = {
  SCHEMA_VERSION,
  LEDGER_BASENAME,
  buildRow,
  classify,
  toolNamesFrom,
  firstBatchDisabled,
  ledgerPath,
};

if (require.main === module) {
  main();
}
