#!/usr/bin/env node
// tkr-hook-version: 6
// tkr Claude Code hook — rewrites Bash commands to use tkr for token savings.
//
// This Node dispatcher is the primary Claude hook path. It avoids shell-specific
// stdin and timeout behavior on Windows by:
//   - reading hook JSON directly from stdin
//   - timing out the entire hook if stdin never closes
//   - calling `tkr rewrite` via execFileSync (no bash wrapper)
//   - preserving the same Claude PreToolUse output contract as tkr-rewrite.sh

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { stateDir } = require("./lib/state-dir");
const { recordRewriteMiss } = require("./lib/rewrite-miss");
const { tkrSpawnArgv } = require("./lib/tkr-bin");
const resident = require("./lib/resident-client");
const { injectSessionID } = require("./lib/session-id-inject");

const TKR_STATE_DIR = stateDir();
const TIMINGS_FILE = path.join(TKR_STATE_DIR, "hook-timings.jsonl");

const timeoutSecs = Number.parseInt(process.env.TKR_HOOK_TIMEOUT_SECS || "", 10);
const timeoutMsEnv = Number.parseInt(process.env.TKR_HOOK_TIMEOUT_MS || "", 10);
const HOOK_TIMEOUT_MS =
  Number.isFinite(timeoutMsEnv) && timeoutMsEnv > 0
    ? timeoutMsEnv
    : Number.isFinite(timeoutSecs) && timeoutSecs > 0
      ? timeoutSecs * 1000
      : 2000;
// H-15: 4500ms → 1500ms. Every Bash call pays this on the hot path. Real
// rewrites finish in <50ms; 1.5s is generous headroom for cold-cache CLI
// invocations on Windows. Override via TKR_REWRITE_TIMEOUT_MS.
const REWRITE_TIMEOUT_MS_ENV = Number.parseInt(process.env.TKR_REWRITE_TIMEOUT_MS || "", 10);
const REWRITE_TIMEOUT_MS =
  Number.isFinite(REWRITE_TIMEOUT_MS_ENV) && REWRITE_TIMEOUT_MS_ENV > 0
    ? REWRITE_TIMEOUT_MS_ENV
    : 1500;

// H-15: session circuit breaker. 3 consecutive rewrite timeouts in a 60s
// window short-circuits this hook to passthrough for 5 minutes. State
// stored per-session-id at ~/.tkr/state/rewrite-fail-<sid>.json so
// concurrent shells in the same session share the breaker.
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_TRIP_MS = 5 * 60_000;
const REWRITE_FAIL_DIR = path.join(TKR_STATE_DIR, "state");

function rewriteFailPath(sid) {
  const safe = sid && /^[A-Za-z0-9_-]+$/.test(String(sid)) ? String(sid) : "default";
  return path.join(REWRITE_FAIL_DIR, `rewrite-fail-${safe}.json`);
}

