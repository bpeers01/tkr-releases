// hooks/lib/sessionstart/version-ledger.js
//
// Appends one row per (session_id, tkr_version, UTC-day) to
// ~/.tkr/version-ledger.jsonl (honors TKR_STATE_DIR).
//
// Row shape:
//   {"session_id":"<id>","first_seen":"<RFC3339>","tkr_version":"<vX.Y.Z>"}
//
// Dedup key: (session_id, tkr_version, UTC calendar day from first_seen).
// Matches proposal §3 "UTC bucketing throughout".  A session that crosses
// midnight (UTC) produces two rows — acceptable per spec §5.
//
// Best-effort: any failure is swallowed; SessionStart hot path must never
// fail because of telemetry.
//
// Kill switch: TKR_VERSION_LEDGER_DISABLED=1
// Master kill switch (TKR_HOOKS_DISABLED=1) is enforced upstream in
// session-start.js before runMain is called — not duplicated here.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { stateDir } = require("../state-dir");
const { rotateIfLarge } = require("../rotate-jsonl");

function ledgerPath() {
  return path.join(stateDir(), "version-ledger.jsonl");
}

// Resolve the tkr binary version by shelling out. Bounded to 1 s; on any
// failure returns null and the caller skips. Returns the trimmed version
// string (e.g. "v5.0.0" or "dev").
//
// TKR_VERSION env override is checked first so tests avoid spawning the
// real binary.
function resolveTkrVersion() {
  if (process.env.TKR_VERSION) return process.env.TKR_VERSION;
  try {
    const r = spawnSync("tkr", ["--version"], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return null;
    // Format: "tkr <version>\n"
    const m = r.stdout.trim().match(/^tkr\s+(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// alreadyLogged scans the ledger file for a row matching the dedup key
// (session_id, tkr_version, UTC-day). Scans from the end since recent rows
// are most likely to match. Returns true if a matching row exists.
function alreadyLogged(filePath, sessionID, tkrVersion, utcDay) {
  let data;
  try {
    data = fs.readFileSync(filePath, "utf8");
  } catch {
    return false; // file doesn't exist yet
  }
  const lines = data.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed rows
    }
    if (parsed.session_id !== sessionID) continue;
    if (parsed.tkr_version !== tkrVersion) continue;
    // first_seen is RFC3339 (UTC ISO). Slice YYYY-MM-DD prefix for UTC-day.
    const day = (parsed.first_seen || "").slice(0, 10);
    if (day === utcDay) return true;
  }
  return false;
}

// appendVersionLedger is the public entry point. Called from session-start.js
// on every session start. Best-effort — never throws.
function appendVersionLedger(sessionID) {
  if (process.env.TKR_VERSION_LEDGER_DISABLED === "1") return;
  if (!sessionID) return;
  try {
    const tkrVersion = resolveTkrVersion();
    if (!tkrVersion) return;

    const now = new Date();
    const utcDay = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC

    const filePath = ledgerPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (alreadyLogged(filePath, sessionID, tkrVersion, utcDay)) return;

    // Rotate before append per hot-path JSONL writer rule (hooks/CLAUDE.md).
    rotateIfLarge(filePath);

    const row = {
      session_id: sessionID,
      first_seen: now.toISOString(),
      tkr_version: tkrVersion,
    };
    fs.appendFileSync(filePath, JSON.stringify(row) + "\n");
  } catch {
    // best-effort
  }
}

module.exports = { appendVersionLedger, ledgerPath, resolveTkrVersion };
