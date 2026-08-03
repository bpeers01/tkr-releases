// hooks/lib/session-id.js
//
// Single source of truth for the per-session id used as a suffix on
// state files (cache-bust-<sid>.json, l5-state-<sid>.json, etc.).
//
// Resolution chain — must match across hooks so the file a writer
// creates is the file a reader opens. Drift here causes silent
// cross-session state collisions (see issue #15 cache-bust-warn drift
// and the session-summary sid-keying bug noted in the 2026-05-16
// continue-here).
//
//   1. transcript_path UUID — the most stable id Claude Code emits.
//      Filename is `<session_id>.jsonl`; extracted via regex.
//   2. event.session_id / event.sessionId — present on every real
//      hook payload, but absent in synthesized test stdin.
//   3. TKR_SESSION_ID env var — escape hatch for tests + manual runs.
//   4. pid-<ppid> — last-resort stable-within-process fallback.
//
// Mirrors session-helpers.mjs on the ESM side (kept CJS for hooks).

"use strict";

const UUID_RE = /([a-f0-9-]{36})\.jsonl$/i;

function getSessionID(event) {
  if (event && event.transcript_path) {
    const m = String(event.transcript_path).match(UUID_RE);
    if (m) return m[1];
  }
  if (event && event.session_id) return String(event.session_id);
  if (event && event.sessionId) return String(event.sessionId);
  if (process.env.TKR_SESSION_ID) return process.env.TKR_SESSION_ID;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return `pid-${process.ppid}`;
}

module.exports = { getSessionID };
