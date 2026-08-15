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
// UserPromptSubmit already holds the raw prompt. A prompt carrying
// Claude Code's `<command-name>` scaffold (see parseCommandTag) IS the
// signal, no transcript involved, and recording it costs one small write
// on the rare turns where it happens.
//
// ── Scoping ──────────────────────────────────────────────────────────
//
// The marker is keyed to the prompt that produced it. A skill invoked
// two turns later must not read a stale marker and call itself manual,
// so the reader requires the prompt id to match and applies a short TTL
// as a backstop for when Claude Code supplies no id.
//
// ── #278: the marker's reader structurally never runs for this case ──
//
// The design above assumes SOMETHING later reads the marker and joins it
// against a Skill-tool dispatch — that "something" is
// resolveInvocationSource(), called from hooks/skill-invoked.js's
// PreToolUse(Skill) handler. #205's live dogfood established that a
// typed slash command that resolves to a skill never dispatches the
// Skill tool at all: Claude Code resolves it natively, so PreToolUse
// never fires and skill-invoked.js never runs. The marker gets written
// correctly and nothing ever reads it — 150 marker files, 0 manual rows.
//
// The marker mechanism and resolveInvocationSource() stay as written:
// they remain correct for the case they were built for (attributing a
// Skill-tool dispatch that DOES fire on the same turn, e.g. a future or
// alternate CC path per docs/spikes/skill-tool-pretooluse-findings.md's
// fallback-path note). But they cannot be the ONLY path, since the
// common case never reaches them. hooks/user-prompt-submit.js now also
// writes the skill-invoked ledger row directly, right here on the turn
// where the tag is observed, instead of leaving it for a reader that
// will never come. See recordManualSkillInvocation() there.

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

// COMMAND_TAG_RE matches Claude Code's expanded turn scaffold for a
// slash-command invocation: `<command-name>/name</command-name>`. This is
// the actual shape a skill-backed slash command arrives in — the expanded
// prompt does not start with a bare "/", it starts with caveat/scaffold
// text and carries this tag somewhere inside it (verified directly against
// a live turn; also the same tag internal/analytics/tool_events.go's
// commandNameRe and internal/rehydrate/extract.go's cmdNameRe already rely
// on to recover an invoked command from a transcript). Checked before
// SLASH_RE below because it is the authoritative signal.
const COMMAND_TAG_RE = /<command-name>\/?(\S+?)<\/command-name>/;

function markerPath(sid) {
  const safe = sid && !/[/\\]/.test(sid) && !sid.includes("..") ? sid : "default";
  return path.join(stateDir(), `slash-marker-${safe}.json`);
}

function normalizePluginQualified(name) {
  // Normalize a plugin-qualified name to its bare skill: the Skill tool
  // reports `compress`, the user may type `/tkr:compress`.
  const colon = name.lastIndexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

// parseCommandTag returns the command name inside a <command-name> tag, or
// "" when absent.
function parseCommandTag(prompt) {
  if (typeof prompt !== "string") return "";
  const m = COMMAND_TAG_RE.exec(prompt);
  if (!m) return "";
  return normalizePluginQualified(m[1]);
}

// parseSlashCommand returns the command name a prompt invokes, or "".
//
// Tries the <command-name> tag first (see COMMAND_TAG_RE) since that is
// what a real skill-backed slash command's expanded prompt actually
// carries. Falls back to a literal leading slash for prompts with no
// scaffold. Either way, "run /release when you're done" is prose about a
// command, not an invocation of one, and treating it as manual would
// misattribute an auto-trigger that happened to be discussed.
function parseSlashCommand(prompt) {
  if (typeof prompt !== "string") return "";
  const tagged = parseCommandTag(prompt);
  if (tagged) return tagged;
  const m = SLASH_RE.exec(prompt.trim());
  if (!m) return "";
  return normalizePluginQualified(m[1]);
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
  parseCommandTag,
  parseSlashCommand,
  recordSlashCommand,
  resolveInvocationSource,
};
