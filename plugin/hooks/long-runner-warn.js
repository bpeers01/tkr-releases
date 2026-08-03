#!/usr/bin/env node
// PlaybookV2 L4 — long-runner warn (proposal 2026-05-10).
//
// PreToolUse(Bash) hook. Fires when the about-to-run command matches a
// known long-runner pattern (`terraform apply`, `gh run watch`, `npm run
// dev`, `tsc --watch`, `pytest --watch`, `tail -f`, `docker logs -f`).
// These commands routinely exceed the 5min Anthropic cache TTL during
// their own wall-time, busting the prefix cache mid-execution. Survey
// data: $222 / 19% of total bust spend across 15 heavy sessions
// (docs/audits/2026-05-10-cache-bust-survey.md §self-bust).
//
// Action: emit additionalContext hint recommending background-and-poll
// pattern + emit L4 fired event to the playbook ledger.
//
// Per-session fire cap = 3 (anti-spam — user may legitimately watch a
// long-runner). Hot-path budget: <2ms (regex set, no I/O beyond the
// per-session state file).
//
// Kill switches:
//   TKR_PLAYBOOK_L4_DISABLED=1
//   TKR_PLAYBOOK_EXTENSIONS_DISABLED=1
//   TKR_PLAYBOOK_DISABLED=1

const fs = require("fs");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { stateDir } = require("./lib/state-dir");
const { readJSONSync, writeJSONAtomic } = require("./lib/safe-json");

const TKR_STATE_DIR = stateDir();

const L4_FIRE_CAP = 3;

// Pattern set frozen by proposal §L4. Each entry: [name, regex,
// est_duration_class]. duration_class informs the hint phrasing
// (some long-runners are minutes, others are unbounded watches).
const L4_PATTERNS = [
  { name: "gh_watch", re: /\bgh\s+(run|pr)\s+(watch|checks\s+--watch)/, durClass: "minutes" },
  { name: "terraform_apply", re: /\bterraform\s+apply\b/, durClass: "minutes" },
  { name: "npm_long", re: /\bnpm\s+run\s+(dev|start|watch)\b/, durClass: "unbounded" },
  { name: "tsc_watch", re: /\btsc\b.*(?:-w|--watch)\b/, durClass: "unbounded" },
  { name: "pytest_watch", re: /\bpytest\b.*--watch/, durClass: "unbounded" },
  { name: "tail_follow", re: /\btail\b.*-f\b/, durClass: "unbounded" },
  { name: "docker_logs_follow", re: /\bdocker\s+logs?\b.*-f\b/, durClass: "unbounded" },
];

const safeReadJSON = readJSONSync;
const safeWriteJSON = writeJSONAtomic;

function l4StatePath(sid) {
  return path.join(TKR_STATE_DIR, `l4-state-${sid || "default"}.json`);
}

function readL4State(sid) {
  return safeReadJSON(l4StatePath(sid)) || { fires: 0, signatures: {} };
}

function writeL4State(sid, state) {
  safeWriteJSON(l4StatePath(sid), state);
}

// matchPattern returns the matched pattern descriptor or null.
function matchPattern(command) {
  if (!command || typeof command !== "string") return null;
  for (const p of L4_PATTERNS) {
    if (p.re.test(command)) return p;
  }
  return null;
}

function formatHint(pattern, command) {
  // Pull a short signature for the hint — first 2 words of the command.
  const sig = command.trim().split(/\s+/).slice(0, 3).join(" ");
  if (pattern.durClass === "minutes") {
    return (
      `[L4 long-runner: \`${sig}\` typically exceeds 5min Anthropic cache TTL → ` +
      `background-and-poll pattern recommended (run with run_in_background:true, ` +
      `poll status with BashOutput) so the prefix cache survives.]`
    );
  }
  return (
    `[L4 long-runner: \`${sig}\` is unbounded (watch/dev server) → ALWAYS run ` +
    `with run_in_background:true; foreground watch/follow commands bust the ` +
    `prefix cache mid-execution and block the session.]`
  );
}

// shouldFire returns {ok, state, statePath, signature} after applying
// kill switches + per-session fire cap + per-signature dedup.
function shouldFire(sid, pattern, command) {
  if (
    process.env.TKR_PLAYBOOK_DISABLED === "1" ||
    process.env.TKR_PLAYBOOK_EXTENSIONS_DISABLED === "1" ||
    process.env.TKR_PLAYBOOK_L4_DISABLED === "1"
  ) {
    return { ok: false, reason: "disabled" };
  }
  const state = readL4State(sid);
  if ((state.fires || 0) >= L4_FIRE_CAP) {
    return { ok: false, reason: "session_fire_cap" };
  }
  const signature = pattern.name;
  if (state.signatures && state.signatures[signature]) {
    return { ok: false, reason: "signature_already_warned" };
  }
  return { ok: true, state, signature };
}

function recordFire(sid, state, signature) {
  state.fires = (state.fires || 0) + 1;
  state.signatures = state.signatures || {};
  state.signatures[signature] = Date.now();
  state.last_fire_at = Date.now();
  writeL4State(sid, state);
}

function emitTelemetry(sid, pattern, command) {
  try {
    const emit = require("./lib/playbook-emit");
    emit.emitEvent(
      "L4",
      "fired",
      {
        command_signature: command.trim().split(/\s+/).slice(0, 3).join(" "),
        matched_pattern: pattern.name,
        est_duration_class: pattern.durClass,
      },
      null,
      sid,
    );
  } catch {
    // best-effort
  }
}

if (require.main === module) {
  if (hooksDisabled()) {
    process.stdout.write("{}");
  } else {
    readStdinWithTimeout(2000)
      .then((buf) => {
        let event;
        try {
          event = JSON.parse(buf || "{}");
        } catch {
          process.stdout.write("{}");
          return;
        }
        if (event.tool_name !== "Bash") {
          process.stdout.write("{}");
          return;
        }
        const command = (event.tool_input && event.tool_input.command) || "";
        const pattern = matchPattern(command);
        if (!pattern) {
          process.stdout.write("{}");
          return;
        }
        const sid = event.session_id || process.env.TKR_SESSION_ID || "default";
        const guard = shouldFire(sid, pattern, command);
        if (!guard.ok) {
          process.stdout.write("{}");
          return;
        }
        recordFire(sid, guard.state, guard.signature);
        emitTelemetry(sid, pattern, command);
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: formatHint(pattern, command),
            },
          }),
        );
      })
      .catch(() => process.stdout.write("{}"));
  }
}

module.exports = {
  L4_PATTERNS,
  L4_FIRE_CAP,
  matchPattern,
  formatHint,
  shouldFire,
  recordFire,
  l4StatePath,
};
