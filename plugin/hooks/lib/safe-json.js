// hooks/lib/safe-json.js
//
// Best-effort JSON read + atomic JSON write used by per-session state
// files. Replaces the inline copies in cache-bust-warn.js,
// long-runner-warn.js, and the bespoke tmp+rename blocks in
// post-tool-call.js / user-prompt-submit.js.
//
// readJSONSync(p) — returns parsed JSON or null on any error. Never
// throws; missing files and corrupt payloads both return null.
//
// writeJSONAtomic(p, obj) — writes JSON via tmp + rename so concurrent
// hook fires can't observe a torn read. Creates parent dir if needed.
// Best-effort: swallows fs errors so a transient write failure can't
// fail an advisory hook.

"use strict";

const fs = require("fs");
const path = require("path");

function readJSONSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJSONAtomic(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath);
  } catch {
    // best-effort
  }
}

module.exports = { readJSONSync, writeJSONAtomic };
