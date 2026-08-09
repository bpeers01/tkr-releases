// hooks/lib/subagent-context.js
//
// isSubagentContext — does THIS hook invocation come from inside a
// subagent (sidechain) rather than the main session?
//
// agent_id and agent_type are the documented markers — hooks.md lists both
// as present only when the hook fires inside a subagent, and documents that
// the sidechain shares the parent's session_id. `scope === "subagent"` and a
// top-level `subagent_type` are the undocumented mirrors that
// user-prompt-submit.js already checks. `tool_input.subagent_type` (the
// SPAWN TARGET, i.e. what a coordinator is dispatching) is deliberately NOT
// consulted: a coordinator spawning a worker is main-session traffic.
//
// Inert when every marker is absent — callers must keep whatever protection
// they had underneath, because "no marker" cannot be read as "definitely the
// main session" on a Claude Code build that ships none of these fields.
//
// Extracted from agent-search-inject.js (its original home, ADR-free) so the
// keepalive interactive-answer touch (issue #152 item 2) tests the same
// predicate rather than a second copy that can drift from it.

"use strict";

function isSubagentContext(event) {
  if (!event || typeof event !== "object") return false;
  if (event.agent_id || event.agent_type) return true;
  if (event.scope === "subagent") return true;
  return typeof event.subagent_type === "string" && event.subagent_type.length > 0;
}

module.exports = { isSubagentContext };