function readCircuit(sid) {
  try {
    const raw = fs.readFileSync(rewriteFailPath(sid), "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

function writeCircuit(sid, obj) {
  try {
    fs.mkdirSync(REWRITE_FAIL_DIR, { recursive: true });
    const target = rewriteFailPath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// circuitTripped: returns true if breaker is currently tripped for this sid.
function circuitTripped(sid) {
  const c = readCircuit(sid);
  if (!c) return false;
  if (typeof c.tripped_until === "number" && Date.now() < c.tripped_until) {
    return true;
  }
  return false;
}

// recordRewriteTimeout: appends a timeout event and trips the breaker on
// 3-in-60s. Returns the new state for debug.
function recordRewriteTimeout(sid) {
  const now = Date.now();
  const prev = readCircuit(sid) || { events: [] };
  const events = Array.isArray(prev.events) ? prev.events : [];
  events.push(now);
  // Drop events outside the rolling window.
  const cutoff = now - CIRCUIT_WINDOW_MS;
  const recent = events.filter((t) => t >= cutoff);
  const next = { events: recent };
  if (recent.length >= CIRCUIT_THRESHOLD) {
    next.tripped_until = now + CIRCUIT_TRIP_MS;
    next.events = [];
  } else if (typeof prev.tripped_until === "number" && now < prev.tripped_until) {
    next.tripped_until = prev.tripped_until;
  }
  writeCircuit(sid, next);
  return next;
}

const HOOK_START = Date.now();
let EXIT_STATUS = 0;
let TIMING_NOTE = "ok";
// #209: which path produced the rewrite decision — "none" (no work needed),
// "resident" (served by the local runtime) or "spawn" (fresh tkr process).
// Recorded alongside elapsed_ms so a timings capture can be split by path
// without a second instrument.
let TIMING_SOURCE = "none";
let finished = false;

// Binary resolution (and the JS-entry-point rule) lives in lib/tkr-bin.js
// so this hook and the veto check in agent-search-inject.js cannot drift
// on which tkr they spawn.
// Name deliberately not TKR_*-prefixed: cmd/tkr/envvars_test.go scans this
// tree for /TKR_[A-Z0-9_]+/ to prove every env var is registered, and a
// constant with that shape reads as an undocumented one.
const REWRITE_SPAWN = tkrSpawnArgv(["rewrite"]);
// Kept for the ENOENT diagnostic below, which names the path it tried.
const TKR_BIN = REWRITE_SPAWN.bin;

// M-12: master kill switch — hoist to module top. The earlier in-loop
// check (process.stdin.on("end")) still paid the stdin-read timeout and
// kept the exit logTiming handler registered. Short-circuit at entry so
// disabled hooks add zero overhead beyond Node startup.
if (process.env.TKR_HOOKS_DISABLED === "1") {
  try { process.stdout.write("{}"); } catch {}
  process.exit(0);
}

function logTiming() {
  if (process.env.TKR_HOOK_TIMINGS !== "1") return;
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    // C-2: rotate before append. Three writers append to this file; any
    // one of them must rotate or it grows unbounded.
    try {
      const { rotateIfLarge } = require("./lib/rotate-jsonl");
      rotateIfLarge(TIMINGS_FILE);
    } catch {
      // rotate is best-effort; an append-after-no-rotate still works.
    }
    const entry = {
      hook: "tkr-rewrite",
      ts: new Date().toISOString(),
      elapsed_ms: Date.now() - HOOK_START,
      exit: EXIT_STATUS,
      note: TIMING_NOTE,
      source: TIMING_SOURCE,
    };
    fs.appendFileSync(TIMINGS_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — never block hook exit on telemetry
  }
}
process.on("exit", logTiming);

function finish() {
  if (finished) return;
  finished = true;
  process.exit(0);
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// HOOK-003 fast-path: the binary maintains ~/.tkr/rewrite-heads.json — the
// set of first command tokens that can possibly reach a rewrite rule, a TOML
// filter, or a wrapper-stripped filter lookup. A command containing no token
// that prefix-matches any head is guaranteed passthrough (exit 1, no output,
// no deny/ask: permission enforcement in RunRewrite only applies to commands
// it would rewrite), so the subprocess spawn — a full binary startup on every
// Bash call — can be skipped. Every doubt falls back to spawning: manifest
// missing, unparseable, wrong schema, incomplete (some filter's heads were
// unextractable), or stale (binary gone/broken — the binary re-stamps at
// least daily via its refresh-on-rewrite path).
const HEADS_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function readRewriteHeads() {
  try {
    const raw = fs.readFileSync(path.join(TKR_STATE_DIR, "rewrite-heads.json"), "utf8");
    const m = JSON.parse(raw);
    if (!m || m.schema !== 1 || m.complete !== true) return null;
    if (!Array.isArray(m.heads) || m.heads.length === 0) return null;
    if (typeof m.generated_unix !== "number") return null;
    if (Date.now() - m.generated_unix * 1000 > HEADS_STALE_MS) return null;
    return m.heads;
  } catch {
    return null;
  }
}

// commandMayRewrite: conservative scan for a token that prefix-matches any
// manifest head. The command is split on whitespace AND shell metacharacters
// so every possible segment head of a compound command (`cd x && git pull`,
// `$(git rev-parse HEAD)`) surfaces as a fragment — over-matching (an
// argument that happens to look like a head) just costs one spawn, while the
// split guarantees no segment head can hide inside a fragment. Leading quotes
// are stripped ("git" status); fragments with "=" are env assignments or
// --flag=value, never command words. Heads are prefix-matched (not equality)
// because the binary extracts guaranteed literal prefixes — e.g. head
// "python" must cover `python3`.
function commandMayRewrite(cmd, heads) {
  const fragments = cmd.split(/[\s;&|<>()`$]+/);
  for (const f of fragments) {
    if (!f) continue;
    const tok = f.replace(/^["']+/, "");
    if (!tok || tok.includes("=")) continue;
    for (const h of heads) {
      if (tok.startsWith(h)) return true;
    }
  }
  return false;
}

// RTK-005: parseSuggestHint extracts the suggest_hint string from Go binary
// stdout when hooks.mode=suggest. The Go binary writes a JSON object of the
// form {"suggest_hint":"..."} to stdout and exits 1. Returns the hint string
// on success, or null if the output is not a suggest-mode hint.
// parseBypass returns "disabled" | "excluded" when the binary marked this
// exit-1 as an intentional bypass, else "". Mirrors bypassMarker* in
// internal/hooks/rewrite_cmd.go — change both together.
//
// Deliberately strict: only an exact known value counts. An unrecognized
// or malformed marker falls through to being treated as a real
// passthrough, which over-counts misses rather than under-counting them.
// Over-counting shows up as a suspicious head in the ranking and gets
// investigated; under-counting is invisible.
function parseBypass(raw) {
  if (typeof raw !== "string" || raw.indexOf('"bypass"') < 0) return "";
  try {
    const v = JSON.parse(raw.trim());
    if (v && (v.bypass === "disabled" || v.bypass === "excluded")) return v.bypass;
  } catch {
    // Not JSON — treat as ordinary passthrough output.
  }
  return "";
}

function parseSuggestHint(raw) {
  if (!raw || raw.charAt(0) !== "{") return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.suggest_hint === "string" && obj.suggest_hint.length > 0) {
      return obj.suggest_hint;
    }
  } catch {
    // not valid JSON — plain passthrough
  }
  return null;
}

const stdinTimer = setTimeout(() => {
  TIMING_NOTE = "stdin-timeout";
  finish();
}, HOOK_TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("error", () => {
  TIMING_NOTE = "stdin-error";
  clearTimeout(stdinTimer);
  finish();
});
process.stdin.on("end", () => {
  // #209 made the decision path async (the resident runtime is a socket
  // round-trip). A rejection here would otherwise become an unhandled
  // rejection and a non-zero hook exit, which Claude reports as a hook error;
  // the catch turns any such failure into a plain passthrough.
  onStdinEnd().catch(() => {
    TIMING_NOTE = "hook-error";
    finish();
  });
});
process.stdin.resume();

async function onStdinEnd() {
  clearTimeout(stdinTimer);
  // Note: TKR_HOOKS_DISABLED is checked at module top — control never
  // reaches here when the kill switch is active.

  let event;
  try {
    event = JSON.parse(input || "{}");
  } catch {
    TIMING_NOTE = "parse-error";
    finish();
    return;
  }

  const cmd = event?.tool_input?.command || "";
  if (!cmd) {
    TIMING_NOTE = "empty-cmd";
    finish();
    return;
  }

  if (cmd.includes("<<")) {
    TIMING_NOTE = "heredoc-skip";
    finish();
    return;
  }

  // HOOK-003: skip the subprocess when no token can reach a rewrite.
  // TKR_DISABLED commands still spawn so the binary's TrackDisabled
  // telemetry keeps counting them.
  if (process.env.TKR_DISABLED !== "1" && !cmd.includes("TKR_DISABLED")) {
    const heads = readRewriteHeads();
    if (heads && !commandMayRewrite(cmd, heads)) {
      TIMING_NOTE = "fastpath-skip";
      finish();
      return;
    }
  }

  // H-15: extract session_id for circuit breaker. session_id from
  // transcript_path or event.session_id; falls back to pid-based default.
  let sid = "default";
  if (event?.session_id) sid = String(event.session_id);
  else if (event?.transcript_path) {
    const m = String(event.transcript_path).match(/([a-f0-9-]{36})\.jsonl$/i);
    if (m) sid = m[1];
  } else if (process.env.TKR_SESSION_ID) sid = process.env.TKR_SESSION_ID;

  // H-15: circuit breaker — if tripped, skip rewrite entirely. The bash
  // command flows through unchanged. Auto-resets after 5min via timestamp.
  if (circuitTripped(sid)) {
    TIMING_NOTE = "circuit-tripped";
    finish();
    return;
  }

  let rewritten = "";
  let exitCode = 1;

  // #209: ask the resident runtime first. It returns null for EVERY failure
  // mode — disabled, absent, stale endpoint, upgraded binary, unreachable,
  // slow, malformed frame — and null means "spawn tkr exactly as before".
  // Nothing here can block the hook: the client owns its own deadline and
  // suppresses a hung runtime after one timeout.
  let served = null;
  try {
    served = await resident.call("rewrite", cmd, null, { cwd: event?.cwd });
  } catch {
    served = null;
  }

  if (served) {
    TIMING_SOURCE = "resident";
    exitCode = served.exit;
    rewritten = served.body.toString("utf8");
  } else {
    TIMING_SOURCE = "spawn";
    // INV-119: REWRITE_SPAWN.cmd is null when resolveTkrBin found nothing
    // to spawn at all (no TKR_BIN, no install location, no PATH match) —
    // the same "no tkr" outcome ENOENT used to report once a bare name
    // reached the OS. Short-circuit rather than let execFileSync throw a
    // "cmd must be a string" TypeError that would fall into the generic
    // "rewrite-error" branch below and mislabel a resolution failure as a
    // spawn-time error.
    if (!REWRITE_SPAWN.cmd) {
      TIMING_NOTE = "no-tkr";
      finish();
      return;
    }
    try {
      rewritten = execFileSync(REWRITE_SPAWN.cmd, REWRITE_SPAWN.argv.concat([cmd]), {
        encoding: "utf8",
        timeout: REWRITE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      exitCode = 0;
    } catch (err) {
      if (err && err.code === "ENOENT") {
        TIMING_NOTE = "no-tkr";
        finish();
        return;
      }
      if (typeof err?.status === "number") {
        exitCode = err.status;
        rewritten = typeof err.stdout === "string" ? err.stdout : String(err.stdout || "");
      } else if (err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM" || err?.signal === "SIGKILL") {
        // H-15: record timeout, may trip the circuit breaker.
        recordRewriteTimeout(sid);
        TIMING_NOTE = "rewrite-timeout";
        finish();
        return;
      } else {
        TIMING_NOTE = "rewrite-error";
        finish();
        return;
      }
    }
  }

  rewritten = rewritten.trimEnd();
  switch (exitCode) {
    case 0:
      if (rewritten === cmd) {
        TIMING_NOTE = "identity-rewrite";
        finish();
        return;
      }
      break;
    case 1: {
      // RTK-005: suggest mode. When hooks.mode=suggest, the Go binary exits 1
      // but writes a JSON hint to stdout: {"suggest_hint":"..."}.
      // Inject the hint as additionalContext so Claude sees the suggestion
      // without having the command rewritten or blocked.
      const hint = parseSuggestHint(rewritten);
      if (hint) {
        TIMING_NOTE = "suggest-hint";
        emit({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: hint,
          },
        });
        finish();
        return;
      }
      // An INTENTIONAL bypass — TKR_DISABLED, or a configured
      // exclude_commands entry — also exits 1. Those are user decisions,
      // not gaps in tkr's coverage, and counting them would inflate the
      // miss denominator with exactly the commands someone has already
      // chosen to opt out of. The binary marks them; see
      // bypassMarker* in internal/hooks/rewrite_cmd.go.
      const bypass = parseBypass(rewritten);
      if (bypass) {
        TIMING_NOTE = `bypass-${bypass}`;
        finish();
        return;
      }
      TIMING_NOTE = "passthrough";
      // A passthrough that got this far had a head in rewrite-heads.json
      // — the fast path above returns before spawning otherwise — so tkr
      // has rules for this tool and could not apply them to this
      // invocation. That is the actionable gap, and the only passthrough
      // worth a row. See hooks/lib/rewrite-miss.js.
      recordRewriteMiss(cmd, event && event.session_id);
      finish();
      return;
    }
    case 2:
      TIMING_NOTE = "deny";
      finish();
      return;
    case 3:
      TIMING_NOTE = "ask";
      break;
    default:
      TIMING_NOTE = `rewrite-err-${exitCode}`;
      finish();
      return;
  }

  // INV-121: attach the real session id (already extracted above for the
  // circuit breaker) to the rewritten command so the spawned tkr process
  // can key delta snapshots on it instead of falling back to pid-<ppid>.
  // "default" means every id source missed — nothing real to attach, and
  // the SAFE_SID check inside injectSessionID would otherwise happily
  // stamp the literal word "default" onto the command.
  if (sid !== "default") {
    rewritten = injectSessionID(rewritten, sid);
  }

  const updatedInput = {
    ...(event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {}),
    command: rewritten,
  };

  if (exitCode === 3) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput,
      },
    });
    finish();
    return;
  }

  TIMING_NOTE = "allow-rewrite";
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "tkr auto-rewrite",
      updatedInput,
    },
  });
  finish();
}
