// Bash output compression paths:
//   1. tkr search output: strip internal JSON fields (chunk_id, score, trust_tier)
//   2. Other Bash output: pipe through `tkr filter-stdin "command"` for TOML matching
// Plus the shared extractToolText helper used by every dispatch path.

const { tkrSpawnSync } = require("./tkr-spawn");

// Strip internal fields from tkr search JSON output
function stripSearchInternals(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return text;

    const cleaned = parsed.map((r) => {
      const out = {};
      if (r.doc_id) out.doc_id = r.doc_id;
      if (r.heading) out.heading = r.heading;
      if (r.snippet) out.snippet = r.snippet;
      if (r.trust_level) out.trust_level = r.trust_level;
      if (r.start_line) out.start_line = r.start_line;
      if (r.end_line) out.end_line = r.end_line;
      if (r.conflicts && r.conflicts.length) out.conflicts = r.conflicts;
      if (r.also_in && r.also_in.length) out.also_in = r.also_in;
      return out;
    });
    return JSON.stringify(cleaned);
  } catch {
    return text;
  }
}

// Pipe stdout through tkr filter-stdin for TOML filter matching.
// H-14: tkrSpawnSync = spawnSync + SIGKILL + 10MB maxBuffer (no shell).
// Previous execFileSync used SIGTERM on timeout which is a no-op on Windows.
function tryFilterStdin(command, stdout) {
  try {
    return tkrSpawnSync(["filter-stdin", command], {
      input: stdout,
      timeout: 5000,
    });
  } catch {
    // Exit 1 = no filter match, or tkr not available — passthrough
    return null;
  }
}

function extractToolText(event) {
  const response = event.tool_response || {};
  if (typeof response.stdout === "string") {
    return { field: "stdout", text: response.stdout };
  }
  if (typeof response.output === "string") {
    return { field: "output", text: response.output };
  }
  if (typeof response.content === "string") {
    return { field: "content", text: response.content };
  }
  if (Array.isArray(response.content)) {
    const parts = response.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return {
        field: "content",
        text: parts.join("\n\n"),
        asArray: true,
      };
    }
  }
  return null;
}

module.exports = { stripSearchInternals, tryFilterStdin, extractToolText };
