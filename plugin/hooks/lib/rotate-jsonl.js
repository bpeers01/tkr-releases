// hooks/lib/rotate-jsonl.js
//
// Wave 4 (M-11): rotate JSONL append-only state files at a size cap.
// Single-generation rotation: path → path+".1" (overwriting any prior
// .1), then a fresh path. Simple, predictable, no growth bound issue.
//
// Best-effort: any error is swallowed so a full disk cannot crash a
// hook's hot path. Callers invoke rotateIfLarge BEFORE their own
// appendFileSync so the next append lands in the fresh file.
//
// Default cap: 10 MB. Override per call.

"use strict";

const fs = require("fs");

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function rotateIfLarge(filePath, maxBytes) {
  if (!filePath) return;
  const cap = Number.isFinite(maxBytes) && maxBytes > 0
    ? maxBytes
    : DEFAULT_MAX_BYTES;
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return; // file doesn't exist → nothing to rotate
  }
  if (size < cap) return;
  // RENAME ONLY — no rm first, deliberately. Some of these ledgers
  // (decisions.jsonl) have a second, independent rotator in the Go binary
  // with no shared lock, and remove-then-rename lets the two destroy each
  // other's work: A renames live -> .1, B removes the .1 A just created,
  // B's rename then finds no source and fails. A whole generation gone,
  // silently, from a file that exists to be an audit trail.
  //
  // renameSync replaces an existing target atomically on POSIX and on
  // Windows (MoveFileExW with MOVEFILE_REPLACE_EXISTING), so the rm bought
  // nothing and cost exactly that race. Concurrent rotation now degrades
  // correctly: first one wins, second finds no source and no-ops.
  try {
    fs.renameSync(filePath, filePath + ".1");
  } catch {
    // ignore — next append will start at current size
  }
}

module.exports = { rotateIfLarge, DEFAULT_MAX_BYTES };
