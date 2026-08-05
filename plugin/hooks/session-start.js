#!/usr/bin/env node
// tkr SessionStart hook — orchestrator.
//
// Responsibility-aligned modules live under hooks/lib/sessionstart/:
//   brevity              — getBrevityMode + writeBrevityFlag + loadBrevitySection
//   memory-nudge         — INV-016 pre-turn-1 stderr nudge (24h dedup)
//   planning-nudge       — capability hint for plan-mode/blueprint planners
//   cache-mechanics-nudge — FROZEN proposal §5 Q4 prefix-cache framework
//   read-nudge           — LCTX-001 tkr_read map/signatures hint
//   budget-warning       — delegation budget + L0 pinned-budget warnings
//   continue             — L0R advisory: .continue-here.md (file-first) or JSONL fallback
//   snapshot             — load XML for /compact + /resume
//   sideeffects          — detached cleanup-old + capture-rules
//   search-refresh       — debounce + self-heal for `tkr search --refresh`
//   last-session-cw      — shared read of last-session-cw.json (5min TTL)
//
// This file keeps:
//   1. stdin entry + dispatch (runMain)
//   2. buildCoreGuidance composition
//   3. Test-surface re-exports (delete require.cache pattern in tests
//      depends on lazy stateDir() inside each module)
//
// Injection thresholds extracted to hooks/lib/injection-config.js per
// PR #4 so UserPromptSubmit (hot path) can read them without pulling
// the SessionStart module surface. Re-exported below for back-compat.

const { spawnBounded } = require("./lib/spawn-bounded");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { getSessionID } = require("./lib/session-id");

const {
  getBrevityMode,
  writeBrevityFlag,
  loadBrevitySection,
} = require("./lib/sessionstart/brevity");
const { emitMemoryNudge } = require("./lib/sessionstart/memory-nudge");
const { loadPlanningNudge } = require("./lib/sessionstart/planning-nudge");
const {
  loadCacheMechanicsNudge,
  shouldEmitCacheMechanicsNudge,
} = require("./lib/sessionstart/cache-mechanics-nudge");
const { loadReadNudge } = require("./lib/sessionstart/read-nudge");
const { loadGraduationNudge } = require("./lib/sessionstart/graduation-nudge");
const {
  getBudgetWarning,
  loadPinnedBudgetWarning,
} = require("./lib/sessionstart/budget-warning");
const { loadContinueAdvisory } = require("./lib/sessionstart/continue");
const { logSessionEffort, persistSessionEffort } = require("./lib/sessionstart/effort-log");
const { loadSnapshotXML } = require("./lib/sessionstart/snapshot");
const {
  spawnCleanupOld,
  spawnCaptureRules,
} = require("./lib/sessionstart/sideeffects");
const {
  sweepStaleStatuslineFiles,
} = require("./lib/sessionstart/statusline-sweep");
const {
  sweepStaleModeFiles,
  spawnModeAuto,
} = require("./lib/sessionstart/mode-bootstrap");
const { performTTLInference } = require("./lib/sessionstart/cache-ttl-inference");
const { sweepStaleWorkFiles } = require("./lib/work-route-state");
const { sweepStaleFirstBatchMarkers } = require("./post-tool-batch.js");
const {
  shouldFireSearchRefresh,
  countRecentRefreshTimeouts,
  REFRESH_DEBOUNCE_MS,
  REFRESH_STRIKE_LIMIT,
  REFRESH_STRIKE_WINDOW_MS,
} = require("./lib/sessionstart/search-refresh");
const {
  INJECTION_THRESHOLD_DEFAULTS,
  loadInjectionThresholds,
} = require("./lib/injection-config");
const {
  buildSubdirZoneSection,
} = require("./lib/sessionstart/subdir-zone");
const {
  ensureInstallStamp,
} = require("./lib/sessionstart/install-stamp");
const {
  appendVersionLedger,
} = require("./lib/sessionstart/version-ledger");

const extractSessionID = getSessionID;

// delegateNudge — mention `/tkr:delegate` only on advanced-tier
// installs (the skill ships in skills-advanced/, PUBLIC-009); on core
// installs the invocation fails, so the recommendation would be a
// dead end. Reads <stateDir>/plugin-tier lazily (mirrors
// signals.PluginTierLabel on the Go side). ADR-0022 framing:
// subagents are the primary surface; delegate is the cap-pressure
// escape valve.
function delegateNudge() {
  try {
    const fs = require("fs");
    const path = require("path");
    const { stateDir } = require("./lib/state-dir");
    const tier = fs.readFileSync(path.join(stateDir(), "plugin-tier"), "utf8").trim();
    if (tier === "advanced") {
      return " Under cap pressure, `/tkr:delegate` escalates to paid non-Claude backends.";
    }
  } catch {
    // no tier file (core or CLI-only install) → omit the mention
  }
  return "";
}

