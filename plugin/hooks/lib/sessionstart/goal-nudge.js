// Pinned-goal bullet (#381 item 18) — one capped line surfaced at
// SessionStart when the user has set a durable objective via
// `tkr goal set`. Read-only: no per-prompt reinjection (SessionStart-only
// by design, see hooks/CLAUDE.md), no auto-inference/decay/confidence
// scoring, single goal only. Independent of the session snapshot XML
// (lib/sessionstart/snapshot.js) — that is derived history, this is a
// durable user-set field.

const fs = require("fs");
const path = require("path");

const MAX_GOAL_CHARS = 200;

function goalFilePath(projectPath) {
  return path.join(projectPath, ".tkr", "goal.json");
}

// readGoalText(projectPath) — the raw, untruncated goal text, or "" when
// no goal is set or the file is missing/malformed. Exported for tests.
function readGoalText(projectPath) {
  try {
    const raw = fs.readFileSync(goalFilePath(projectPath), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

// loadGoalBullet(projectPath) — one capped bullet ready to concatenate
// into dynamicState, or "" when no goal is set.
function loadGoalBullet(projectPath) {
  const text = readGoalText(projectPath);
  if (!text) return "";
  return `\n\n**Pinned goal:** ${truncate(text, MAX_GOAL_CHARS)}`;
}

module.exports = { loadGoalBullet, readGoalText, truncate, MAX_GOAL_CHARS };
