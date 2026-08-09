// hooks/lib/keepalive-activity.js
//
// Keepalive v2 activity signal — JS port of the former
// hooks/keepalive/activity-touch.sh UserPromptSubmit hook (issue #129).
//
// Why a port, not a bash fix: the bash hook cost ~9 process spawns per
// prompt (bash, python JSON parse, sed×2, tr×2, date, mkdir, cat). Under
// multi-session Windows load a bare spawn degrades to 4–6s (normal
// 20–80ms), so the chain blew the 30s UserPromptSubmit budget and Claude
// Code discarded the turn's injected context. Folded into
// user-prompt-submit.js — which already parses the same payload — the
// touch costs zero additional processes.
//
// Two entry points, one invariant — only a human can advance the marker:
//
//   activityTouch()          UserPromptSubmit — a typed prompt.
//   interactiveAnswerTouch() PostToolUse(AskUserQuestion|ExitPlanMode) —
//                            the answer to an interactive prompt, which
//                            arrives as a tool_result and so never reaches
//                            UserPromptSubmit (issue #152 item 2). Its
//                            admissibility argument and its narrower guard
//                            set are documented at the function.
//
// activityTouch's semantics are 1:1 with the bash hook:
//
// Single-fire correctness (INV-024): the keepalive wake itself produces a
// continuation turn that re-enters UserPromptSubmit. If treated as genuine
// user activity it would reset the idle clock AND delete fired-at every
// cycle — re-arming the watcher forever (observed: 18–21 fires per
// overnight session instead of 1). Guards, OR'd, any hit → no-op:
//   1.  Content — the wake sentinel appears in the raw payload.
//   2.  Recency — per-sid fired-at younger than the re-arm grace window.
//   2b. Cross-session recency (KEEP-006/HAND-004) — a wake can land in a
//       DIFFERENT session than the watcher that fired, so guard 2's
//       per-sid marker never sees it; project-level last-fired is the
//       payload-shape-independent backstop.
//
// State files (readers: hooks/keepalive/watcher.sh — still bash — and
// skills/handoff/scripts/write-continue-here.sh):
//   $TKR_STATE_DIR/keepalive/<sid>/activity              epoch of last genuine prompt
//   $TKR_STATE_DIR/keepalive/<sid>/fired-at              deleted on genuine prompt
//   $TKR_STATE_DIR/keepalive-projects/<key>/last-activity  project copy (KEEP-006)
//
// keepaliveProjectKey() MUST stay byte-identical to
// tkr_keepalive_project_key in hooks/keepalive/resolve-project.sh — the
// watcher still derives the key in bash, and a one-byte divergence
// silently splits the project gate per writer. The parity test in
// keepalive-activity.test.js drives both implementations over the same
// inputs whenever a bash is available.

"use strict";

const fs = require("fs");
const path = require("path");
const { stateDir } = require("./state-dir");
const { isSubagentContext } = require("./subagent-context");

const WAKE_SENTINEL = "INTENTIONAL keepalive wake";
const DEFAULT_REARM_GRACE_SEC = 180;

// Byte-exact port of tkr_keepalive_project_key (resolve-project.sh).
// The bash pipeline is `tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-'`,
// which operates on BYTES — non-ASCII runs become one dash per UTF-8
// byte, not per code point — hence the Buffer walk instead of a regex.
function keepaliveProjectKey(cwd) {
  let p = String(cwd || "");
  if (!p) return "";
  // Same cwd arrives in two spellings on Windows: CC payloads carry
  // `C:\Users\...`, git-bash $PWD carries `/c/Users/...`. Both must
  // normalize to one key or the project gate silently splits per caller.
  p = p.replace(/\\/g, "/");
  if (/^\/[a-zA-Z]\//.test(p)) p = p[1] + ":" + p.slice(2);
  else if (/^\/[a-zA-Z]$/.test(p)) p = p[1] + ":/";
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  let out = "";
  for (const b of Buffer.from(p, "utf8")) {
    if (b >= 0x41 && b <= 0x5a) out += String.fromCharCode(b + 32); // A-Z → a-z
    else if ((b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39))
      out += String.fromCharCode(b); // a-z 0-9 pass through
    else out += "-";
  }
  return out;
}

// Digits-only epoch read; anything else (missing file, garbage) → 0.
// Mirrors the bash `case "$X" in *[!0-9]*) X=0 ;; esac` sanitizer.
function readEpoch(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function rearmGraceSec() {
  const raw = String(process.env.TKR_KEEPALIVE_REARM_GRACE_SEC || "").trim();
  return /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : DEFAULT_REARM_GRACE_SEC;
}

// Per-sid + per-project state paths for one payload. Project key input
// (KEEP-006): payload cwd, falling back to the hook process's own cwd. The
// bash hook rejected a cwd containing a newline (herestring line-split
// parse) and fell back to $PWD — keep that shape.
function resolvePaths(data, sid) {
  const root = stateDir();
  const dir = path.join(root, "keepalive", sid || "default");
  const payloadCwd =
    data && typeof data.cwd === "string" && !data.cwd.includes("\n") ? data.cwd : "";
  const projKey = keepaliveProjectKey(payloadCwd || process.cwd());
  return { dir, projDir: projKey ? path.join(root, "keepalive-projects", projKey) : "" };
}

// Record genuine user activity and re-arm the watcher. The project copy
// resets the cross-session idle clock for every watcher in this project;
// no fired-at-style deletion for the project file — readers compare
// timestamps (last-fired vs last-activity), never existence.
function recordActivity({ dir, projDir }, now) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "activity"), `${now}\n`);
  } catch {}
  try {
    fs.rmSync(path.join(dir, "fired-at"), { force: true });
  } catch {}
  if (projDir) {
    try {
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "last-activity"), `${now}\n`);
    } catch {}
  }
}

