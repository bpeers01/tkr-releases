"use strict";

// INV-083 — JS-side mirror of internal/route/source.go's discriminator.
//
// Every prompt used to get classified identically, including text no
// user ever typed: a bare slash command, or Claude Code's own
// system-injected envelope (a background task-completion notification,
// a Stop-hook keepalive ping). A row for text nobody typed can never
// "want a route", so it entered the natural-rate denominator as an
// indistinguishable refusal and depressed it toward zero.
//
// isSystemEnvelope is what lets the hook skip `tkr route classify`
// entirely for envelope prompts — the biggest win, since it removes the
// hot-path cost, not just the tag. The Go binary derives the SAME value
// independently (internal/route.ClassifySource) when a caller does not
// pass --source explicitly, so the two sides can drift on WHEN they skip
// without ever disagreeing on WHAT counts as an envelope, as long as
// both regexes are kept in sync — see route.IsSystemEnvelope's doc
// comment, which names this file as its JS counterpart.

// ENVELOPE_TAG_RE matches Claude Code's own system-injected envelopes at
// the START of the (trimmed) prompt. Leading-tag only, same convention
// as slash-marker.js's COMMAND_TAG_RE.
const ENVELOPE_TAG_RE = /^<(task-notification|system-reminder)\b/i;

// isSystemEnvelope reports whether prompt is Claude Code's own
// system-injected text rather than something a user typed.
function isSystemEnvelope(prompt) {
  if (typeof prompt !== "string") return false;
  return ENVELOPE_TAG_RE.test(prompt.trim());
}

module.exports = {
  ENVELOPE_TAG_RE,
  isSystemEnvelope,
};
