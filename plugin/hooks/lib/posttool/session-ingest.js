// Session-ingest of large grep/curl/WebFetch outputs into the per-session
// index, replacing the inline body with a digest so the model gets a
// compact reference instead of multi-MB content.

const { tkrSpawnSync } = require("./tkr-spawn");

const SESSION_INGEST_MIN_BYTES = 8 * 1024;

// mcp__<server>__<tool> — label by server so a digest names the connector it
// came from; the full tool name still reaches telemetry at the call site.
function mcpIngestLabel(toolName) {
  const slug = String(toolName).split("__")[1] || "";
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean ? `mcp-${clean}` : "mcp";
}

function detectSessionIngestLabel(event, command) {
  const name = event.tool_name || "";
  if (name === "WebFetch") return "webfetch";
  // Session-ingest fires at post-tool-call.js:280, BEFORE the non-Bash gate
  // at :309 — so this is the only path on which oversized MCP output can be
  // digested. Recoverable via the per-session index rather than capped away.
  if (name.startsWith("mcp__")) {
    // Same reason the Bash branch skips `tkr search`: indexing the index's
    // own results is circular.
    if (name.endsWith("__tkr_search")) return null;
    return mcpIngestLabel(name);
  }
  if (name !== "Bash") return null;
  if (/^\s*tkr\s+search\b/.test(command)) return null;
  if (/(^|\s)(?:tkr\s+)?grep\b/.test(command)) return "bash-grep";
  if (/(^|\s)(?:tkr\s+)?curl\b/.test(command)) return "bash-curl";
  return null;
}

function trySessionIngest(sessionID, label, text) {
  // H-14: tkrSpawnSync = spawnSync + SIGKILL + 10MB maxBuffer.
  try {
    return tkrSpawnSync(
      ["ingest", "--source", `session:${sessionID}`, "--type", "session", "--label", label],
      { input: text, timeout: 3000 },
    );
  } catch {
    return null;
  }
}

module.exports = {
  detectSessionIngestLabel,
  trySessionIngest,
  SESSION_INGEST_MIN_BYTES,
};