// The touch. rawInput is the unparsed stdin payload (guard 1 matches the
// whole payload, exactly like the bash hook's whole-stdin match), data the
// parsed object, sid the session id runMain already resolved. Best-effort
// throughout — never throws, never blocks the prompt.
function activityTouch({ rawInput, data, sid }) {
  try {
    const paths = resolvePaths(data, sid);

    // Guard 1 — content.
    if (String(rawInput || "").includes(WAKE_SENTINEL)) return;

    const grace = rearmGraceSec();
    const now = Math.floor(Date.now() / 1000);

    // Guard 2 — per-sid recency.
    const firedAt = readEpoch(path.join(paths.dir, "fired-at"));
    if (firedAt > 0 && now - firedAt < grace) return;

    // Guard 2b — cross-session recency via project last-fired.
    if (paths.projDir) {
      const projFiredAt = readEpoch(path.join(paths.projDir, "last-fired"));
      if (projFiredAt > 0 && now - projFiredAt < grace) return;
    }

    recordActivity(paths, now);
  } catch {
    // Best-effort — malformed state must never block the prompt.
  }
}

// --- Issue #152 item 2: the answer to an interactive prompt ---
//
// The second entry point. A human answering an AskUserQuestion (or
// approving/rejecting an ExitPlanMode) is genuine activity as strongly as a
// typed prompt is — but it arrives as a tool_result, never as a
// UserPromptSubmit, so `activityTouch` above never saw it. Consequences on
// the live session in #152: `activity` stayed pinned at the moment the
// question was ASKED and `fired-at` survived the answer, leaving the watcher
// disarmed-but-fired until the next typed prompt — so a later fire could
// stack on a session the human was actively working in.
//
// Same list as INTERACTIVE_TOOLS in hooks/keepalive/transcript-activity.py
// (item 1's pending-prompt scan). Keep the two in sync: item 1 suppresses
// the fire while one of these is outstanding, item 2 re-arms when it is
// answered — a tool in one list and not the other is a half-handled tool.
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// The invariant this module rests on is "only a human can advance the
// marker". These two tools cannot COMPLETE without a human acting on them,
// which is what makes their PostToolUse admissible where an ordinary tool
// result — produced by an agentic turn with no human present — is not. The
// checks below are what keeps that true rather than assumed:
//
//   - PostToolUse only. A PreToolUse for the same tool means the question is
//     about to be ASKED; no one has answered anything yet. (An older Claude
//     Code that omits hook_event_name is accepted — the caller is registered
//     on PostToolUse.)
//   - Main session only. A sidechain shares the coordinator's session_id, so
//     a worker's tool traffic would otherwise advance the coordinator's
//     marker. Subagents are not handed these tools today; this is the guard
//     that keeps that from being load-bearing.
//   - A response actually came back. An absent/empty/errored tool_response
//     is a call that never reached a human (cancelled, interrupted, failed).
//     A *dismissal* is not that — pressing escape is a human acting — so
//     anything non-empty and unflagged counts.
function isInteractiveHumanAnswer(data) {
  if (!data || typeof data !== "object") return false;
  if (!INTERACTIVE_TOOLS.has(data.tool_name)) return false;
  if (typeof data.hook_event_name === "string" && data.hook_event_name !== "PostToolUse") {
    return false;
  }
  if (isSubagentContext(data)) return false;

  const resp = data.tool_response;
  if (resp === null || resp === undefined) return false;
  if (typeof resp === "string") return resp.trim().length > 0;
  if (typeof resp === "object") {
    if (resp.error || resp.is_error) return false;
    if (Array.isArray(resp)) return resp.length > 0;
    return Object.keys(resp).length > 0;
  }
  return false;
}

// Guards 2 and 2b are deliberately NOT applied here.
//
// They exist for one payload shape: the keepalive wake's own continuation
// turn, which re-enters UserPromptSubmit and would otherwise re-arm the
// watcher every cycle (INV-024). A fresh `fired-at` is exactly the state
// this path must clear — the human answered SECONDS after the watcher fired,
// which is the reported failure, and a recency guard here would decline to
// re-arm in precisely that case and leave the bug in place.
//
// Guard 1 stays: it costs one substring test, and a wake payload that
// somehow reaches this path is still not a human answering anything.
function interactiveAnswerTouch({ rawInput, data, sid }) {
  try {
    if (!isInteractiveHumanAnswer(data)) return false;
    if (String(rawInput || "").includes(WAKE_SENTINEL)) return false;
    recordActivity(resolvePaths(data, sid), Math.floor(Date.now() / 1000));
    return true;
  } catch {
    // Best-effort — a keepalive marker is never worth failing a tool call.
    return false;
  }
}

module.exports = {
  activityTouch,
  interactiveAnswerTouch,
  isInteractiveHumanAnswer,
  keepaliveProjectKey,
  INTERACTIVE_TOOLS,
  WAKE_SENTINEL,
  DEFAULT_REARM_GRACE_SEC,
};
