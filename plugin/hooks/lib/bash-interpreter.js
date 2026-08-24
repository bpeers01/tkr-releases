// hooks/lib/bash-interpreter.js
//
// Resolves the bash interpreter the statusline-* test suites spawn to run
// fragments extracted from hooks/statusline.sh (sigfields, rt-truncate,
// model-persist, mode-resolve).
//
// #399: those suites resolved a bare "bash" via $PATH. On a stock Mac
// that is /bin/bash 3.2.57 — the exact interpreter #379 was about, and
// the reason these suites exist. The moment a Homebrew bash lands on
// $PATH (`brew install bash`, 5.x, earlier in $PATH than /bin), every
// suite silently starts running against a different interpreter: a local
// run of #379's own regression test then passes whether or not the fix
// is present, with no signal that anything changed.
//
// Policy: on darwin, prefer /bin/bash when it exists and is executable —
// that is the system-shipped interpreter on every real Mac, independent
// of whatever else is on $PATH. Everywhere else (Linux CI, Windows),
// resolve "bash" from $PATH as before; there is no equivalent
// always-present fixed path to prefer.
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");

function which(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(finder, [cmd], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return "";
  const first = String(r.stdout || "").split(/\r?\n/)[0].trim();
  return first;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let bashPathCache;

// bashPath returns the resolved bash interpreter path, or "" when none is
// available. Memoized — the answer cannot change within one test process.
function bashPath() {
  if (bashPathCache !== undefined) return bashPathCache;
  if (process.platform === "darwin" && isExecutable("/bin/bash")) {
    bashPathCache = "/bin/bash";
  } else {
    bashPathCache = which("bash");
  }
  return bashPathCache;
}

const versionCache = new Map();

// bashVersion runs `<binPath> -c 'echo "$BASH_VERSION"'` and returns the
// trimmed result, or "" on failure. Memoized per path.
function bashVersion(binPath) {
  if (!binPath) return "";
  if (versionCache.has(binPath)) return versionCache.get(binPath);
  const r = spawnSync(binPath, ["-c", 'echo "$BASH_VERSION"'], {
    encoding: "utf8",
    windowsHide: true,
  });
  const version = r.status === 0 ? String(r.stdout || "").trim() : "";
  versionCache.set(binPath, version);
  return version;
}

// logInterpreter prints which interpreter + version a suite is about to
// run under, once, so a passing run can be read as evidence about a
// SPECIFIC bash rather than "bash, whichever one $PATH answered today".
function logInterpreter(label) {
  const p = bashPath();
  if (!p) {
    console.log(`# ${label}: no bash interpreter found — suite skipped`);
    return;
  }
  console.log(`# ${label}: ${p} (bash ${bashVersion(p) || "unknown version"})`);
}

module.exports = { bashPath, bashVersion, logInterpreter, which };
