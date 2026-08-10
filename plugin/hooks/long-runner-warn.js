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

// splitSegments breaks a compound command into the individual commands a
// shell would run, so an `unbounded`-class pattern cannot bridge across a
// boundary via its `.*` (INV-104: `| tail -2` early plus an unrelated
// `rm -f` late read as `tail -f`). Splits on `&&`, `||`, `|`, `;` and
// newline; quote- and escape-aware so a separator inside "..." or '...'
// stays part of its segment. A lone `&` is NOT a separator — it would
// split `2>&1`, and a trailing background `&` needs no split.
function splitSegments(command) {
  if (!command || typeof command !== "string") return [];
  const segments = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      // Backslash escapes only inside double quotes, per sh.
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      // Consume the whole operator run so `&&` / `||` yield one boundary.
      while (i + 1 < command.length && "|&;".includes(command[i + 1])) i++;
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

// stripQuoted blanks the INTERIOR of quoted spans, leaving the quote
// characters. Matching runs on the result: a real watcher's own flags are
// never inside quotes (`tail -f "my log.txt"` keeps its -f), while a shell
// snippet passed as an argument — `node -e '... tail -2 ... rm -f ...'` —
// stops looking like one. Segmentation alone does not cover this: the whole
// quoted argument is a single segment. Observed live on INV-104's own fix.
function stripQuoted(segment) {
  let out = "";
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < segment.length) {
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        out += c;
      }
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      out += c + segment[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

// signatureOf pulls the short quoted form used in the hint and telemetry.
// Callers pass the MATCHED SEGMENT, never the whole compound line — the
// head of the line is frequently a `cd`, which is not what fired.
function signatureOf(text) {
  return String(text || "").trim().split(/\s+/).slice(0, 3).join(" ");
}

function l4StatePath(sid) {
  return path.join(TKR_STATE_DIR, `l4-state-${sid || "default"}.json`);
}

function readL4State(sid) {
  return safeReadJSON(l4StatePath(sid)) || { fires: 0, signatures: {} };
}

function writeL4State(sid, state) {
  safeWriteJSON(l4StatePath(sid), state);
}

// matchPattern returns the matched pattern descriptor, augmented with the
// `segment` that actually matched, or null. Pattern order is the outer
// loop so declared precedence in L4_PATTERNS is preserved across segments.
function matchPattern(command) {
  if (!command || typeof command !== "string") return null;
  const segments = splitSegments(command);
  for (const p of L4_PATTERNS) {
    for (const seg of segments) {
      if (p.re.test(stripQuoted(seg))) return { ...p, segment: seg };
    }
  }
  return null;
}

function formatHint(pattern, command) {
  // Quote the segment that matched, not the head of the compound line.
  const sig = signatureOf((pattern && pattern.segment) || command);
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
        command_signature: signatureOf((pattern && pattern.segment) || command),
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
  splitSegments,
  stripQuoted,
  matchPattern,
  formatHint,
  shouldFire,
  recordFire,
  l4StatePath,
};
