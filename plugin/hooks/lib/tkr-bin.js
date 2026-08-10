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

// ── Physical identity ───────────────────────────────────────────────────────
//
// resolveTkrBin answers "what do I type to spawn tkr", which is a COMMAND
// STRING and deliberately allows the bare "tkr" PATH fallback. That is the
// wrong question for identity: the resident runtime (#209) records
// os.Executable() — a physical path — and a client has to decide whether the
// runtime it found is running the same binary it would otherwise have
// spawned.
//
// Naively resolving the command string breaks exactly the PATH-only install:
// path.resolve("tkr") is cwd-relative, so it produces "<cwd>/tkr", never
// matches, and the client rejects a perfectly good runtime forever — while
// still firing a lazy start every 5s, which is worse than not having the
// feature at all.
//
// resolveTkrExe answers the identity question instead, and returns null when
// it cannot be answered. Null is not "no tkr"; it is "identity unverifiable",
// and the only safe response to that is to skip the resident path entirely
// (do not connect, do not start).

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// whichFromPath is the PATH search the OS would do for a bare command name.
// Honors PATHEXT on Windows, where "tkr" on PATH means tkr.exe (or .cmd/.bat,
// which resolveTkrExe rejects further down — see below).
function whichFromPath(name, env) {
  const raw = env.PATH || env.Path || "";
  if (!raw) return null;
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here — keep looking
      }
    }
  }
  return null;
}

// samePhysicalPath compares two resolved paths. Windows paths are
// case-insensitive, and realpath does not always agree with a recorded path on
// casing, so the comparison is case-folded there and exact everywhere else.
function samePhysicalPath(a, b) {
  if (!a || !b) return false;
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// resolveTkrExe returns the absolute, symlink-resolved path of the tkr
// executable this hook would spawn, or null when that cannot be established.
//
// Null cases, both deliberate:
//
//   - No tkr found at an explicit TKR_BIN, a standard install location, or on
//     PATH. Nothing to be identical to.
//   - The resolved binary is a JS launcher (.js/.cjs/.mjs). tkrSpawnArgv runs
//     those as `node <launcher>`, so the thing that ends up being the resident
//     runtime is whatever Go binary the launcher eventually execs — a
//     DIFFERENT file from the one named here. The launcher's path and
//     os.Executable() can never match, and pretending otherwise would either
//     reject every runtime forever or, worse, require trusting a path we did
//     not verify. `.claude-plugin/plugin.json` really does point Claude Code
//     at bin/tkr-launcher.js, so this is a shape that ships. Skipping the
//     resident path there costs an optimization and keeps the guarantee.
function resolveTkrExe(env = process.env) {
  const bin = resolveTkrBin(env);
  if (/\.(c|m)?js$/i.test(bin)) return null;
  const located = bin === "tkr" ? whichFromPath("tkr", env) : bin;
  if (!located) return null;
  return realpathOrNull(located);
}

module.exports = { resolveTkrBin, tkrSpawnArgv, resolveTkrExe, samePhysicalPath };
