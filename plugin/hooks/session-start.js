#!/usr/bin/env node
// tkr SessionStart hook — orchestrator.
//
// Responsibility-aligned modules live under hooks/lib/sessionstart/:
//   brevity              — getBrevityMode + writeBrevityFlag + loadBrevitySection
//   memory-nudge         — INV-016 pre-turn-1 nudge, systemMessage (24h dedup)
//   planning-nudge       — capability hint for plan-mode/blueprint planners
//   cache-mechanics-nudge — FROZEN proposal §5 Q4 prefix-cache framework
//   read-nudge           — LCTX-001 tkr_read map/signatures hint
//   goal-nudge            — #381 item 18: one capped bullet for `tkr goal`
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
const { tkrSpawnArgv } = require("./lib/tkr-bin");

const {
  getBrevityMode,
  writeBrevityFlag,
  loadBrevitySection,
} = require("./lib/sessionstart/brevity");
const { loadMemoryNudge, recordMemoryNudge } = require("./lib/sessionstart/memory-nudge");
const { loadPlanningNudge } = require("./lib/sessionstart/planning-nudge");
const {
  loadCacheMechanicsNudge,
  shouldEmitCacheMechanicsNudge,
} = require("./lib/sessionstart/cache-mechanics-nudge");
const { loadReadNudge } = require("./lib/sessionstart/read-nudge");
const { loadGoalBullet } = require("./lib/sessionstart/goal-nudge");
const { loadGraduationNudge } = require("./lib/sessionstart/graduation-nudge");
const {
  getBudgetWarning,
  loadPinnedBudgetWarning,
} = require("./lib/sessionstart/budget-warning");
const { loadContinue } = require("./lib/sessionstart/continue");
const {
  shouldFireSearchRefresh,
  countRecentRefreshTimeouts,
  REFRESH_DEBOUNCE_MS,
  REFRESH_STRIKE_LIMIT,
  REFRESH_STRIKE_WINDOW_MS,
} = require("./lib/sessionstart/search-refresh");
const {
  buildSubdirZoneSection,
} = require("./lib/sessionstart/subdir-zone");
const {
  ensureInstallStamp,
} = require("./lib/sessionstart/install-stamp");
const {
  appendVersionLedger,
} = require("./lib/sessionstart/version-ledger");

