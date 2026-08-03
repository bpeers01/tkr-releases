// Session-ingest of large grep/curl/WebFetch outputs into the per-session
// index, replacing the inline body with a digest so the model gets a
// compact reference instead of multi-MB content.

const { tkrSpawnSync } = require("./tkr-spawn");

const SESSION_INGEST_MIN_BYTES = 8 * 1024;

function detectSessionIngestLabel(event, command) {
  if (event.tool_name === "WebFetch") return "webfetch";
  if (event.tool_name !== "Bash") return null;
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