// Build the core guidance block (brevity + plugin awareness).
function buildCoreGuidance(sid, projectPath) {
  const brevityMode = getBrevityMode();
  writeBrevityFlag(brevityMode);
  const brevitySection = loadBrevitySection(brevityMode);
  const budgetWarning = getBudgetWarning();
  const pinnedWarning = loadPinnedBudgetWarning(sid);
  const resumeAdvisory = loadContinueAdvisory(sid, projectPath);
  const planningNudge = loadPlanningNudge();
  const cacheMechanicsNudge = loadCacheMechanicsNudge();
  const readNudge = loadReadNudge();
  // #52: one-time suggest→rewrite prompt. STATE, not standing guidance —
  // it reports what this user's own history says — so it rides dynamicState
  // and fires on the TKR_SYSPROMPT path too. Empty on all but one session.
  const graduationNudge = loadGraduationNudge();
  // Item 8c: when cwd != project root, emit a CLAUDE.md chain
  // summary + matching zone command list so the model prefers
  // zone-scoped test/lint/build over repo-wide. Best-effort — any
  // failure yields an empty string. Note: the proposal's
  // `tkr-hint: cd <subdir>` first-prompt heuristic is unimplementable
  // from SessionStart (the user prompt hasn't arrived yet); see
  // docs/proposals/2026-05-21-anthropic-large-repo-gap-closure.md.
  let subdirZoneSection = "";
  try {
    subdirZoneSection = buildSubdirZoneSection({
      repoRoot: projectPath,
      cwd: process.cwd(),
    });
  } catch {}

  // Per-session STATE — always emitted; this is the hook's job under the
  // v5.5.0 division of labor (system prompt = standing guidance, hooks =
  // state). Loaders above still run unconditionally so their side effects
  // (e.g. writeBrevityFlag) fire on every path.
  const dynamicState =
    `${budgetWarning}${pinnedWarning}${resumeAdvisory}` +
    `${subdirZoneSection}${brevitySection}${graduationNudge}`;

  // Standing guidance (tkr_search / compressed-output / delegate + the
  // planning, cache-mechanics, and read nudges) is ALSO baked into the
  // pinned tkr system prompt (internal/sysprompt/data/system-prompt.md),
  // which `tkr claude` delivers via --system-prompt-file and flags by
  // setting TKR_SYSPROMPT=1 on the child env. When that marker is present,
  // emitting the same guidance here is pure duplication in early context —
  // drop it and emit STATE only. When absent (plain `claude`, no pinned
  // tkr prompt) the SessionStart block is the only delivery channel, so
  // emit the full standing block.
  if (process.env.TKR_SYSPROMPT === "1") {
    return `${dynamicState}\n`;
  }

  return (
    `## tkr plugin active\n\n` +
    `**Before reading unfamiliar files, call \`tkr_search\` (MCP tool).** ` +
    `Ranks docs > code > diagrams. Use \`context_pack=true\` for grouped ` +
    `results. Skip only when you already know the exact path — don't ` +
    `chain Glob/Grep/Read instead.\n\n` +
    `**Tool output is already compressed.** Large outputs (WebFetch, and ` +
    `Bash grep/curl beyond ~8 KB) collapse to a session ref — drill in ` +
    `with \`tkr_search session=<id>\`.\n\n` +
    `**For bounded mechanical work** (boilerplate, cross-file rename, test ` +
    `scaffolding), dispatch a subagent (Agent tool) instead of working in ` +
    `main.${delegateNudge()}` +
    `${planningNudge}${cacheMechanicsNudge}${readNudge}` +
    `${dynamicState}\n`
  );
}

// Module exports for unit tests. Guarded so importing the hook from a
// test doesn't kick off the stdin read.
if (require.main !== module) {
  module.exports = {
    shouldFireSearchRefresh,
    countRecentRefreshTimeouts,
    REFRESH_DEBOUNCE_MS,
    REFRESH_STRIKE_LIMIT,
    REFRESH_STRIKE_WINDOW_MS,
    loadCacheMechanicsNudge,
    shouldEmitCacheMechanicsNudge,
    loadInjectionThresholds,
    INJECTION_THRESHOLD_DEFAULTS,
    buildCoreGuidance,
    delegateNudge,
  };
  return;
}

