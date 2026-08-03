// Sweep stale per-session statusline payloads on SessionStart.
//
// The per-session file `$TMPDIR/claude-statusline-<slug>-<sid>.json`
// is normally deleted by the Stop hook at session end. Crashed sessions
// (kill -9, IDE close without graceful shutdown, hook timeout, etc.)
// leave the file behind. This sweep prunes them so $TMPDIR doesn't
// accumulate one file per crashed session over the project's lifetime.
//
// Policy: delete files whose basename starts with the per-project
// prefix AND whose mtime is older than STALE_MS. Conservative cutoff so
// a long-idle but valid session isn't pruned mid-flight (24h is well
// past any reasonable single-session lifetime).
//
// Best-effort throughout. Never throws — SessionStart cannot afford to
// fail on tidiness work.

"use strict";

const fs = require("fs");
const path = require("path");
const {
  getTelemetryGlobPrefix,
  getTelemetryDir,
  slugifyCwd,
} = require("../statusline-path");

const STALE_MS = 24 * 60 * 60 * 1000; // 24h

function sweepStaleStatuslineFiles(now = Date.now(), staleMs = STALE_MS) {
  const dir = getTelemetryDir();
  const prefix = getTelemetryGlobPrefix();
  // Orphan from pre-per-session-scoping tkr versions. Nothing writes here
  // anymore, but a stale copy on disk gets read by any sid-less caller
  // (manual `tkr signals`, hooks that miss the env export) and serves
  // wildly-wrong pressure values. Delete unconditionally — if a future
  // version reinstates per-project scoping it can re-create the file.
  // See 2026-05-25 "stale 70% pressure" fix.
  const legacyOrphan = path.join(
    dir,
    "claude-statusline-" + slugifyCwd(process.cwd()) + ".json"
  );
  let removed = 0;
  try {
    fs.unlinkSync(legacyOrphan);
    removed++;
  } catch {
    // missing or locked — fine; this is best-effort cleanup
  }

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < staleMs) continue;
    try {
      fs.unlinkSync(full);
      removed++;
    } catch {
      // file may be locked by another process — skip
    }
  }
  return removed;
}

module.exports = { sweepStaleStatuslineFiles, STALE_MS };
