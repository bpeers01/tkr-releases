#!/usr/bin/env node
// tkr PostToolUse hook — orchestrator.
//
// Responsibility-aligned modules live under hooks/lib/posttool/:
//   brevity        — getBrevityMode, brevityResponse
//   explore-nudge  — checkExplorationPattern (Read/Glob/Grep streak)
//   cap-nudge      — Glob/Grep truncation marker replacement
//   ctx-breakpoint — Channel 2 advisories (FROZEN wording §5 Q4)
//   bash-filter    — stripSearchInternals, tryFilterStdin, extractToolText
//   session-ingest — large grep/curl/WebFetch digestion
//   response       — makeResponse helper
//   telemetry      — recordTelemetry JSONL append
//   sideeffects    — statusline/session-record/reconcile/mode-auto/etc fire-and-forget
//   tkr-spawn      — shared bounded spawnSync wrapper (H-14)
//
// This file keeps:
//   1. stdin entry + dispatch
//   2. processEvent (ARCHITECTURAL FENCE — see comment block within)
//   3. logTiming wiring (hook-timings.jsonl)
//   4. Test-surface re-exports

const fs = require("fs");
const path = require("path");
const { checkCacheBust } = require("./cache-bust-detector.js");
const { checkPushBoundary } = require("./push-clear-nudge.js");
const { spawnBounded } = require("./lib/spawn-bounded");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { stateDir } = require("./lib/state-dir");
const { getSessionID } = require("./lib/session-id");

const {
  brevityResponse,
} = require("./lib/posttool/brevity");
const { checkExplorationPattern } = require("./lib/posttool/explore-nudge");
const {
  applyCapNudge,
  GLOB_TRUNC_MARKER,
  GREP_TRUNC_MARKER,
} = require("./lib/posttool/cap-nudge");
const {
  ctxBreakpointContext,
  ctxBreakpointStatePath,
  CTX_BREAKPOINT_ADVISORIES,
  getTelemetryPath,
} = require("./lib/posttool/ctx-breakpoint");
const {
  stripSearchInternals,
  tryFilterStdin,
  extractToolText,
} = require("./lib/posttool/bash-filter");
const {
  detectSessionIngestLabel,
  trySessionIngest,
  SESSION_INGEST_MIN_BYTES,
} = require("./lib/posttool/session-ingest");
const { makeResponse } = require("./lib/posttool/response");
const { recordTelemetry } = require("./lib/posttool/telemetry");
const {
  writeLastActivity,
  spawnSessionRecord,
  spawnReadCacheInvalidate,
  spawnFlipExtraRead,
  maybeSpawnReconcile,
  maybeSpawnModeAuto,
  maybeEmitArtifactDebug,
  spawnStatuslineUpdate,
} = require("./lib/posttool/sideeffects");
const { maybeSpawnCommitRefresh } = require("./lib/posttool/commit-refresh");
const { recordAgentCompletion } = require("./lib/agent-completions");
const { interactiveAnswerTouch } = require("./lib/keepalive-activity");
const { persistSessionEffort } = require("./lib/sessionstart/effort-log");

const HOOK_START = Date.now();
let TIMING_NOTE = "ok";

function logTiming() {
  if (process.env.TKR_HOOK_TIMINGS !== "1") return;
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "hook-timings.jsonl");
    // C-2: rotate before append — every PostToolUse writes a row; without
    // rotation this grows unbounded.
    try {
      const { rotateIfLarge } = require("./lib/rotate-jsonl");
      rotateIfLarge(target);
    } catch {
      // best-effort
    }
    const entry = {
      hook: "post-tool-call",
      ts: new Date().toISOString(),
      elapsed_ms: Date.now() - HOOK_START,
      note: TIMING_NOTE,
    };
    fs.appendFileSync(target, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — never block hook exit on telemetry
  }
}
if (require.main === module) process.on("exit", logTiming);

