// hooks/lib/tkr-bin.js
//
// One resolver for "which tkr do I spawn, and how", shared by every hook
// that shells out to the binary.
//
// Resolution order (unchanged from tkr-rewrite.js's original
// findTkrBinary, which this replaces):
//   1. $TKR_BIN — an explicit override always wins.
//   2. The platform's standard install location, probed for existence.
//   3. Bare "tkr", resolved through PATH by the OS.
//
// ── The JS entry point ──────────────────────────────────────────────────
//
// A resolved path ending in .js/.cjs/.mjs is launched as `node <path>
// <args...>` rather than executed directly. This is not a test affordance:
// `.claude-plugin/plugin.json` already points Claude Code at
// `bin/tkr-launcher.js` for the MCP server, so "TKR_BIN names a JS
// launcher" is a shape this project already ships.
//
// It also happens to be the only shim mechanism that works on BOTH
// platforms, which is why the veto tests can now run everywhere (#143
// finding 1). The previous mechanism — put an extensionless `#!/bin/sh`
// file named `tkr` first on PATH — is POSIX-only by construction: without
// `shell: true`, Node's child_process resolves a bare command name only to
// .exe/.com on Windows, never .cmd/.bat (and modern Node refuses .cmd/.bat
// without a shell outright). So on Windows those tests could not execute
// their own shim, and the three that assert "no deny happened" passed
// vacuously — they would have kept passing with the veto deleted.
//
// Callers must spawn through tkrSpawnArgv() rather than passing the
// resolved path straight to spawnSync/execFileSync; otherwise the .js case
// silently becomes "exec a text file", which fails as ENOEXEC/EACCES and —
// on a fail-open path like the veto — is indistinguishable from a clean
// allow.

"use strict";

const fs = require("fs");
const path = require("path");

function resolveTkrBin(env = process.env) {
  const candidates = [];
  if (env.TKR_BIN) candidates.push(env.TKR_BIN);

  const home = env.HOME || env.USERPROFILE || "";
  if (process.platform === "win32") {
    if (home) candidates.push(path.join(home, ".local", "bin", "tkr.exe"));
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, "tkr", "bin", "tkr.exe"));
    }
  } else if (home) {
    candidates.push(path.join(home, ".local", "bin", "tkr"));
  }

  candidates.push("tkr");
  for (const candidate of candidates) {
    if (candidate === "tkr") return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore candidate probe failures
    }
  }
  return "tkr";
}

// tkrSpawnArgv maps tkr-level arguments onto the {cmd, argv} pair the
// child_process family actually takes, applying the JS-entry-point rule.
// Pass the result straight through: spawnSync(cmd, argv, opts).
function tkrSpawnArgv(args, env = process.env) {
  const bin = resolveTkrBin(env);
  if (/\.(c|m)?js$/i.test(bin)) {
    return { cmd: process.execPath, argv: [bin, ...args], bin };
  }
  return { cmd: bin, argv: [...args], bin };
}

module.exports = { resolveTkrBin, tkrSpawnArgv };
