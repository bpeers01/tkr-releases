"use strict";

// hooks/lib/session-id-inject.js
//
// INV-121: delta's session id falls back to `pid-<ppid>` for every
// Bash-tool invocation, because a spawned `tkr <cmd>` child gets neither
// CLAUDE_SESSION_ID nor TKR_SESSION_ID from Claude Code — only
// `tkr-rewrite.js`'s PreToolUse event payload carries the real
// `session_id`. A pid-keyed session accumulates ~1 snapshot key and can
// never produce a delta hit (a hit needs the same key looked up twice
// within one session), which measured as delta hit rate falling from
// 17.9% to 0.3% across releases.
//
// The fix attaches the real sid to the REWRITTEN command as a
// `--session-id` global flag on tkr, not a shell env prefix
// (`TKR_SESSION_ID=x tkr ...`): bash and PowerShell quote an env-prefix
// assignment differently, and a malformed one breaks the whole command
// instead of degrading to the existing pid fallback. `cmd/tkr/main.go`
// reads the flag and Setenv's TKR_SESSION_ID from it before any other
// session-id resolution runs.
//
// #584: the same shape now also carries `--tool-use-id` and `--prompt-id`
// so the `commands`/`compression_events` rows the spawned process writes
// can be joined back to the OTel tool_result/prompt that caused them
// (report docs/reports/2026-08-26-tooluse-join-feasibility.md §5). Each id
// is independent — a payload missing one still gets the other(s) attached.

// Only an id shaped like this is trusted enough to interpolate into a
// shell command line. Anything else (empty, the "default" no-id sentinel
// used elsewhere in this hook, or something with shell metacharacters) is
// left unattached — tkr's own fallback still applies, so refusing here
// only forgoes the fix for that one id, never breaks the command. Verified
// admissible for real tool_use_id values: SAFE_SID already matches
// `toolu_012pUuAJ4A8Yq1vHj1aezfav` unchanged.
const SAFE_SID = /^[A-Za-z0-9_-]+$/;

// Matches the start of a `tkr` invocation inside a (possibly compound)
// rewritten command: an optional compound-command separator (&&, ||, ;) —
// or the start of the string — followed by optional env-var assignments or
// `sudo`, then the literal `tkr` token. Mirrors
// internal/rewrite/engine.go's envPrefixPattern so every segment of a
// compound rewrite (`cd /x && tkr git status`) gets the flag, not just a
// leading one.
//
// Deliberately does NOT split on `|` (pipe) — RewriteCommand only treats
// &&/||/; as compound-command boundaries; a pipe stage is not an
// independent invocation.
const RW_SEGMENT_START =
  /(^|&&|\|\||;)(\s*)((?:sudo\s+|(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|\S+)\s+)*))tkr(?=\s|$)/g;

// injectSessionID inserts `--session-id <sid>` right after every `tkr`
// token that starts a command segment in `rewritten`. Returns `rewritten`
// unchanged when `sid` is missing or unsafe, or `rewritten` is not a
// non-empty string.
function injectSessionID(rewritten, sid) {
  return injectIDs(rewritten, { sid });
}

// injectIDs generalizes injectSessionID (#584) to also attach
// `--tool-use-id` and `--prompt-id`, each independently: any of `sid`,
// `toolUseId`, `promptId` may be omitted or unsafe without affecting the
// others. Flags are emitted in a fixed order (session, tool-use, prompt)
// so the attached string is deterministic. Returns `rewritten` unchanged
// when it is not a non-empty string, or when none of the three ids are
// safe to attach.
function injectIDs(rewritten, ids) {
  if (typeof rewritten !== "string" || rewritten === "") return rewritten;
  const { sid, toolUseId, promptId } = ids || {};

  const parts = [];
  if (typeof sid === "string" && SAFE_SID.test(sid)) {
    parts.push(`--session-id ${sid}`);
  }
  if (typeof toolUseId === "string" && SAFE_SID.test(toolUseId)) {
    parts.push(`--tool-use-id ${toolUseId}`);
  }
  if (typeof promptId === "string" && SAFE_SID.test(promptId)) {
    parts.push(`--prompt-id ${promptId}`);
  }
  if (parts.length === 0) return rewritten;

  const flags = parts.join(" ");
  return rewritten.replace(
    RW_SEGMENT_START,
    (_match, sep, ws, prefix) => `${sep}${ws}${prefix}tkr ${flags}`,
  );
}

module.exports = { injectSessionID, injectIDs, SAFE_SID };
