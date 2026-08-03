// hooks/lib/state-dir.js
//
// Single resolver for the tkr per-user state directory used by hooks.
// Resolution order (matches the inline copy duplicated across ~12 hooks):
//   1. TKR_STATE_DIR env var (test/dev override)
//   2. $HOME/.tkr
//   3. $USERPROFILE/.tkr (Windows)
//   4. os.homedir()/.tkr (Node built-in — avoids a literal "~" dir)
//
// Mirrors the Go side at internal/state/dir.go.

"use strict";

const os = require("os");
const path = require("path");

function stateDir() {
  return (
    process.env.TKR_STATE_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".tkr")
  );
}

module.exports = { stateDir };
