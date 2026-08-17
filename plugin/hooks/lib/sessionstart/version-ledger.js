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
const { tkrSpawnArgv } = require("../tkr-bin");
const { binStamp } = require("../bin-stamp");
const { writeJSONAtomic } = require("../safe-json");

function ledgerPath() {
  return path.join(stateDir(), "version-ledger.jsonl");
}

function versionCachePath() {
  return path.join(stateDir(), "version-cache.json");
}

// INV-136: a binary that has not changed on disk cannot have changed its
// version, so the answer is cached against the binary's physical identity
// rather than re-asked every SessionStart. This spawn was one of two that
// blocked every session start; at 0.65-2.2s per spawn on the reporting box
// it dominated a hook budgeted at <100ms.
//
// The cache is keyed, never timed. An upgrade changes size+mtime and so
// misses on the very next session — there is no staleness window in which a
// wrong version could be written to the ledger, which matters because the
// ledger's entire purpose is recording which version ran.
function readCachedVersion(stamp) {
  if (!stamp) return null;
  try {
    const c = JSON.parse(fs.readFileSync(versionCachePath(), "utf8"));
    if (c && c.v === 1 && c.stamp === stamp && typeof c.version === "string" && c.version) {
      return c.version;
    }
  } catch {
    // absent or corrupt — ask the binary
  }
  return null;
}

function writeCachedVersion(stamp, version) {
  if (!stamp || !version) return;
  // INV-136 concurrency fix: tmp+rename so a concurrent SessionStart on this
  // box (routinely 8-12 at once, all sharing one state dir) never observes a
  // truncated/0-byte file mid-write. No lock on top — see graduation-nudge.js
  // for the shared reasoning (idempotent, benign last-write-wins).
  writeJSONAtomic(versionCachePath(), { v: 1, stamp, version });
}

// Resolve the tkr binary version, preferring a cache keyed on the binary's
// identity and falling back to shelling out. Bounded to 1 s; on any failure
// returns null and the caller skips. Returns the trimmed version string
// (e.g. "v5.0.0" or "dev").
//
// TKR_VERSION env override is checked first so tests avoid spawning the
// real binary.
function resolveTkrVersion() {
  if (process.env.TKR_VERSION) return process.env.TKR_VERSION;
  const stamp = binStamp();
  const cached = readCachedVersion(stamp);
  if (cached) return cached;
  try {
    const { cmd, argv } = tkrSpawnArgv(["--version"]);
    const r = spawnSync(cmd, argv, {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return null;
    // Format: "tkr <version>\n"
    const m = r.stdout.trim().match(/^tkr\s+(\S+)/);
    const version = m ? m[1] : null;
    if (version) writeCachedVersion(stamp, version);
    return version;
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
