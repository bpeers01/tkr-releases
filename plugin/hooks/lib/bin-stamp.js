// hooks/lib/bin-stamp.js
//
// INV-136: one-line physical identity for the tkr binary a hook would
// spawn, so a hook can decide whether a cached answer ABOUT that binary is
// still valid without paying a spawn to ask.
//
// Motivation: SessionStart blocks on `tkr --version` every session to write
// one ledger row. A process spawn is not free — measured 0.65s on an idle
// developer box and 2.2s under multi-session load, against this zone's
// <100ms hot-path budget (hooks/CLAUDE.md). The version of a binary that has
// not changed on disk cannot itself have changed, so the spawn is pure waste
// on every session after the first.
//
// Returns "<realpath>|<size>|<mtimeMs>", or null when identity cannot be
// established — no binary found, or a JS launcher, which `node` runs on top
// of a DIFFERENT Go binary underneath (see resolveTkrExe's contract).
//
// Null is never "unchanged". A caller that cannot stamp must fall back to
// asking the binary directly, never to trusting a cache it cannot key.
//
// mtimeMs is floored to whole milliseconds: the float carries sub-ms
// precision that does not survive a JSON round-trip identically on every
// platform, and a stamp that fails to compare equal to itself would disable
// the cache silently rather than loudly.

"use strict";

const fs = require("fs");
const { resolveTkrExe } = require("./tkr-bin");

function binStamp(env = process.env) {
  try {
    const exe = resolveTkrExe(env);
    if (!exe) return null;
    const st = fs.statSync(exe);
    if (!st.isFile()) return null;
    return `${exe}|${st.size}|${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

module.exports = { binStamp };
