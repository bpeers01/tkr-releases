// hooks/lib/agent-completions.js
//
// #134 R0.1 — Agent-completion telemetry ledger.
//
// PostToolUse(Agent|Task) delivers, on current Claude Code builds, a
// tool_response describing what the dispatched subagent actually did:
// agentId, resolvedModel, totalTokens + detailed usage, duration, and
// tool-call count. hooks/post-tool-call.js calls recordAgentCompletion
// with the raw PostToolUse event; one JSONL row is appended to
// ~/.tkr/agent-completions.jsonl.
//
// This is the missing middle of the lifecycle join
// (docs/routing-outcomes.md § The join): the spawn row
// (task-spawns.jsonl, schema v3) carries (session_id, tool_use_id) and
// this row carries the same pair PLUS agent_id — the identifier
// SubagentStop rows are keyed on. A completion row therefore bridges
// spawn → stop exactly, where the previous best was the
// (session_id, prompt_id, agent_type) uniqueness-gated join.
//
// Schema (v1):
//   {
//     "at":                   "2026-08-04T...Z",
//     "event":                "agent-completion",
//     "schema_version":       1,
//
//     // Join anchors — straight off the PostToolUse payload, clamped,
//     // empty when Claude Code supplied none. Never derived or guessed.
//     "session_id":           "<uuid>",
//     "prompt_id":            "<uuid>",
//     "tool_use_id":          "toolu_...",
//
//     "tool_name":            "Agent" | "Task",
//     "status":               "completed" | "async_launched" | <other>,
//
//     // What Claude Code reported about the worker. agent_type here is
//     // the type CC resolved, distinct from the spawn row's
//     // subagent_type (what the coordinator requested).
//     "agent_id":             "a6b3234f...",
//     "agent_type":           "general-purpose",
//     "resolved_model":       "claude-sonnet-5",
//     "models_used":          ["..."],          // only when supplied
//
//     // Numerics are written ONLY when the payload carried a finite
//     // number. An absent key means "this Claude Code build did not
//     // supply the field" — the Go reader (internal/signals) decodes
//     // them as pointers and reports print "unavailable", never 0.
//     // This is the #134 R0 hard gate: a missing capability must be
//     // impossible to misread as zero cost.
//     "total_duration_ms":    880628,
//     "total_tokens":         103210,
//     "total_tool_use_count": 27,
//     "usage": {
//       "input_tokens":                n,
//       "output_tokens":               n,
//       "cache_creation_input_tokens": n,
//       "cache_read_input_tokens":     n
//     },
//
//     // The worker's own account, parsed from the fenced tkr-handoff
//     // trailer of its final message (same parser and same discipline
//     // as subagent-outcomes.jsonl): a claim channel, not verification.
//     "declared_outcome":     "answered" | "partial" | "unanswered",
//     "declared_gaps":        0-99,
//     "declared_assumptions": 0-99
//   }
//
// Deliberately NOT stored (docs/routing-outcomes.md § Privacy): the
// Agent prompt, the worker's final content (read for the handoff parse,
// then discarded), and outputFile (a filesystem path into the user's
// machine, same class as transcript_path). Identifiers, enums, and
// counts only.
//
// Read-time dedup key: (session_id, tool_use_id) — a background agent
// may produce both an "async_launched" row and, on builds that re-fire
// PostToolUse at completion, a "completed" row; readers prefer the
// completed row. Rows with no tool_use_id are all kept, mirroring the
// spawn ledger: nothing to deduplicate on, and dropping a real
// completion is worse than keeping a duplicate.
//
// Best-effort: any failure is swallowed. This runs inside the
// PostToolUse hot path (post-tool-call.js), so it must stay
// allocation-light and must never throw past its own boundary.

"use strict";

const fs = require("fs");
const path = require("path");

const { rotateIfLarge } = require("./rotate-jsonl");
const { getSessionID } = require("./session-id");
// parseHandoff is the strict, bounded trailer parser shared with the
// SubagentStop ledger. Requiring the hook module is safe: its main() is
// guarded by require.main.
const { parseHandoff } = require("../subagent-outcome.js");

const SCHEMA_VERSION = 1;