// Read stdin (Claude Code sends JSON with tool_name, tool_input, tool_response)
// Guarded: skip stdin processing when imported as a module (tests).
//
// CR-06 + M-12: stdin-timeout helper + master kill switch. PostToolUse fires
// after every tool — if CC stalls mid-write, the hook hangs forever and
// blocks subsequent tool calls (MCP stdio is serial).
if (require.main === module) {
  if (hooksDisabled()) {
    process.exit(0);
  } else {
    readStdinWithTimeout(3000)
      .then((input) => {
        try {
          const event = JSON.parse(input || "{}");
          // PLAN-36: pass CC's event.cwd so the binary's project-slug
          // resolution is anchored to the workspace root, not whatever
          // cwd the hook subprocess happens to inherit.
          const workspaceDir = typeof event.cwd === "string" ? event.cwd : "";
          // Thread the live session id + transcript path so the statusline
          // writer reads THIS session's JSONL, not the newest-mtime file in
          // the project dir (which leaks a concurrent/forked session's
          // last_ctx_k into our ctx injection). getSessionID prefers the
          // transcript_path UUID — authoritative across resume/fork/rename.
          const sessionID = getSessionID(event);
          const transcriptPath =
            typeof event.transcript_path === "string" ? event.transcript_path : "";
          // Refresh statusline pressure indicators on every tool call (fire-and-forget)
          spawnStatuslineUpdate(workspaceDir, sessionID, transcriptPath);
          writeLastActivity();
          // Issue #152 item 2: keepalive activity touch for the answer to
          // an interactive prompt. Folded in here rather than registered as
          // a matched PostToolUse(AskUserQuestion|ExitPlanMode) entry — this
          // hook is the plugin's UNMATCHED PostToolUse entry, so it already
          // receives the event; a matched entry would spawn a second node
          // process for it and would have to edit the prefix-cache-critical
          // plugin.json to do so. Cost on every other tool call is one
          // Set.has() on tool_name. TKR_KEEPALIVE_DISABLE is the name both
          // READMEs already document as the keepalive kill switch; note
          // this is currently its ONLY reader — neither watcher.sh nor
          // `tkr keepalive watch` consults it, so setting it today
          // suppresses this touch and nothing else. TKR_HOOKS_DISABLED
          // (module top) remains the switch that stops everything.
          if (process.env.TKR_KEEPALIVE_DISABLE !== "1") {
            interactiveAnswerTouch({ rawInput: input, data: event, sid: sessionID });
          }
          // Fire-and-forget: classify + persist the event for session-continuity
          // snapshots (PLAN-3). Detached spawn keeps the hook exit path fast.
          spawnSessionRecord(input);
          const result = processEvent(event);
          if (result) {
            process.stdout.write(JSON.stringify(result));
          }
        } catch {
          // Parse error or unexpected shape — passthrough
        }
      })
      .catch(() => process.exit(0));
  }
}

const extractSessionID = getSessionID;

