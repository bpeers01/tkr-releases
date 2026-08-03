"use strict";

// Per-turn record of "the user typed a slash command", so the skill
// ledger can tell a MANUAL invocation from an AUTO trigger.
//
// ── Why the ledger could not tell before ─────────────────────────────
//
// hooks/skill-invoked.js writes invocation_source: "unknown" on every
// row, and has since it shipped. The comment there explains why: the
// authoritative signal is the `<command-name>` marker on the PRIOR
// turn, deriving it means parsing the session transcript, and a
// transcript scan does not fit the hook's <10ms p95 budget.
//
// That leaves the only durable record of skill usage unable to answer
// the one question it exists for. "The skill fired 40 times" is not a
// trigger measurement if 40 of those were the user typing /foo — and
// scripts/ctx-audit.py has to fall back to parsing transcripts precisely
// because the ledger cannot say.
//
// ── Why write-time beats a read-time join ────────────────────────────
//
// The read-time join is the pattern this codebase uses elsewhere (see
// internal/signals/outcomes.go, which attributes plans at read time and
// explains why). It is the right shape when the inputs are two durable
// ledgers. Here one input is the session transcript, which rotates and
// is eventually gone, so a read-time join answers the question only
// while the evidence survives — and the ledger is supposed to be the
// thing that outlives it.
//
// UserPromptSubmit already holds the raw prompt. A prompt beginning
// with `/` IS the signal, no transcript involved, and recording it costs
// one small write on the rare turns where it happens.
//
// ── Scoping ──────────────────────────────────────────────────────────
//
// The marker is keyed to the prompt that produced it. A skill invoked
// two turns later must not read a stale marker and call itself manual,
// so the reader requires the prompt id to match and applies a short TTL
// as a backstop for when Claude Code supplies no id.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("./state-dir");

// MARKER_TTL_MS bounds a marker with no prompt id to match against.
// Deliberately short: a slash command and the Skill dispatch it causes
// are the same turn, milliseconds apart. Anything older is a different
// turn and must not be credited.
const MARKER_TTL_MS = 60 * 1000;

// A slash command name: what Claude Code accepts after "/". Plugin
// skills can carry a `plugin:skill` form, so ":" is allowed.
const SLASH_RE = /^\/([a-zA-Z0-9_:-]{1,64})\b/;

function markerPath(sid) {
  const safe = sid && !/[/\\]/.test(sid) && !sid.includes("..") ? sid : "default";
  return path.join(stateDir(), `slash-marker-${safe}.json`);
}

// parseSlashCommand returns the command name a prompt invokes, or "".
//
// Only a prompt that STARTS with the slash counts. "run /release when
// you're done" is prose about a command, not an invocation of one, and
// treating it as manual would misattribute an auto-trigger that happened
// to be discussed.
function parseSlashCommand(prompt) {
  if (typeof prompt !== "string") return "";
  const m = SLASH_RE.exec(prompt.trim());
  if (!m) return "";
  // Normalize a plugin-qualified name to its bare skill: the Skill tool
  // reports `compress`, the user may type `/tkr:compress`.
  const name = m[1];
  const colon = name.lastIndexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

// recordSlashCommand writes the marker when prompt is a slash command.
// No-ops otherwise, so ordinary prompts pay one regex and no I/O.
function recordSlashCommand(prompt, sid, promptID) {
  try {
    // The marker exists only to attribute rows in the skill ledger, so
    // it follows that ledger's switch. Writing markers nobody will read
    // would be pure cost. TKR_HOOKS_DISABLED is handled upstream by the
    // hook entry points before this is ever reached.
    if (process.env.TKR_SKILL_AUDIT_DISABLED === "1") return "";
    const name = parseSlashCommand(prompt);
    if (!name) return "";
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = markerPath(sid);
    const tmp = target + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({ name, prompt_id: promptID || "", ts: Date.now() })
    );
    fs.renameSync(tmp, target);
    return name;
  } catch {
    // Telemetry attribution never blocks a prompt.
    return "";
  }
}

// resolveInvocationSource returns "manual" | "auto" for a skill
// dispatch.
//
// Returns "auto" when no marker matches — NOT "unknown". By this point
// the question has been asked and answered: a Skill dispatch on a turn
// whose prompt was not a slash command for this skill is an auto
// trigger. "unknown" was the honest answer while nothing could tell;
// keeping it now would hide a real measurement behind a stale hedge.
//
// The one case that still deserves "unknown" is a failure to read at
// all, which the caller distinguishes by passing through the "" return.
function resolveInvocationSource(skillName, sid, promptID, now) {
  try {
    if (!skillName) return "";
    const raw = fs.readFileSync(markerPath(sid), "utf8");
    const m = JSON.parse(raw);
    if (!m || typeof m.name !== "string") return "auto";
    if (m.name !== skillName) return "auto";
    // A prompt id on both sides is an exact turn match and is trusted
    // outright. Disagreeing ids mean a later turn, never this one.
    if (promptID && m.prompt_id) {
      return promptID === m.prompt_id ? "manual" : "auto";
    }
    const age = (now || Date.now()) - (typeof m.ts === "number" ? m.ts : 0);
    return age >= 0 && age <= MARKER_TTL_MS ? "manual" : "auto";
  } catch {
    // No marker file is the common case — most turns are not slash
    // commands — and it means auto, not a read failure.
    return "auto";
  }
}

module.exports = {
  MARKER_TTL_MS,
  markerPath,
  parseSlashCommand,
  recordSlashCommand,
  resolveInvocationSource,
};
