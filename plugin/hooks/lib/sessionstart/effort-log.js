// hooks/lib/sessionstart/effort-log.js
//
// Forward-looking effort + model telemetry.
//
// Claude Code does NOT record the active effort level in the per-turn
// JSONL written to ~/.claude/projects/, which makes look-back analysis
// of historical effort distribution impossible from that source. This
// module captures effort at SessionStart so future analysis has a
// per-session record going forward.
//
// Output: append-only JSONL at $TKR_STATE_DIR/session-effort.jsonl,
// one row per SessionStart firing. Shape:
//
//   {"ts":"2026-05-19T17:35:00Z","sid":"...","source":"startup",
//    "effort":"high","effort_source":"CLAUDE_EFFORT","model":""}
//
// Best-effort — failure is swallowed; SessionStart hot path must
// never fail because of telemetry.

"use strict";

const fs = require("fs");
const path = require("path");

const { stateDir } = require("../state-dir");

function detectEffort(env) {
  if (env.CLAUDE_CODE_EFFORT_LEVEL) {
    return { effort: env.CLAUDE_CODE_EFFORT_LEVEL, source: "CLAUDE_CODE_EFFORT_LEVEL" };
  }
  if (env.CLAUDE_EFFORT) {
    return { effort: env.CLAUDE_EFFORT, source: "CLAUDE_EFFORT" };
  }
  return { effort: "", source: "" };
}

function detectEffortFromInput(input) {
  if (input && input.effort && typeof input.effort.level === "string") {
    return input.effort.level;
  }
  return "";
}

function detectModel(env, input) {
  if (env.CLAUDE_MODEL) return env.CLAUDE_MODEL;
  if (input && typeof input.model === "string") return input.model;
  return "";
}

function logSessionEffort(sid, input, env = process.env) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const envEffort = detectEffort(env);
    const inputEffort = detectEffortFromInput(input);
    const effort = inputEffort || envEffort.effort;
    const source = inputEffort ? "hook_input.effort.level" : envEffort.source;
    const row = {
      ts: new Date().toISOString(),
      sid: sid || env.CLAUDE_CODE_SESSION_ID || "",
      source: (input && typeof input.source === "string") ? input.source : "startup",
      effort: effort,
      effort_source: source,
      model: detectModel(env, input),
    };
    fs.appendFileSync(path.join(dir, "session-effort.jsonl"), JSON.stringify(row) + "\n");
  } catch {
    // best-effort
  }
}

// persistSessionEffort — write the detected effort to a per-session
// state file (effort-<sid>.json) that user-prompt-submit's
// detectActiveEffort reads as its fallback when the effort env vars are
// absent in the hook environment, and that `tkr top` (issue #123) reads
// as the session's actual EFFORT column, distinct from the route
// classifier's per-prompt recommendation. Unlike session-effort.jsonl
// (append-only telemetry, never read on the hot path), this file closes
// the active-effort loop for the shape nudge (ADR-0010 addendum). When
// no effort is detectable the file is removed so a stale value from a
// prior launch of the same session id can't masquerade as current.
//
// Called from SessionStart, every UserPromptSubmit, and every
// PostToolUse — `tkr top` runs as a separate process with no visibility
// into this session's live env vars, so this file is its only channel.
//
// PostToolUse is the only caller that can actually observe effort.
// Claude Code supplies `input.effort` and CLAUDE_EFFORT only to hooks
// firing inside a tool-use context, and states so in its own payload
// schema: "Present for hooks that fire within a tool-use context
// (PreToolUse, PostToolUse, Stop, SubagentStop, etc.) ...; absent for
// session-lifecycle hooks and models without effort support." The
// SessionStart/UserPromptSubmit calls are kept because they cost one
// env read and would start working if that ever changes — but for them
// an absent effort is no evidence, only ignorance.
//
// clearWhenAbsent draws exactly that line. True (SessionStart, a launch
// boundary; PostToolUse, the authoritative observer) means an
// undetectable effort deletes the snapshot, so a value from a prior
// launch or a pre-/model-switch turn cannot masquerade as current.
// False (UserPromptSubmit) means silence changes nothing — a
// lifecycle hook that never sees effort must not erase what the last
// tool call wrote.
function persistSessionEffort(sid, input, env = process.env, opts = {}) {
  try {
    if (!sid) return;
    const dir = stateDir();
    const target = path.join(dir, `effort-${sid}.json`);
    const inputEffort = detectEffortFromInput(input);
    const envEffort = detectEffort(env);
    const effort = inputEffort || envEffort.effort;
    if (!effort) {
      if (opts.clearWhenAbsent) {
        try { fs.unlinkSync(target); } catch {}
      }
      return;
    }
    const source = inputEffort ? "hook_input.effort.level" : envEffort.source;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ effort: effort, source: source, ts: new Date().toISOString() }));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

module.exports = { logSessionEffort, persistSessionEffort, detectEffort, detectEffortFromInput, detectModel };