// Read stdin, branch on source, emit guidance.
// CR-06 + M-12: stdin-timeout helper + master kill switch. SessionStart is
// the first hook to fire — a hang here freezes the entire session before
// the first prompt.
function runMain(inputRaw) {
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    // Malformed or empty stdin — treat as startup
  }

  const source = (input.source || "startup").toLowerCase();
  const sid = extractSessionID(input);

  // Write the install stamp on first-ever startup for marketplace users.
  // Best-effort (ensureInstallStamp swallows all errors internally).
  // Runs on every source to catch edge cases, but stamp is only written
  // once (O_EXCL ensures idempotency).
  ensureInstallStamp();

  // Append one row per (session_id, tkr_version, UTC-day) to the version
  // ledger for Plan 0.75 / ADR-008 (tkr report framework, Phase 1 writer).
  // Best-effort — appendVersionLedger swallows all errors internally.
  appendVersionLedger(sid);

  let snapshotPrefix = "";

  if (source === "compact" || source === "resume") {
    // Load saved snapshot and prepend to guidance so the model sees
    // prior session context immediately after compact.
    const xml = loadSnapshotXML(sid);
    if (xml) {
      snapshotPrefix = xml + "\n\n";
    }
  }

  const projectPath = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // L-07: cleanup runs on startup AND on resume/compact (was startup-only).
  // Long sessions that resume from /compact never pruned otherwise.
  if (source === "startup" || source === "resume" || source === "compact") {
    // Fire-and-forget: prune >7-day session rows from SQLite.
    spawnCleanupOld(projectPath);
    // Best-effort: prune leftover per-session statusline payloads from
    // crashed sessions where Stop never ran. Sync local-fs scan, bounded
    // by tmpdir entry count — runs in <5ms typical.
    try { sweepStaleStatuslineFiles(); } catch {}
    // PLAN-33: same policy for per-session mode-<sid>.json under ~/.tkr/.
    // Crashed sessions leave these behind; without sweep the dir grows
    // unbounded over the project lifetime.
    try { sweepStaleModeFiles(); } catch {}
    // Same 24h policy for work-routing receipts and per-plan claims.
    // Claims are one file per plan actually acted on, so an assisted
    // session accumulates them slowly but without bound.
    try { sweepStaleWorkFiles(); } catch {}
    // Same 24h policy for first-batch-<sid>.json dedup markers
    // (#134 R0.2) — one per session id, crashed sessions never clean up.
    try { sweepStaleFirstBatchMarkers(); } catch {}
    // Forward-looking effort telemetry — JSONL records don't carry
    // effort, so SessionStart is the earliest capture point. Append
    // one row to ~/.tkr/session-effort.jsonl per session-start event.
    try { logSessionEffort(sid, input); } catch {}
    // Persist the same detection to effort-<sid>.json so the shape
    // nudge in user-prompt-submit can read active effort when the
    // effort env vars are absent from its own environment.
    try { persistSessionEffort(sid, input); } catch {}
  }
  if (source === "startup") {
    // Fire-and-forget: capture CLAUDE.md paths so they survive /compact (PLAN-6).
    spawnCaptureRules(sid, projectPath);
    // INV-016: pre-turn-1 memory-health nudge (stderr, one line, 24h dedup).
    try { emitMemoryNudge(projectPath); } catch {}
    // PLAN-1 T7 (Wave-0, v3.13.1): infer prompt-cache TTL once per session
    // start and append L6 to the playbook ledger when evidence is present.
    // Sibling hooks (cache-bust-warn / push-clear-nudge / pre-compact) call
    // detectTTL independently; the persisted inference from this call
    // makes those calls near-free.
    try { performTTLInference(sid); } catch {}
    // PLAN-33: refresh per-session mode-<sid>.json from live pressure so
    // the statusline never paints a leftover badge from a prior session.
    // Fire-and-forget; binary writes via TickAuto in <100ms.
    try { spawnModeAuto(sid, spawnBounded); } catch {}
  }

  process.stdout.write(snapshotPrefix + buildCoreGuidance(sid, projectPath));

  // Auto-refresh search index so `tkr search` returns results immediately.
  // Bounded fire-and-forget: hook-side debounce skips if last fire <60s
  // ago; spawnBounded caps hangs at 60s; binary-side proclock + mtime
  // short-circuit are the authoritative singleton guards. Fixes v3.9.0
  // pile-up where 3 cold-boot sessions stacked 40+ tkr.exe procs behind
  // concurrent graph-build runs.
  if (shouldFireSearchRefresh()) {
    try {
      const child = spawnBounded("tkr", ["search", "--refresh"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }, 60_000);
      if (child) {
        child.on("error", () => {});
        child.unref();
      }
    } catch {
      // Best-effort — don't block session start if tkr binary missing
    }
  }
}

if (hooksDisabled()) {
  process.exit(0);
} else {
  readStdinWithTimeout(3000)
    .then(runMain)
    .catch(() => {
      // On stdin timeout, still emit core guidance so first turn isn't naked.
      // Treat as startup with no session_id.
      try {
        const projectPath = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        process.stdout.write(buildCoreGuidance("", projectPath));
      } catch {}
      process.exit(0);
    });
}
