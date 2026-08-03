#!/usr/bin/env node
// Tests for hooks/keepalive/resolve-python.sh — the shared Python resolver
// that skips Windows Store "App Execution Alias" stubs (INV-029).
//
// Regression: on Windows, `python3` resolves to a stub under
// %LOCALAPPDATA%/Microsoft/WindowsApps. `command -v python3` succeeds on it,
// so the old `|| python` fallback never fired, and exec'ing the stub (with
// piped stdin) blocked until killed — stalling the keepalive watcher.
// tkr_resolve_python now skips any candidate whose path is under WindowsApps
// and falls through to the next interpreter.
//
// The `command` builtin is shadowed by a test function so cases need no real
// python on PATH (full-interpreter spawns are flaky on Windows git-bash).
//
// Run: node --test hooks/keepalive/resolve-python.test.js

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RESOLVER = path.join(__dirname, "resolve-python.sh").replace(/\\/g, "/");

function findBash() {
  const probe = spawnSync("bash", ["-c", "exit 0"]);
  return probe.error ? null : "bash";
}
const BASH = findBash();

// Resolve with a shadowed `command` builtin. `paths` maps an interpreter name
// to the fake path `command -v` should report (omit a name to make it
// "not found" → return 1). `tkrPython` sets $TKR_PYTHON.
function resolve(paths, tkrPython) {
  const map = Object.entries(paths)
    .map(([k, v]) => `P_${k}='${v}'; `)
    .join("");
  const script =
    map +
    // Shadow `command`: $1 is "-v", $2 is the candidate name. Echo its mapped
    // path or return 1 (not found).
    `command() { local v="P_$2"; [ -n "\${!v:-}" ] && printf '%s\\n' "\${!v}" || return 1; }; ` +
    `export -f command; ` +
    `. "${RESOLVER}"; ` +
    `tkr_resolve_python`;
  const env = { ...process.env };
  if (tkrPython !== undefined) env.TKR_PYTHON = tkrPython;
  else delete env.TKR_PYTHON;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8", timeout: 5000, env });
  return (r.stdout || "").trim();
}

const WINAPPS =
  "/c/Users/x/AppData/Local/Microsoft/WindowsApps/python3";
const REAL3 = "/usr/bin/python3";
const REAL = "/usr/bin/python";

test("both real → python3 preferred", { skip: !BASH }, () => {
  assert.equal(resolve({ python3: REAL3, python: REAL }), "python3");
});

test("python3 is WindowsApps stub → falls through to python", { skip: !BASH }, () => {
  assert.equal(resolve({ python3: WINAPPS, python: REAL }), "python");
});

test("both WindowsApps stubs → python3 fallback (fail visibly, don't hang)", { skip: !BASH }, () => {
  assert.equal(
    resolve({ python3: WINAPPS, python: WINAPPS.replace(/python3$/, "python") }),
    "python3"
  );
});

test("python3 absent → python", { skip: !BASH }, () => {
  assert.equal(resolve({ python: REAL }), "python");
});

test("neither present → python3 fallback", { skip: !BASH }, () => {
  assert.equal(resolve({}), "python3");
});

test("TKR_PYTHON honored first when real", { skip: !BASH }, () => {
  assert.equal(resolve({ mypy: "/opt/py/mypy", python3: REAL3 }, "mypy"), "mypy");
});

test("TKR_PYTHON pointing at WindowsApps stub is skipped", { skip: !BASH }, () => {
  assert.equal(
    resolve({ mypy: WINAPPS.replace(/python3$/, "mypy"), python3: REAL3 }, "mypy"),
    "python3"
  );
});
