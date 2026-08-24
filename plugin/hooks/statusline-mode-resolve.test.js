// Tests for the per-session mode-file resolution block in
// hooks/statusline.sh (PLAN-33). Covers AT-PLAN33-7 + AT-PLAN33-9.
//
// Strategy: extract the MODE_FILE resolution snippet from statusline.sh,
// shell-eval it with synthetic TKR_STATE_DIR / TKR_SESSION_ID inputs,
// and assert which file it picked. Skips on hosts without bash/jq
// (CI smoke runs cover the broader shell).
//
// Run: node --test hooks/statusline-mode-resolve.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { bashPath, logInterpreter, which } = require("./lib/bash-interpreter");

const BASH = bashPath();
const HAVE_BASH = !!BASH;
const HAVE_JQ = !!which("jq");

logInterpreter("statusline-mode-resolve");

// Mirror of the MODE_FILE resolution block in hooks/statusline.sh.
// Any divergence between this snippet and the real script is a bug —
// keep both in lockstep.
const RESOLVE_SNIPPET = `
MODE_FILE=""
if [ -n "\${TKR_SESSION_ID:-}" ]; then
  CANDIDATE="\${TKR_STATE_DIR}/mode-\${TKR_SESSION_ID}.json"
  if [ -f "$CANDIDATE" ]; then MODE_FILE="$CANDIDATE"; fi
fi
if [ -z "$MODE_FILE" ] && [ -f "\${TKR_STATE_DIR}/mode.json" ]; then
  MODE_FILE="\${TKR_STATE_DIR}/mode.json"
fi
MODE_BADGE=""
if [ -n "$MODE_FILE" ] && command -v jq >/dev/null 2>&1; then
  CUR_MODE=$(jq -r '.mode // "normal"' "$MODE_FILE" 2>/dev/null)
  case "$CUR_MODE" in
    conserve) MODE_BADGE="MODE:CONS" ;;
    critical) MODE_BADGE="MODE:CRIT" ;;
    recovery) MODE_BADGE="MODE:REC!" ;;
  esac
fi
printf 'FILE=%s\\nBADGE=%s\\n' "$MODE_FILE" "$MODE_BADGE"
`;

// Bash joins with "/" even when TKR_STATE_DIR uses "\" on Windows.
// Normalize both sides for comparison.
function norm(p) {
  return String(p).replace(/\\/g, "/");
}

function runResolve(env) {
  const r = spawnSync(BASH, ["-c", RESOLVE_SNIPPET], {
    env: Object.assign({}, process.env, env),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`bash exit ${r.status}: ${r.stderr}`);
  }
  const out = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-stl-mode-"));
}

test("AT-PLAN33-7: per-session normal wins over legacy critical", {
  skip: !HAVE_BASH || !HAVE_JQ ? "bash/jq not available" : false,
}, () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(
      path.join(dir, "mode.json"),
      JSON.stringify({ mode: "critical", source: "auto" })
    );
    fs.writeFileSync(
      path.join(dir, "mode-sess-A.json"),
      JSON.stringify({ mode: "normal", source: "auto" })
    );
    const out = runResolve({ TKR_STATE_DIR: dir, TKR_SESSION_ID: "sess-A" });
    assert.strictEqual(
      norm(out.FILE),
      norm(path.join(dir, "mode-sess-A.json")),
      "should pick per-session file"
    );
    assert.strictEqual(out.BADGE, "", "normal mode → no badge rendered");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AT-PLAN33-9: bug reproducer — leftover legacy critical, fresh session normal", {
  skip: !HAVE_BASH || !HAVE_JQ ? "bash/jq not available" : false,
}, () => {
  // Original symptom: prior session escalated to Critical and persisted
  // ~/.tkr/mode.json = critical. New session opens with ctx=3% / 7d=12%,
  // SessionStart runs `tkr mode auto` → writes mode-<sid>.json = normal.
  // Statusline must read the per-session file, NOT the leftover global.
  const dir = mkTmp();
  try {
    fs.writeFileSync(
      path.join(dir, "mode.json"),
      JSON.stringify({ mode: "critical", source: "auto", reason: "from prior session" })
    );
    fs.writeFileSync(
      path.join(dir, "mode-new-session.json"),
      JSON.stringify({ mode: "normal", source: "auto", reason: "auto: pressure=12%" })
    );
    const out = runResolve({ TKR_STATE_DIR: dir, TKR_SESSION_ID: "new-session" });
    assert.strictEqual(
      out.BADGE,
      "",
      "MODE:CRIT must NOT render when per-session says normal"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("statusline falls back to legacy mode.json when no per-session file exists", {
  skip: !HAVE_BASH || !HAVE_JQ ? "bash/jq not available" : false,
}, () => {
  // Mirrors AT-PLAN33-4 at the shell layer.
  const dir = mkTmp();
  try {
    fs.writeFileSync(
      path.join(dir, "mode.json"),
      JSON.stringify({ mode: "conserve" })
    );
    const out = runResolve({ TKR_STATE_DIR: dir, TKR_SESSION_ID: "no-file-yet" });
    assert.strictEqual(norm(out.FILE), norm(path.join(dir, "mode.json")));
    assert.strictEqual(out.BADGE, "MODE:CONS");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("statusline renders critical badge when per-session file says critical", {
  skip: !HAVE_BASH || !HAVE_JQ ? "bash/jq not available" : false,
}, () => {
  // Sanity: positive path. Per-session file = critical → MODE:CRIT renders.
  const dir = mkTmp();
  try {
    fs.writeFileSync(
      path.join(dir, "mode-real-crit.json"),
      JSON.stringify({ mode: "critical" })
    );
    const out = runResolve({ TKR_STATE_DIR: dir, TKR_SESSION_ID: "real-crit" });
    assert.strictEqual(out.BADGE, "MODE:CRIT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no MODE_FILE when neither per-session nor legacy file exists", {
  skip: !HAVE_BASH || !HAVE_JQ ? "bash/jq not available" : false,
}, () => {
  const dir = mkTmp();
  try {
    const out = runResolve({ TKR_STATE_DIR: dir, TKR_SESSION_ID: "ghost" });
    assert.strictEqual(out.FILE, "");
    assert.strictEqual(out.BADGE, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
