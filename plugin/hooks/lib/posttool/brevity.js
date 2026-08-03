// Brevity helpers for PostToolUse.
// SessionStart carries the brevity rules; the legacy per-tool-call
// brevityContext re-anchor was deleted with the V2=0 injection path
// (INV-073, 2026-07-23). What remains: the mode reader and the
// PostToolUse response wrapper.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

function getBrevityMode() {
  try {
    const flagPath = path.join(stateDir(), "brevity-mode");
    return fs.readFileSync(flagPath, "utf8").trim();
  } catch {
    return "full"; // default
  }
}

// PostToolUse requires additionalContext to be nested inside hookSpecificOutput
// with hookEventName set — top-level additionalContext is silently dropped.
// See https://code.claude.com/docs/en/hooks (PostToolUse schema).
function brevityResponse(ctx) {
  if (!ctx) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ctx,
    },
  };
}

module.exports = { getBrevityMode, brevityResponse };