// The modules below are required LAZILY (at point of use) because each is
// only reached on a conditional code path (a specific `source` value, or
// the test-export branch), never on every SessionStart invocation. All were
// inspected for import-time side effects (file writes, env mutation,
// spawns, handler registration) before being made lazy — each defines only
// functions/constants at module scope and module.exports at the bottom; see
// commit for the per-module note. In-process measurement
// (`node -e` timing `process.hrtime.bigint()` around each require) showed
// the FULL eager require graph costs ~24-26ms total on this box, not the
// ~450ms this task was scoped against — see commit message for the full
// breakdown. Lazy-loading is still correct/lower-risk even though the
// absolute saving is small.
//   ./lib/sessionstart/effort-log            — logSessionEffort/persistSessionEffort, startup|resume|compact only
//   ./lib/sessionstart/snapshot              — loadSnapshotXML, compact|resume only
//   ./lib/sessionstart/sideeffects           — spawnCleanupOld/spawnCaptureRules/spawnKeepalivePrune, startup|resume|compact / startup only
//   ./lib/sessionstart/statusline-sweep      — sweepStaleStatuslineFiles, startup|resume|compact only
//   ./lib/sessionstart/mode-bootstrap        — sweepStaleModeFiles/spawnModeAuto, startup|resume|compact / startup only
//   ./lib/sessionstart/cache-ttl-inference   — performTTLInference, startup only
//   ./lib/work-route-state                   — sweepStaleWorkFiles, startup|resume|compact only
//   ./post-tool-batch.js                     — sweepStaleFirstBatchMarkers, startup|resume|compact only
//   ./lib/sessionstart/skill-manifest-refresh — refreshSkillManifestIfStale, startup only
//   ./lib/sessionstart/resident-warm         — warmResidentRuntime, startup|resume only
//   ./lib/injection-config                   — loadInjectionThresholds/INJECTION_THRESHOLD_DEFAULTS,
//                                               used only in the test-export branch (require.main !== module)

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
//
// `out` is an optional collector for output that must NOT be concatenated
// into the returned string — currently just `out.systemMessage` (HAND-008),
// which is user-facing and would be noise in model context. It is a
// parameter rather than a second return value because the string return is
// what every caller and test already consumes, and because the one producer
// (loadContinue) has a telemetry side effect that must fire exactly once.
function buildCoreGuidance(sid, projectPath, source, out) {
  // `tkr claude` pins the replacement system prompt and flags it with
  // TKR_SYSPROMPT=1. Its `# Tone and output` section is the session's only
  // voice spec by construction, so the brevity block must not ship there.
  const pinnedSysprompt = process.env.TKR_SYSPROMPT === "1";
  const brevityMode = getBrevityMode();
  writeBrevityFlag(brevityMode);
  // Emitting brevity alongside the pinned prompt shipped a SECOND voice spec
  // as a system-reminder, contradicting the first (drop-articles vs. ordinary
  // prose) at a different authority level. Measured effect of the pair: none —
  // 8.57 articles/100w across 396K words of assistant prose, i.e. baseline
  // English, with compliance visible on turn 1 only. A model handed competing
  // specs falls back to its own register. Plain `claude` has no pinned prompt,
  // so there the block is still the only voice guidance and still ships.
  const brevitySection = pinnedSysprompt ? "" : loadBrevitySection(brevityMode);
  const budgetWarning = getBudgetWarning();
  const pinnedWarning = loadPinnedBudgetWarning(sid);
  const continueResult = loadContinue(sid, projectPath, source);
  const resumeAdvisory = continueResult.context;
  if (out && continueResult.systemMessage) {
    // Append rather than overwrite — `out` may already carry a
    // systemMessage from an earlier caller (e.g. the #357 memory nudge,
    // startup-only) even though today's source gating keeps the two
    // mutually exclusive in practice.
    out.systemMessage = out.systemMessage
      ? `${out.systemMessage}\n${continueResult.systemMessage}`
      : continueResult.systemMessage;
  }
  const planningNudge = loadPlanningNudge();
  const cacheMechanicsNudge = loadCacheMechanicsNudge();
  const readNudge = loadReadNudge();
  // #381 item 18: durable user-set goal, read fresh every SessionStart —
  // per-session STATE like resumeAdvisory below, not standing guidance, so
  // it belongs in dynamicState and fires even under TKR_SYSPROMPT=1.
  const goalBullet = loadGoalBullet(projectPath);
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
    `${budgetWarning}${pinnedWarning}${resumeAdvisory}${goalBullet}` +
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
  if (pinnedSysprompt) {
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
  const {
    INJECTION_THRESHOLD_DEFAULTS,
    loadInjectionThresholds,
  } = require("./lib/injection-config");
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
    const { loadSnapshotXML } = require("./lib/sessionstart/snapshot");
    const xml = loadSnapshotXML(sid);
    if (xml) {
      snapshotPrefix = xml + "\n\n";
    }
  }

  const projectPath = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // HAND-008 output collector, declared here (rather than just before the
  // stdout write) so the startup-only memory nudge below can plumb its
  // message into the same `systemMessage` channel buildCoreGuidance uses.
  const out = {};
  // L-07: cleanup runs on startup AND on resume/compact (was startup-only).
  // Long sessions that resume from /compact never pruned otherwise.
  if (source === "startup" || source === "resume" || source === "compact") {
    const {
      spawnCleanupOld,
      spawnKeepalivePrune,
    } = require("./lib/sessionstart/sideeffects");
    // Fire-and-forget: prune >7-day session rows from SQLite.
    spawnCleanupOld(projectPath);
    // INV-085 adjacent finding: ~/.tkr/keepalive/<sid>/ dirs from crashed
    // sessions never reaped (cleanup.sh runs only on clean SessionEnd), so
    // watcher-state inspection and KEEP-006 fire accounting saw ghosts.
    // The Go verb validates against the CC session registry before removing.
    spawnKeepalivePrune();
    // Best-effort: prune leftover per-session statusline payloads from
    // crashed sessions where Stop never ran. Sync local-fs scan, bounded
    // by tmpdir entry count — runs in <5ms typical.
    try {
      const { sweepStaleStatuslineFiles } = require("./lib/sessionstart/statusline-sweep");
      sweepStaleStatuslineFiles();
    } catch {}
    // PLAN-33: same policy for per-session mode-<sid>.json under ~/.tkr/.
    // Crashed sessions leave these behind; without sweep the dir grows
    // unbounded over the project lifetime.
    try {
      const { sweepStaleModeFiles } = require("./lib/sessionstart/mode-bootstrap");
      sweepStaleModeFiles();
    } catch {}
    // Same 24h policy for work-routing receipts and per-plan claims.
    // Claims are one file per plan actually acted on, so an assisted
    // session accumulates them slowly but without bound.
    try {
      const { sweepStaleWorkFiles } = require("./lib/work-route-state");
      sweepStaleWorkFiles();
    } catch {}
    // Same 24h policy for first-batch-<sid>.json dedup markers
    // (#134 R0.2) — one per session id, crashed sessions never clean up.
    try {
      const { sweepStaleFirstBatchMarkers } = require("./post-tool-batch.js");
      sweepStaleFirstBatchMarkers();
    } catch {}
    // Forward-looking effort telemetry — JSONL records don't carry
    // effort, so SessionStart is the earliest capture point. Append
    // one row to ~/.tkr/session-effort.jsonl per session-start event.
    try {
      const { logSessionEffort } = require("./lib/sessionstart/effort-log");
      logSessionEffort(sid, input);
    } catch {}
    // Persist the same detection to effort-<sid>.json so the shape
    // nudge in user-prompt-submit can read active effort when the
    // effort env vars are absent from its own environment. Session
    // lifecycle hooks are not given effort, so this normally detects
    // nothing — but a launch boundary is the one place where "nothing
    // detected" legitimately clears a snapshot left by a prior launch
    // of this sid.
    try {
      const { persistSessionEffort } = require("./lib/sessionstart/effort-log");
      persistSessionEffort(sid, input, process.env, { clearWhenAbsent: true });
    } catch {}
  }
  // #287: warm the opt-in resident runtime (#209) so the FIRST eligible Bash
  // call of the session is served by it rather than paying the fresh-process
  // fallback and starting the runtime for the call after it.
  //
  // Runs on startup AND resume, not compact. Startup is the obvious case;
  // resume is a session that has been away long enough to plausibly have
  // crossed the runtime's 30m idle shutdown, and it is followed by real Bash
  // traffic just like a startup. Compact happens mid-session where a runtime
  // is either already up (warm() reads one file and two stats, then returns
  // already_warm) or was suppressed for a reason that still holds — so the
  // call would be a near-no-op and is skipped rather than dressed up as one.
  //
  // Placed with the other fire-and-forget work, BEFORE the stdout write: the
  // spawn is detached and unref'd, so the head start it buys the runtime is
  // worth more than the sub-millisecond it delays the guidance this process
  // is about to print and exit on. It is a no-op on every install that has
  // not opted in, which is currently all of them.
  if (source === "startup" || source === "resume") {
    try {
      const { warmResidentRuntime } = require("./lib/sessionstart/resident-warm");
      warmResidentRuntime({ cwd: projectPath });
    } catch {}
  }
  if (source === "startup") {
    // Fire-and-forget: capture CLAUDE.md paths so they survive /compact (PLAN-6).
    const { spawnCaptureRules } = require("./lib/sessionstart/sideeffects");
    spawnCaptureRules(sid, projectPath);
    // INV-016 / #357: pre-turn-1 memory-health nudge, one line, 24h dedup.
    // Routed into `out.systemMessage` (HAND-008's user-facing channel),
    // never stderr — stderr on an exit-0 hook reaches only the debug log
    // (hooks/CLAUDE.md Hook contract). recordMemoryNudge() (the 24h dedup
    // write) fires ONLY here, immediately after the message is actually
    // assembled into `out.systemMessage`, so the dedup state can never
    // record a nudge that was never delivered.
    try {
      const nudgeMsg = loadMemoryNudge(projectPath);
      if (nudgeMsg) {
        out.systemMessage = out.systemMessage
          ? `${out.systemMessage}\n${nudgeMsg}`
          : nudgeMsg;
        recordMemoryNudge();
      }
    } catch {}
    // PLAN-1 T7 (Wave-0, v3.13.1): infer prompt-cache TTL once per session
    // start and append L6 to the playbook ledger when evidence is present.
    // Sibling hooks (cache-bust-warn / push-clear-nudge / pre-compact) call
    // detectTTL independently; the persisted inference from this call
    // makes those calls near-free.
    try {
      const { performTTLInference } = require("./lib/sessionstart/cache-ttl-inference");
      performTTLInference(sid);
    } catch {}
    // PLAN-33: refresh per-session mode-<sid>.json from live pressure so
    // the statusline never paints a leftover badge from a prior session.
    // Fire-and-forget; binary writes via TickAuto in <100ms.
    try {
      const { spawnModeAuto } = require("./lib/sessionstart/mode-bootstrap");
      spawnModeAuto(sid, spawnBounded);
    } catch {}
    // #263 follow-up: keep skill-manifest.json current so the first-
    // invocation gate doesn't go permanently blind after a CLI upgrade.
    // Cheap staleness check; detached rescrape only when stale.
    try {
      const { refreshSkillManifestIfStale } = require("./lib/sessionstart/skill-manifest-refresh");
      refreshSkillManifestIfStale();
    } catch {}
  }

  // HAND-008: two output formats, deliberately. Plain stdout is what this
  // hook has always emitted and what every session depends on; the docs
  // call it "added as context" and call `additionalContext` "injected into
  // Claude's conversation", but never state the two are equivalent. That
  // equivalence is near-certain and uncited, so only the path that NEEDS
  // JSON — the one carrying a user-facing `systemMessage` — takes it. It
  // fires on a handful of sessions, which keeps the blast radius of a wrong
  // guess to those, and makes them the experiment that would justify
  // migrating the rest. `out` was declared earlier in this function (see
  // the #357 memory-nudge block above) so that startup-only source can
  // feed this same channel.
  const guidance = snapshotPrefix + buildCoreGuidance(sid, projectPath, source, out);
  if (out.systemMessage) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: guidance,
        },
        systemMessage: out.systemMessage,
      }),
    );
  } else {
    process.stdout.write(guidance);
  }

  // Auto-refresh search index so `tkr search` returns results immediately.
  // Bounded fire-and-forget: hook-side debounce skips if last fire <60s
  // ago; spawnBounded caps hangs at 60s; binary-side proclock + mtime
  // short-circuit are the authoritative singleton guards. Fixes v3.9.0
  // pile-up where 3 cold-boot sessions stacked 40+ tkr.exe procs behind
  // concurrent graph-build runs.
  if (shouldFireSearchRefresh()) {
    try {
      const { cmd, argv } = tkrSpawnArgv(["search", "--refresh"]);
      const child = spawnBounded(cmd, argv, {
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