// LEDGER_BASENAME is duplicated in internal/signals/completions.go
// (AgentCompletionsPath). Change both or the reader silently reports an
// empty ledger.
const LEDGER_BASENAME = "agent-completions.jsonl";

const MAX_FIELD = 256;
const MAX_MODELS_USED = 8;

function completionsDisabled() {
  return process.env.TKR_AGENT_COMPLETIONS_DISABLED === "1";
}

function ledgerPath() {
  if (process.env.TKR_AGENT_COMPLETIONS_PATH) {
    return process.env.TKR_AGENT_COMPLETIONS_PATH;
  }
  if (process.env.TKR_STATE_DIR) {
    return path.join(process.env.TKR_STATE_DIR, LEDGER_BASENAME);
  }
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".tkr", LEDGER_BASENAME);
}

function field(v) {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

// num returns a non-negative finite number or undefined. undefined keys
// are omitted from the row — absence is the explicit "this build did
// not say" state, and substituting 0 is exactly the misreading #134
// R0.3 exists to prevent.
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? v
    : undefined;
}

// lastTextContent extracts the worker's final text for the handoff
// parse. The response's `content` is an array of blocks on current
// builds; a plain string is tolerated for shape drift. The returned
// string is parsed and discarded — it never reaches the row.
function lastTextContent(resp) {
  const c = resp?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  for (let i = c.length - 1; i >= 0; i--) {
    const b = c[i];
    if (b && b.type === "text" && typeof b.text === "string") return b.text;
  }
  return "";
}

// buildRow shapes one ledger row from a PostToolUse event. Exported for
// tests so the schema can be asserted without spawning a process.
// Returns null when the event is not an Agent/Task PostToolUse.
function buildRow(event) {
  const ev = event && typeof event === "object" ? event : {};
  if (ev.tool_name !== "Agent" && ev.tool_name !== "Task") return null;
  const resp =
    ev.tool_response && typeof ev.tool_response === "object"
      ? ev.tool_response
      : {};

  const row = {
    at: new Date().toISOString(),
    event: "agent-completion",
    schema_version: SCHEMA_VERSION,
    session_id: field(getSessionID(ev)),
    prompt_id: field(ev.prompt_id),
    tool_use_id: field(ev.tool_use_id),
    tool_name: ev.tool_name,
    status: field(resp.status),
    agent_id: field(resp.agentId),
    agent_type: field(resp.agentType),
    resolved_model: field(resp.resolvedModel),
  };

  if (Array.isArray(resp.modelsUsed) && resp.modelsUsed.length > 0) {
    row.models_used = resp.modelsUsed
      .slice(0, MAX_MODELS_USED)
      .map((m) => field(m));
  }

  const durationMs = num(resp.totalDurationMs);
  if (durationMs !== undefined) row.total_duration_ms = durationMs;
  const totalTokens = num(resp.totalTokens);
  if (totalTokens !== undefined) row.total_tokens = totalTokens;
  const toolUseCount = num(resp.totalToolUseCount);
  if (toolUseCount !== undefined) row.total_tool_use_count = toolUseCount;

  if (resp.usage && typeof resp.usage === "object") {
    const usage = {};
    for (const k of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ]) {
      const n = num(resp.usage[k]);
      if (n !== undefined) usage[k] = n;
    }
    if (Object.keys(usage).length > 0) row.usage = usage;
  }

  const declared = parseHandoff(lastTextContent(resp));
  if (declared) {
    row.declared_outcome = declared.outcome;
    if (declared.gaps !== undefined) row.declared_gaps = declared.gaps;
    if (declared.assumptions !== undefined) {
      row.declared_assumptions = declared.assumptions;
    }
  }

  return row;
}

// recordAgentCompletion appends one row for an Agent/Task PostToolUse
// event. Throws nothing; any failure is swallowed because the hot path
// must not crash on observability writes.
function recordAgentCompletion(event) {
  try {
    if (completionsDisabled()) return;
    const row = buildRow(event);
    if (!row) return;
    const target = ledgerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfLarge(target);
    fs.appendFileSync(target, JSON.stringify(row) + "\n");
  } catch {
    // best-effort
  }
}

module.exports = {
  SCHEMA_VERSION,
  LEDGER_BASENAME,
  buildRow,
  completionsDisabled,
  ledgerPath,
  recordAgentCompletion,
};
