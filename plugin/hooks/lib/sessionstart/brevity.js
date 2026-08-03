// Brevity mode read + flag write + session-start activation section.
//
// SessionStart is the authoritative source for the mode label; TKR.md
// (CLAUDE.md-priority) carries the persistent rules, and per-turn
// reinforcement is handled by UserPromptSubmit and PostToolUse hooks.
// This module only emits the short activation line at session start.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

// Mode bodies live in hooks/data/sessionstart/brevity-sections.json.
const BREVITY_SECTIONS = Object.freeze(
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "data", "sessionstart", "brevity-sections.json"),
      "utf8",
    ),
  ),
);

function getBrevityMode() {
  try {
    const flagPath = path.join(stateDir(), "brevity-mode");
    return fs.readFileSync(flagPath, "utf8").trim();
  } catch {
    return "full"; // default to full brevity when no state file exists
  }
}

// Write flag file so statusline and other tools can read the active mode.
// Caveman lesson: flag file must exist for the feedback loop to work.
function writeBrevityFlag(mode) {
  try {
    const dir = stateDir();
    const flagPath = path.join(dir, "brevity-mode");
    fs.mkdirSync(dir, { recursive: true });
    if (mode && mode !== "off") {
      fs.writeFileSync(flagPath, mode);
    } else {
      try { fs.unlinkSync(flagPath); } catch {}
    }
  } catch {
    // Best-effort — don't block session start
  }
}

function loadBrevitySection(mode) {
  if (!mode || mode === "off") return "";

  const VALID_LEVELS = new Set(["lite", "full", "ultra"]);
  const effectiveMode = VALID_LEVELS.has(mode) ? mode : "full";
  const body = BREVITY_SECTIONS[effectiveMode] || BREVITY_SECTIONS.full;

  return (
    `\n**Brevity mode: ${effectiveMode}.** ${body}\n` +
    "Auto-clarity: brevity suspends for security warnings, irreversible actions, and confused users."
  );
}

// gate(ctx) — pure decision (Phase 2b contract).
//   ctx.mode: resolved brevity mode (preloaded via getBrevityMode())
function gate(ctx) {
  const mode = ctx && ctx.mode;
  return !!mode && mode !== "off";
}

// body(ctx) — pure given ctx.mode. Delegates to loadBrevitySection.
function body(ctx) {
  return loadBrevitySection(ctx && ctx.mode);
}

module.exports = {
  gate,
  body,
  getBrevityMode,
  writeBrevityFlag,
  loadBrevitySection,
};
