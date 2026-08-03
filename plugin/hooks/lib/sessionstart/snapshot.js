// Load snapshot XML for session_id via `tkr session load-snapshot`.
// Returns the XML string, or "" if absent or tkr unavailable.
// M-01: spawnSync + SIGKILL on timeout (execFileSync sent SIGTERM = no-op on
// Windows). 10MB maxBuffer cap. Empty string on any error.

const { spawnSync } = require("child_process");

function loadSnapshotXML(sid) {
  try {
    const res = spawnSync("tkr", ["session", "load-snapshot", sid], {
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (res.error || res.signal || (typeof res.status === "number" && res.status !== 0)) {
      return "";
    }
    return (res.stdout || "").trim();
  } catch {
    return "";
  }
}

module.exports = { loadSnapshotXML };