function processEvent(event) {
  const sessionID = extractSessionID(event);

  // Per-session telemetry scope: ensures getTelemetryPath() inside
  // ctxBreakpointContext + other helpers reads this session's file
  // instead of leftover state from a prior session on the same project.
  // INV-039: payload sid wins over inherited env (stale launch-time pin).
  if (sessionID) {
    process.env.TKR_SESSION_ID = sessionID;
  }

  // Issue #123: the session's actual effort reaches effort-<sid>.json
  // from here and nowhere else. PostToolUse fires inside a tool-use
  // context, which is the only context Claude Code populates
  // `input.effort` / CLAUDE_EFFORT for — SessionStart and
  // UserPromptSubmit are handed neither, so the calls there never
  // detected anything and `tkr top`'s EFFORT column read a file that was
  // never written. Rewritten on every tool call rather than on change so
  // the `ts` stamp means "last observed", which is what
  // effortAgeSecs reports; one ~100-byte atomic write, no spawn.
  // clearWhenAbsent is true: this hook is the authoritative observer, so
  // absence here is real evidence — a mid-session switch to a model
  // without effort support must retire the stale value, not keep it.
  try {
    persistSessionEffort(sessionID, event, process.env, { clearWhenAbsent: true });
  } catch {}

  // CACHE-002: warn on Edit/Write to cache-critical files (CLAUDE.md,
  // MEMORY.md, .claude/rules/*, .claude/settings*.json, plugin.json).
  // Returned early via additionalContext so Claude sees the warning in
  // the same turn the edit completed.
  let cacheBustWarning = null;
  if (process.env.TKR_CACHE_BUST_DISABLED !== "1") {
    cacheBustWarning = checkCacheBust(event, sessionID);
  }

  // Ship 5: nudge /clear after `git push` when session is long + tail is
  // big enough that /clear actually saves cap-units. One per session.
  let pushNudgeWarning = null;
  if (process.env.TKR_PUSH_NUDGE_DISABLED !== "1") {
    pushNudgeWarning = checkPushBoundary(event, sessionID);
  }

  // #134 R0.1: Agent-completion telemetry. PostToolUse(Agent) is the
  // only surface that reports what a dispatched worker actually did
  // (resolved model, tokens, duration, tool count); this ledger row is
  // the spawn→stop join bridge. Fire-and-forget, never alters the
  // response, swallows its own failures.
  if (event.tool_name === "Agent" || event.tool_name === "Task") {
    recordAgentCompletion(event);
  }

  // 2026-05-22 graph-share proposal Item 2: when the user just ran
  // `git commit|merge|cherry-pick|rebase|reset` via Bash, fire
  // `tkr search --refresh` + `tkr graph build --quiet` detached so the
  // next session-internal query sees fresh data without waiting for the
  // next SessionStart. Both commands are singleton-locked downstream.
  maybeSpawnCommitRefresh(event);

  // PLAN-18: observe Read calls for extra_read signal.
  if (event.tool_name === "Read") {
    const fp = event.tool_input?.file_path;
    if (fp) {
      spawnFlipExtraRead(sessionID, fp);
    }
  }

  // LCTX-001 Phase 3: invalidate read-cache on Edit/Write so the next
  // tkr_read of the path sees a cache miss and renders fresh content.
  // Fire-and-forget; suppressed by TKR_LEANCTX_DISABLED.
  if (
    process.env.TKR_LEANCTX_DISABLED !== "1" &&
    (event.tool_name === "Edit" || event.tool_name === "Write")
  ) {
    const fp = event.tool_input?.file_path || event.tool_input?.path;
    if (fp) {
      spawnReadCacheInvalidate(fp);
    }
  }

  // PLAN-19: periodic reconciliation of rejected delegation decisions.
  maybeSpawnReconcile(sessionID);

  // PLAN-21: periodic mode auto-select every N tool calls.
  maybeSpawnModeAuto();

  // Prefix-aware injection composition (proposal §3.3). The V2=0 legacy
  // brevityContext branch and its TKR_INJECTION_LEGACY rollback handle
  // were deleted 2026-07-23 (INV-073) — see
  // docs/audits/2026-07-23-injection-discipline/REPORT.md. Dedup state is
  // read FRESH inside ctxBreakpointContext (Risk #15) — the single-source
  // result is threaded through the downstream callsites, never
  // pre-composed-and-reused as a fixture across return paths. The PR #5
  // c1 regression test asserts the old pre-compose brevity pattern stays
  // deleted (fence flipped from "must remain" to "must not return").
  const advisory = ctxBreakpointContext(sessionID);
  const ctxParts = [advisory, cacheBustWarning, pushNudgeWarning].filter(Boolean);
  const composedCtx = ctxParts.length ? ctxParts.join("\n\n") : "";
  const command = event.tool_input?.command || "";
  const outputInfo = extractToolText(event);

  // Check exploration pattern for all tools (before Bash-only filter)
  const exploreNudge = checkExplorationPattern(event);
  if (exploreNudge) {
    // Merge brevity reinforcement into the same hookSpecificOutput block
    if (composedCtx && exploreNudge.hookSpecificOutput) {
      exploreNudge.hookSpecificOutput.additionalContext = composedCtx;
    }
    return exploreNudge;
  }

  const ingestLabel = detectSessionIngestLabel(event, command);
  if (
    outputInfo &&
    ingestLabel &&
    outputInfo.text.length > SESSION_INGEST_MIN_BYTES
  ) {
    const digest = trySessionIngest(extractSessionID(event), ingestLabel, outputInfo.text);
    if (digest && digest !== outputInfo.text) {
      recordTelemetry("session-ingest", outputInfo.text.length, digest.length, `${ingestLabel}:${command || event.tool_name}`);
      return makeResponse(event, outputInfo, digest, composedCtx);
    }
  }

  // Cap-nudge for Glob/Grep: replace native truncation marker with
  // tkr-flavored guidance. Only fires when the marker is present.
  if (event.tool_name === "Glob" || event.tool_name === "Grep") {
    const capNudgeText = applyCapNudge(event, outputInfo);
    if (capNudgeText !== null) {
      recordTelemetry(
        "cap-nudge",
        outputInfo.text.length,
        capNudgeText.length,
        event.tool_name,
      );
      return makeResponse(event, outputInfo, capNudgeText, composedCtx);
    }
  }

  // Non-Bash tools: no compression, but still reinforce brevity
  if (event.tool_name !== "Bash") {
    return brevityResponse(composedCtx);
  }

  const stdout = outputInfo?.field === "stdout" ? outputInfo.text : event.tool_response?.stdout || "";

  // AT-PLAN27: debug-gated CTX: ref emission to stderr.
  maybeEmitArtifactDebug(stdout);

  // Skip empty output — still reinforce brevity
  if (!stdout || stdout.length < 100) {
    return brevityResponse(composedCtx);
  }

  // Skip compression for commands already routed through tkr (PreToolUse
  // handled output filtering), but still reinforce brevity.
  if (/^\s*tkr\s/.test(command)) {
    return brevityResponse(composedCtx);
  }

  // Path 1: tkr search output (safety net for --verbose)
  if (/tkr\s+search\b/.test(command)) {
    const cleaned = stripSearchInternals(stdout);
    if (cleaned !== stdout) {
      recordTelemetry("search", stdout.length, cleaned.length, command);
      return makeResponse(event, outputInfo, cleaned, composedCtx);
    }
    return brevityResponse(composedCtx);
  }

  // Path 2: try TOML filter via tkr filter-stdin
  const filtered = tryFilterStdin(command, stdout);
  if (filtered !== null && filtered !== stdout) {
    recordTelemetry("compression", stdout.length, filtered.length, command);
    return makeResponse(event, outputInfo, filtered, composedCtx);
  }

  // No compression applied — still reinforce brevity
  return brevityResponse(composedCtx);
}

module.exports = {
  applyCapNudge,
  GLOB_TRUNC_MARKER,
  GREP_TRUNC_MARKER,
  // PR #5 c2 — Channel 2 exports for testing.
  ctxBreakpointContext,
  ctxBreakpointStatePath,
  CTX_BREAKPOINT_ADVISORIES,
  getTelemetryPath,
};
