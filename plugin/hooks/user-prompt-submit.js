#!/usr/bin/env node
// tkr UserPromptSubmit hook — brevity reinforcement + cold-resume warning.
//
// Runs on every user prompt. Detects /brevity (and /tkr-brevity alias) mode
// commands and updates state files so other hooks stay in sync. Also detects
// cold-cache resume (idle > 5m) and injects an actionable cost warning
// (REPORT-002 Feature 2).
//
// Recognized commands (canonical `/brevity`; `/tkr-brevity` is a transition alias):
//   /brevity                → set brevity to configured default (full)
//   /brevity lite           → set brevity to lite
//   /brevity full           → set brevity to full
//   /brevity ultra          → set brevity to ultra
//   /brevity off            → disable brevity
//   "stop brevity"          → disable brevity
//   "normal mode"           → disable brevity

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { spawnBounded } = require("./lib/spawn-bounded");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { rotateIfLarge } = require("./lib/rotate-jsonl");
const { getTelemetryPath } = require("./lib/statusline-path");
const { stateDir } = require("./lib/state-dir");
const slashMarker = require("./lib/slash-marker");
const { getSessionID } = require("./lib/session-id");
const { activityTouch } = require("./lib/keepalive-activity");
const { persistSessionEffort } = require("./lib/sessionstart/effort-log");

const TKR_STATE_DIR = stateDir();

const BREVITY_FLAG = path.join(TKR_STATE_DIR, "brevity-mode");
const VALID_MODES = ["off", "lite", "full", "ultra"];
const DEFAULT_MODE = "full";

// PR #1 — Phase 1 telemetry. Per-turn JSONL append; consumed by
// scripts/session_analysis/injection_roi.py (PR #2). Best-effort,
// never blocks user prompts on log failure. Disable via env flag.
// See docs/proposals/2026-05-12-prefix-aware-context-injection.md §7
// Phase 1 + §11.2 PR #1.
//
// Row schema split — architectural call:
//   Hot-path writes 10 cheap fields from input + claude-statusline.json.
//   PR #2 (injection_roi.py) hydrates 5 additional fields post-hoc via
//   parser.py ground-truth join on (session_id, turn): model_id,
//   is_subagent, is_resume, rate_class, total_cost_so_far_cents.
//   The 10th field (md, added with the ADR-0010 verdict-channel
//   addendum) records the active injection modes as
//   "<route[0]>/<state[0]>" — e.g. "m/b" defaults, "a/e" legacy — so
//   A/B windows split by arm without time-boxing. ~11 bytes, inside
//   the H-10 200-byte row cap.
//
// Post-hoc fields are NOT written here. Reason: §7 + safety-audit H-10
// cap rows at ≤200 bytes for rotation friendliness; including 5 empty
// strings + UUID session_id pushes a single row past 200 bytes. Hot
// path stays slim; analytics joiner adds richer columns. Stable shape
// IS preserved within the hot-path 10-field set — every row carries all
// 10 keys even when source telemetry is absent (sentinels: numeric=-1
// for "missing", 0 for "absent-but-known", string="" for session_id).
//
// Two field-name shortenings vs proposal text to fit 200-byte cap with
// realistic UUID session_id (no collision with parser.py fields):
//   session_age_seconds  →  age_s     (matches SessionStart `age=Ns`)
//   hook_inject_bytes    →  inject_b
// Document the rename in PR #2 join script.
const INJECTION_LOG = path.join(TKR_STATE_DIR, "injection-events.jsonl");
const INJECTION_LOG_MAX_BYTES = 10 * 1024 * 1024;
const INJECTION_SESSION_START_PREFIX = "injection-session-start-";

// Cold-resume: fire when idle exceeds 5 minutes (300s) and cost > $0.05.
const COLD_RESUME_IDLE_SECS = 300;
const COLD_RESUME_MIN_CENTS = 5;
// Pre-TTL warning: 60s before the 5m cache TTL expires. Lets the user
// type now and keep the cache alive instead of paying the rebuild after
// the fact. Same min-cost gate as cold-resume.
const PRE_TTL_IDLE_SECS = 240;

// PlaybookV2 L1 — idle-gap warning. Fires once per session per threshold
// crossing when idle ≥ 5m AND context is non-trivial (last_ctx_k ≥ 100K).
// Independent of cold-resume's $-based gate so we capture cliff-cost
// scenarios that cold-resume's COLD_RESUME_MIN_CENTS filter misses.
const L1_IDLE_SECS = 300;
const L1_LAST_CTX_K = 100;

// PlaybookV2 L2 — handoff-offer detector. Fires once per session when the
// session is composed of high-classification turns AND turn count is past
// the cliff-warning threshold AND the conversation is heavy on cache-read
// (signal that the working set is bloated and a fresh-context handoff
// would recover headroom). Per architecture plan §AD-5.
const L2_TURN_COUNT = 80;
const L2_CACHE_READ_PCT = 60;
const L2_CLASSIFICATIONS = new Set(["high", "critical"]);

// Per-session telemetry path resolved lazily — every call site pulls
// process.env.TKR_SESSION_ID (set by runMain after extractSessionID) so
// the hook reads/writes only THIS session's payload. Module-init resolution
// would happen before runMain populates sid env — see the v2 path comment
// in hooks/lib/statusline-path.js for context on the stale-injection bug.

function ensureStateDir() {
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function setBrevityMode(mode) {
  ensureStateDir();
  if (mode === "off") {
    try {
      fs.unlinkSync(BREVITY_FLAG);
    } catch {
      // ignore
    }
  } else {
    fs.writeFileSync(BREVITY_FLAG, mode, "utf8");
  }
}

// Derive session ID via hooks/lib/session-id (single source of truth).
const extractSessionID = getSessionID;

// Fire-and-forget: classify prompt + persist to session_events (PLAN-5).
// 5s hard kill cap so a hung child can't accumulate across sessions.
function spawnRecordPromptEvent(rawInput, sid) {
  try {
    const child = spawnBounded(
      "tkr",
      ["session", "record-event", "--source", "UserPromptSubmit", "--session-id", sid],
      { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
      5_000,
    );
    if (!child) return;
    child.on("error", () => {});
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(rawInput);
    }
    child.unref();
  } catch {
    // Best-effort — never fail the hook for session telemetry
  }
}

// coldResumeContext returns a warning string when idle > 5m and rebuild cost
// is non-trivial, or "" when conditions are not met. Reads telemetry file only;
// no JSONL scan on the hot path.
//
// Two tiers:
//   PRE_TTL  (240s..300s) — "type now, cache expires soon" — user can save the
//                           rebuild cost by acting before TTL.
//   COLD     (>=300s)     — existing post-TTL message — cache already gone.
function coldResumeContext(telemetryPath, telOverride) {
  const tel = getTel(telemetryPath, telOverride);
  if (!tel) return "";
  try {
    const idleSecs = typeof tel.idle_secs === "number" ? tel.idle_secs : -1;
    const missCents = typeof tel.projected_miss_cents === "number"
      ? tel.projected_miss_cents : 0;

    if (idleSecs < PRE_TTL_IDLE_SECS || missCents < COLD_RESUME_MIN_CENTS) {
      return "";
    }

    const idleMin = Math.round(idleSecs / 60);
    const dollars = (missCents / 100).toFixed(2);
    const sevenDayPct = typeof tel.seven_day_pct === "number" ? tel.seven_day_pct : 0;

    if (idleSecs < COLD_RESUME_IDLE_SECS) {
      // Pre-TTL: cache still alive. Reward action.
      const secsLeft = COLD_RESUME_IDLE_SECS - idleSecs;
      return `[tkr pre-TTL: idle ${idleMin}m — cache expires in ~${secsLeft}s, ` +
        `~$${dollars} rebuild cost if you wait. Type now to keep prefix cached.]`;
    }

    let msg = `[tkr cold-resume: idle ${idleMin}m — ~$${dollars} cache rebuild cost`;
    if (sevenDayPct >= 70) {
      msg += ` (7d cap ${sevenDayPct}% — consider /clear to reset context cheaply)`;
    } else {
      msg += ` — /clear resets context at lower cost if this session is done`;
    }
    msg += `]`;
    return msg;
  } catch {
    return "";
  }
}

// l1StatePath returns the per-session dedup file for L1. Honors TKR_STATE_DIR.
function l1StatePath(sid) {
  return path.join(TKR_STATE_DIR, `l1-state-${sid || "default"}.json`);
}

function readL1State(sid) {
  try {
    return JSON.parse(fs.readFileSync(l1StatePath(sid), "utf8"));
  } catch {
    return null;
  }
}

function writeL1State(sid, state) {
  // M-10: atomic tmp+rename.
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    const target = l1StatePath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// l1IdleGapContext — Wave 3 L1 detector. Returns the cliff-cost warning
// string when idle ≥ 5m AND last_ctx_k ≥ 100K AND not deduped this
// session. Per-session-per-threshold dedup: subsequent prompts within
// the same idle window stay quiet. After the user acts (idle resets),
// the next threshold crossing fires again.
function l1IdleGapContext(sid, telemetryPath, telOverride) {
  if (process.env.TKR_PLAYBOOK_L1_DISABLED === "1") return "";
  if (process.env.TKR_PLAYBOOK_DISABLED === "1") return "";

  const tel = getTel(telemetryPath, telOverride);
  if (!tel) return "";
  const idleSecs = typeof tel.idle_secs === "number" ? tel.idle_secs : -1;
  const lastCtxK = typeof tel.last_ctx_k === "number" ? tel.last_ctx_k : 0;
  if (idleSecs < L1_IDLE_SECS || lastCtxK < L1_LAST_CTX_K) {
    // User has acted (idle reset) — clear the dedup marker so the next
    // crossing can fire again.
    const prev = readL1State(sid);
    if (prev && prev.armed === false) {
      writeL1State(sid, { armed: true, last_fire_at: prev.last_fire_at || 0 });
    }
    return "";
  }

  const state = readL1State(sid) || { armed: true, last_fire_at: 0 };
  if (state.armed === false) {
    // Already fired this idle window; suppress until user acts.
    return "";
  }

  const idleMin = Math.round(idleSecs / 60);
  const missCents =
    typeof tel.projected_miss_cents === "number" ? tel.projected_miss_cents : 0;
  const dollars = (missCents / 100).toFixed(2);

  try {
    const emit = require("./lib/playbook-emit");
    emit.emitEvent(
      "L1",
      "fired",
      {
        idle_secs: idleSecs,
        last_ctx_k: lastCtxK,
        projected_miss_cents: missCents,
        pre_ttl: idleSecs < COLD_RESUME_IDLE_SECS,
      },
      null,
      sid,
    );
  } catch {}

  writeL1State(sid, { armed: false, last_fire_at: Date.now() });

  return (
    `[L1 idle-gap] idle ${idleMin}m, ctx ${lastCtxK}K — cliff-cost ~$${dollars} ` +
    `if cache rebuild fires; type now or /clear if context can be discarded.`
  );
}

// l2StatePath — per-session dedup file for L2 detector.
function l2StatePath(sid) {
  return path.join(TKR_STATE_DIR, `l2-state-${sid || "default"}.json`);
}

function readL2State(sid) {
  try {
    return JSON.parse(fs.readFileSync(l2StatePath(sid), "utf8"));
  } catch {
    return null;
  }
}

function writeL2State(sid, state) {
  // M-10: atomic tmp+rename.
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    const target = l2StatePath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// l2HandoffContext — Wave 4 L2 detector. Returns advisory string when
// classification ≥ high AND turn_count ≥ 80 AND cache_read_share_pct > 60.
// Per-session dedup: fires at most once per session_id. Suppressible via
// TKR_PLAYBOOK_L2_DISABLED (detector only — skill stays user-invocable).
function l2HandoffContext(sid, telemetryPath, telOverride) {
  if (process.env.TKR_PLAYBOOK_L2_DISABLED === "1") return "";
  if (process.env.TKR_PLAYBOOK_DISABLED === "1") return "";

  const tel = getTel(telemetryPath, telOverride);
  if (!tel) return "";
  const classification = String(tel.rate_class || tel.classification || "").toLowerCase();
  const turnCount = typeof tel.turn_count === "number" ? tel.turn_count : 0;
  const cacheReadPct =
    typeof tel.cache_read_share_pct === "number"
      ? tel.cache_read_share_pct
      : typeof tel.cache_hit_pct === "number"
      ? tel.cache_hit_pct
      : 0;
  const lastCtxK = typeof tel.last_ctx_k === "number" ? tel.last_ctx_k : 0;

  if (
    !L2_CLASSIFICATIONS.has(classification) ||
    turnCount < L2_TURN_COUNT ||
    cacheReadPct <= L2_CACHE_READ_PCT
  ) {
    return "";
  }

  const state = readL2State(sid);
  if (state && state.fired === true) {
    return "";
  }

  try {
    const emit = require("./lib/playbook-emit");
    emit.emitEvent(
      "L2",
      "fired",
      {
        classification,
        turn_count: turnCount,
        cache_read_share_pct: cacheReadPct,
        last_ctx_k: lastCtxK,
      },
      null,
      sid,
    );
  } catch {}

  writeL2State(sid, { fired: true, fire_at: Date.now() });

  return (
    `[L2 handoff] composed-band ${classification} + turn ${turnCount} + ` +
    `cache-read ${cacheReadPct}% — invoke /handoff to write structured ` +
    `.continue-here.md, then /clear to reset cache cheaply.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// L7 session-shape advisor — shapeAdvisorContext + helpers.
//
// Two once-per-session triggers that nudge /tkr:handoff + /clear at a natural
// boundary when the session's SHAPE (not just its size) makes a fresh prefix
// cheaper. Modeled on l2HandoffContext: per-session state file, playbook emit,
// at most one advisory per prompt. Trigger A wins ties; B stays armed.
// ─────────────────────────────────────────────────────────────────────────────

// shapeAdvisorStatePath — per-session dedup + CU-baseline file for L7.
function shapeAdvisorStatePath(sid) {
  return path.join(TKR_STATE_DIR, `shape-advisor-${sid || "default"}.json`);
}

function readShapeAdvisorState(sid) {
  try {
    const parsed = JSON.parse(fs.readFileSync(shapeAdvisorStatePath(sid), "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        fired_a: parsed.fired_a === true,
        fired_b: parsed.fired_b === true,
        prev_cu: typeof parsed.prev_cu === "number" ? parsed.prev_cu : 0,
        prev_turns: typeof parsed.prev_turns === "number" ? parsed.prev_turns : 0,
      };
    }
  } catch {
    // missing or corrupt → fresh state
  }
  return { fired_a: false, fired_b: false, prev_cu: 0, prev_turns: 0 };
}

function writeShapeAdvisorState(sid, state) {
  // M-10: atomic tmp+rename.
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    const target = shapeAdvisorStatePath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// Copy is FROZEN — the imperative /tkr:handoff + /clear phrasing is
// intentional (L1/L2 style). Do not paraphrase.
function shapeAdvisorCopyA(kb, ctx) {
  return (
    `[shape tool-bytes] ~${kb}KB of tool results accumulated this session ` +
    `(ctx ${ctx}K) — past research output is re-read in every turn's prefix. ` +
    `At the next natural boundary run /tkr:handoff then /clear; resume costs ` +
    `~1-2K tok vs ${ctx}K carried per turn.`
  );
}

function shapeAdvisorCopyB(t, ctx, x) {
  return (
    `[shape tail-burn] turn ${t}, ctx ${ctx}K, last turn ~${x}x session-avg ` +
    `cap burn — late-session turns are the expensive ones. Finish the current ` +
    `step, then /tkr:handoff + /clear to rebase onto a cheap fresh prefix.`
  );
}

// evalShapeTriggerB — returns { ratio, perTurn, avg } when the tail-burn
// trigger fires, else null. Reads the per-prompt CU baseline (prev_cu /
// prev_turns) from state to measure the burn SINCE the last prompt.
function evalShapeTriggerB(cfg, state, m) {
  const { turnCount, lastCtxK, capTotal, fiveHourResetsAt } = m;

  // Suppress when the 5-hour window resets within 15 min — pressure is about
  // to relieve on its own, so a mid-flow handoff nudge isn't worth it.
  const nowSecs = Math.floor(Date.now() / 1000);
  if (fiveHourResetsAt > nowSecs && fiveHourResetsAt - nowSecs <= 15 * 60) return null;

  if (capTotal <= 0) {
    // Degraded (no cap-unit telemetry): fire on BOTH position proxies alone.
    // Burn is unmeasurable, so report the configured threshold multiple as the
    // floor the position implies (per_turn/avg left 0 in the ledger).
    if (turnCount >= cfg.tail_turns && lastCtxK >= cfg.tail_ctx_k) {
      return { ratio: cfg.tail_cap_mult, perTurn: 0, avg: 0 };
    }
    return null;
  }

  // Need enough turns for a stable session average.
  if (turnCount < cfg.min_turns_for_avg || turnCount <= 0) return null;

  // Position proxy: deep by turn count OR by context size.
  if (!(turnCount >= cfg.tail_turns || lastCtxK >= cfg.tail_ctx_k)) return null;

  const sessionAvg = capTotal / turnCount;
  const deltaCU = capTotal - (typeof state.prev_cu === "number" ? state.prev_cu : 0);
  const deltaTurns = turnCount - (typeof state.prev_turns === "number" ? state.prev_turns : 0);
  if (deltaTurns <= 0 || sessionAvg <= 0) return null;

  const perTurn = deltaCU / deltaTurns;
  const ratio = perTurn / sessionAvg;
  if (ratio >= cfg.tail_cap_mult) {
    return { ratio, perTurn, avg: sessionAvg };
  }
  return null;
}

// shapeAdvisorContext — L7 detector. See section banner above for the two
// triggers and full gating. Returns at most one advisory string per prompt.
// Suppressible via TKR_SHAPE_ADVISOR_DISABLED (detector only — /tkr:handoff
// stays user-invocable) and config advisor.shape.enabled=false.
function shapeAdvisorContext(sid, telemetryPath, telOverride, input) {
  // Subagent dispatch never gets a shape nudge (same guard as routeInjectContext).
  if (input && input.subagent_type && String(input.subagent_type).length > 0) return "";
  if (input && input.scope === "subagent") return "";

  // Kill switches, in order.
  if (process.env.TKR_HOOKS_DISABLED === "1") return "";
  if (process.env.TKR_PLAYBOOK_DISABLED === "1") return "";
  if (process.env.TKR_SHAPE_ADVISOR_DISABLED === "1") return "";
  const cfg = loadShapeAdvisorConfig();
  if (!cfg.enabled) return "";

  const tel = getTel(telemetryPath, telOverride);
  if (!tel) return "";

  // L2 already owns the handoff nudge this session — don't double up.
  if (l2FiredThisSession(sid)) return "";

  // Low-stakes sessions (healthy weekly cap AND cheap rebuild) don't warrant
  // a handoff nudge — the shape doesn't cost enough to act on.
  const sevenDay = typeof tel.seven_day_pct === "number" ? tel.seven_day_pct : 0;
  const missCents =
    typeof tel.projected_miss_cents === "number" ? tel.projected_miss_cents : 0;
  if (sevenDay < cfg.healthy_7d_pct && missCents < cfg.cheap_miss_cents) return "";

  const turnCount = typeof tel.turn_count === "number" ? tel.turn_count : 0;
  const lastCtxK = typeof tel.last_ctx_k === "number" ? tel.last_ctx_k : 0;
  const capTotal = typeof tel.cap_units_total === "number" ? tel.cap_units_total : 0;
  const toolBytes = typeof tel.tool_result_bytes === "number" ? tel.tool_result_bytes : 0;

  const state = readShapeAdvisorState(sid);

  let msg = "";
  let fired = null; // { trigger, per_turn_cu, session_avg_cu } for the ledger

  // Trigger A wins when both would fire the same prompt; B stays armed.
  if (
    !state.fired_a &&
    toolBytes >= cfg.tool_result_kb * 1024 &&
    lastCtxK >= cfg.min_ctx_k
  ) {
    msg = shapeAdvisorCopyA(Math.round(toolBytes / 1024), lastCtxK);
    state.fired_a = true;
    fired = { trigger: "tool_bytes", per_turn_cu: 0, session_avg_cu: 0 };
  } else if (!state.fired_b) {
    const b = evalShapeTriggerB(cfg, state, {
      turnCount,
      lastCtxK,
      capTotal,
      fiveHourResetsAt:
        typeof tel.five_hour_resets_at === "number" ? tel.five_hour_resets_at : 0,
    });
    if (b) {
      msg = shapeAdvisorCopyB(turnCount, lastCtxK, b.ratio.toFixed(1));
      state.fired_b = true;
      fired = { trigger: "tail_burn", per_turn_cu: b.perTurn, session_avg_cu: b.avg };
    }
  }

  // Persist the per-turn CU baseline every prompt so the next call can measure
  // the delta since this one — whether or not we fired.
  state.prev_cu = capTotal;
  state.prev_turns = turnCount;
  writeShapeAdvisorState(sid, state);

  if (!msg) return "";

  try {
    const emit = require("./lib/playbook-emit");
    emit.emitEvent(
      "L7",
      "fired",
      {
        trigger: fired.trigger,
        tool_result_bytes: toolBytes,
        turn_count: turnCount,
        last_ctx_k: lastCtxK,
        cap_units_total: capTotal,
        per_turn_cu: fired.per_turn_cu,
        session_avg_cu: fired.session_avg_cu,
        seven_day_pct: sevenDay,
        projected_miss_cents: missCents,
      },
      null,
      sid,
    );
  } catch {}

  return msg;
}

// ────────────────────────────────────────────────────────────────────
// PR #4 — Channel 1 (the prefix-aware injection path)
//
// This path shipped behind a V2 env gate, flipped default-ON 2026-05-13.
// The V2=0 legacy-parity branch (per-turn brevity label + pressureContext)
// and its TKR_INJECTION_LEGACY rollback handle were deleted 2026-07-23
// (INV-073) — see docs/audits/2026-07-23-injection-discipline/REPORT.md.
// See docs/proposals/2026-05-12-prefix-aware-context-injection.md §3.2.
const { loadShapeAdvisorConfig } = require("./lib/injection-config");

// State-line hysteresis file. Once a field surfaces (locked=true), it
// stays surfaced for the session even if it dips. Age is transient —
// no hysteresis (TTL window only).
function stateLineFilePath(sid) {
  return path.join(TKR_STATE_DIR, `state-line-${sid || "default"}.json`);
}

function readStateLineState(sid) {
  try {
    const raw = fs.readFileSync(stateLineFilePath(sid), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // missing or corrupt → fresh state
  }
  return {
    ctx_locked: false,
    turn_locked: false,
    age_locked: false,
    fivehour_locked: false,
    sevenday_locked: false,
    last_age_s: 0,
  };
}

function writeStateLineState(sid, state) {
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    const target = stateLineFilePath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// PACE-001 — mirrors internal/signals/pace.go runwayRatio for the injected
// state line. A percentage without a reset time is not a pressure reading:
// 85% with eleven hours left is 15% of budget covering 6.7% of a window.
// The model was reading the bare percentage as an emergency and cutting
// sessions short at the tail of a window the user had already paid for.
//
// Returns "" when resets_at is absent, already past, or further out than one
// window — the same three refusals the Go side makes. Never substitutes a
// default; an unknown runway must read as unknown.
const SEVEN_DAY_WINDOW_SECS = 7 * 24 * 3600;

function runwaySuffix(pct, resetsAt, nowSecs, windowSecs = SEVEN_DAY_WINDOW_SECS) {
  if (typeof resetsAt !== "number" || resetsAt <= 0) return "";
  const leftSecs = resetsAt - nowSecs;
  if (leftSecs <= 0 || leftSecs > windowSecs) return "";

  const remainingBudget = Math.max(0, 100 - pct);
  const remainingWindow = (100 * leftSecs) / windowSecs;
  if (remainingWindow <= 0) return "";
  const runway = remainingBudget / remainingWindow;

  const hours = leftSecs / 3600;
  const rst = hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  return ` (rst${rst} rw${runway.toFixed(1)}x)`;
}

// stateLineContext — composable state line per proposal §3.2.
// Variants: quiet | warming | seasoned | pre-TTL | hot | critical.
// Hysteresis on ctx/turn/5h/7d; age field uses [age_s, age_s+100] window.
// Wording FROZEN per §5 Q4 — do not paraphrase.
function stateLineContext(sid, telemetryPath, thresholds, telOverride) {
  const tel = getTel(telemetryPath, telOverride);
  if (!tel) return "";
  const t = thresholds || require("./lib/injection-config").loadInjectionThresholds();
  const ctxK = typeof tel.last_ctx_k === "number" ? tel.last_ctx_k : 0;
  const turn = typeof tel.turn_count === "number" ? tel.turn_count : 0;
  const idleSecs = typeof tel.idle_secs === "number" ? tel.idle_secs : 0;
  const fiveHour = typeof tel.five_hour_pct === "number" ? tel.five_hour_pct : -1;
  const sevenDay = typeof tel.seven_day_pct === "number" ? tel.seven_day_pct : -1;

  const state = readStateLineState(sid);

  // Threshold crossings → lock fields.
  if (ctxK >= t.ctx_k) state.ctx_locked = true;
  if (turn >= t.turn) state.turn_locked = true;
  if (fiveHour >= t.fivehour_pct) state.fivehour_locked = true;
  if (sevenDay >= t.sevenday_pct) state.sevenday_locked = true;
  state.last_age_s = idleSecs;

  // Age special case — transient TTL window [age_s, age_s+100].
  const ageInWindow = idleSecs >= t.age_s && idleSecs <= t.age_s + 100;

  // Persist locks regardless of output (sticky for the session).
  writeStateLineState(sid, state);

  // Compose fields. Order per proposal §3.2 examples:
  //   t=N  → ctx=NK  → 7d=N%  → 5h=N%  →  age~Ns
  const fields = [];
  if (state.turn_locked) fields.push(`t=${turn}`);
  if (state.ctx_locked) fields.push(`ctx=${ctxK}K`);
  // PACE-001 amends the frozen §5 Q4 wording by ADDING to the 7d field,
  // never paraphrasing it: `7d=N%` is untouched and the runway rides in a
  // parenthetical after it. The suffix is deliberately absent from the
  // bucket keys below — a reset countdown moves every second, and folding
  // it into the delta trigger would re-emit the line every turn.
  if (state.sevenday_locked && sevenDay >= 0) {
    const nowSecs = Math.floor(Date.now() / 1000);
    fields.push(`7d=${sevenDay}%${runwaySuffix(sevenDay, tel.seven_day_resets_at, nowSecs)}`);
  }
  if (state.fivehour_locked && fiveHour >= 0) fields.push(`5h=${fiveHour}%`);
  if (ageInWindow) fields.push(`age~${idleSecs}s`);

  if (fields.length === 0) return "";
  const line = `[tkr: ${fields.join(" ")}]`;

  // Delta-only emission (default): the line re-enters context only
  // when a locked field crosses a material bucket — 25-turn bands,
  // 50K-ctx bands, 10-point cap bands — or during the transient age
  // window. Between crossings the model already carries the last
  // state it saw; re-injecting drifting numbers every turn compounds
  // into O(N²) cache re-reads over a session.
  // TKR_STATE_LINE_MODE=every-turn restores the legacy cadence (A/B
  // baseline). Wording stays FROZEN (§5 Q4) in both modes.
  if (String(process.env.TKR_STATE_LINE_MODE || "").trim().toLowerCase() === "every-turn") {
    return line;
  }

  const buckets = {
    t: state.turn_locked ? Math.floor(turn / 25) : -1,
    ctx: state.ctx_locked ? Math.floor(ctxK / 50) : -1,
    d7: state.sevenday_locked && sevenDay >= 0 ? Math.floor(sevenDay / 10) : -1,
    h5: state.fivehour_locked && fiveHour >= 0 ? Math.floor(fiveHour / 10) : -1,
  };
  const last = state.last_emitted || {};
  const changed =
    ageInWindow ||
    Object.keys(buckets).some(
      (k) => buckets[k] !== -1 && buckets[k] !== (k in last ? last[k] : -999),
    );
  if (!changed) return "";

  state.last_emitted = buckets;
  writeStateLineState(sid, state);
  return line;
}

// Tier-cross dedup file. One-time advisories on 7d crossings at 50/70/85.
function tierCrossFilePath(sid) {
  return path.join(TKR_STATE_DIR, `tier-cross-${sid || "default"}.json`);
}

function readTierCrossState(sid) {
  try {
    const raw = fs.readFileSync(tierCrossFilePath(sid), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // missing or corrupt → fresh state
  }
  return { fired_50: false, fired_70: false, fired_85: false };
}

function writeTierCrossState(sid, state) {
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    const target = tierCrossFilePath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// L2 already fired this session? Suppresses 70/85 tier-cross (50 unaffected).
function l2FiredThisSession(sid) {
  const s = readL2State(sid);
  return !!(s && s.fired === true);
}

// tierCrossContext — emit one-time STATE advisory on 7d crossings
// (stage 2, 2026-06-01 — supersedes the §5 Q4 imperative freeze).
// Reports the band only; the verb lives in the system prompt.
//   50%: always fires once
//   70%: fires once unless L2 already fired
//   85%: fires once unless L2 already fired
function tierCrossContext(sid, telemetryPath, telOverride) {
  const tel = getTel(telemetryPath, telOverride);
  if (!tel) return "";
  const sevenDay = typeof tel.seven_day_pct === "number" ? tel.seven_day_pct : -1;
  if (sevenDay < 50) return "";

  const state = readTierCrossState(sid);
  const l2Fired = l2FiredThisSession(sid);

  // Highest applicable tier consumes lower tiers too (skipping past
  // them rather than re-emitting on later turns).
  let msg = "";
  if (sevenDay >= 85 && !state.fired_85) {
    if (!l2Fired) {
      msg = "[tkr: 7d=85%]";
    }
    state.fired_85 = true;
    state.fired_70 = true;
    state.fired_50 = true;
  } else if (sevenDay >= 70 && !state.fired_70) {
    if (!l2Fired) {
      msg = "[tkr: 7d=70%]";
    }
    state.fired_70 = true;
    state.fired_50 = true;
  } else if (sevenDay >= 50 && !state.fired_50) {
    msg = "[tkr: 7d=50%]";
    state.fired_50 = true;
  }

  writeTierCrossState(sid, state);
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// routeInjectContext — ADR-0010 §6 / PLAN-3 T8 route-injection branch.
//
// Reads a cache file written by `tkr route classify "<prompt>" --json` and
// appends a bracketed advisory when a meaningful effort level is present.
// Always best-effort: any exception is swallowed so the hook never fails.
//
// Cache file path: os.tmpdir()/tkr-route-<sha1-of-prompt>.json
//
// NOTE: Node os.tmpdir() and Go os.TempDir() resolve independently.
// On Windows, Go uses %TEMP% (often C:\Users\<user>\AppData\Local\Temp)
// while Node resolves the same variable but via the NT API — in practice
// they match, but the Go binary writes the file and this reader uses the
// same os.tmpdir() for parity. If the path ever diverges (rare edge case
// under a custom TEMP override), cache misses harmlessly trigger a spawn.
//
// Skip conditions (subagent dispatch, disabled flag, empty prompt) are
// checked first so the hot path exits fast for the common no-inject cases.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const ROUTE_CACHE_TTL_SECS = 60;

// routeCacheDir — directory holding `tkr-route-<sha1>.json` cache files.
// Honors TKR_ROUTE_CACHE_DIR for test isolation and user-relocatable
// scratch state. Falls back to `os.tmpdir()` so the hook reader and the
// Go binary writer (`os.TempDir()`) agree by default. The Go writer
// honors the same env var (see internal/route/cache.go); a divergent
// value between writer and reader causes harmless cache misses.
function routeCacheDir() {
  const override = process.env.TKR_ROUTE_CACHE_DIR;
  if (override && String(override).trim()) return String(override);
  return os.tmpdir();
}

// readRouteCache — parse the classifier verdict cached for this exact
// prompt, or null on miss/expired/corrupt. Shared by routeInjectContext
// and shapeNudgeContext so both consume the same entry within one hook
// run. TTL check matches the Go writer's `json:"written_at"` snake_case
// tag (cache.go::CacheEntry) — a tag drift makes every CLI-populated
// entry look expired.
function readRouteCache(promptText) {
  try {
    const sha1 = crypto.createHash("sha1").update(promptText).digest("hex");
    const cacheFile = path.join(routeCacheDir(), "tkr-route-" + sha1 + ".json");
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const writtenAt = parsed && parsed.written_at ? Date.parse(parsed.written_at) : NaN;
    if (!Number.isFinite(writtenAt) || (Date.now() - writtenAt) / 1000 > ROUTE_CACHE_TTL_SECS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// classifyRouteSync — run the classifier inline so THIS prompt's verdict
// is injectable this turn. The cache is keyed by the prompt's SHA-1, so
// the old fire-and-forget spawn only ever produced a hit when identical
// text was resubmitted within the TTL — in practice the route/shape
// lines never fired (2026-07-24 sysprompt review). Measured ~50ms warm
// against the <100ms hot-path budget; ROUTE_SYNC_TIMEOUT_MS bounds the
// cold-start tail. Returns nothing — the Go binary writes the cache
// file before printing, so callers re-read via readRouteCache.
// Env-tunable (HOOK-003): the 250ms default bounds the Go binary's
// cold-start tail, but it is 2.5x the hook's own <100ms budget and the
// sha1-keyed cache makes misses the common case. Dogfood can tighten
// with TKR_ROUTE_SYNC_TIMEOUT_MS once e2e-latency-bench.js has real
// numbers; invalid values fall back to the default.
const ROUTE_SYNC_TIMEOUT_MS = (() => {
  const v = Number(process.env.TKR_ROUTE_SYNC_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 250;
})();

function classifyRouteSync(promptText, input) {
  try {
    // prompt_id is the ONLY anchor that joins the route ledger to
    // task-spawns.jsonl. Without it the two key on different columns
    // (prompt_hash vs prompt_id) and join only through a Claude Code
    // transcript — unreproducible once transcripts rotate. Empty when
    // Claude Code supplied none; the Go side omits the field then.
    const promptID = (input && input.prompt_id) || "";
    const argv = ["route", "classify", promptText, "--json"];
    if (promptID) argv.push("--prompt-id", promptID);
    const res = spawnSync("tkr", argv, {
      timeout: ROUTE_SYNC_TIMEOUT_MS,
      stdio: "ignore",
      windowsHide: true,
    });
    // INV-073: a timeout kill destroys the evidence this spawn exists to
    // write — no decisions.jsonl row, no route state — and the plan
    // funnel then reads the silence as "no routable work". Mark the kill
    // so `tkr route stats` can count it instead. Node semantics: on
    // timeout spawnSync sets res.error with code ETIMEDOUT; a truthy
    // res.signal with a null status is the same kill seen from the
    // process side (Windows included). ENOENT (missing binary) sets
    // error but neither signal nor ETIMEDOUT, so it does not match.
    const timedOut =
      res &&
      ((res.error && res.error.code === "ETIMEDOUT") ||
        (res.signal && res.status === null));
    if (timedOut) {
      const { appendClassifyTimeout } = require("./lib/classify-timeout");
      appendClassifyTimeout({
        session_id: extractSessionID(input || {}) || "",
        timeout_ms: ROUTE_SYNC_TIMEOUT_MS,
        source: "user-prompt-submit",
      });
    }
  } catch {
    // Best-effort — missing binary or timeout degrades to no injection.
  }
}

// ── Route verdict resolution (native-work-routing PR 0 §6.3) ────────────────
//
// The per-session route state is the AUTHORITATIVE verdict channel; the
// prompt-hash cache is a fallback for verdicts written by a
// pre-migration binary. The state validates identity the cache never
// could: session, prompt, active model, schema, freshness. Two sessions
// submitting the same text used to share one verdict, and the second
// session's classify never ran — the cache hit short-circuited before
// the spawn, so its model never reached the shape matrix.
const routeState = require("./lib/route-state");
const workRouteState = require("./lib/work-route-state");
const workDirectives = require("./lib/work-directives");

// activeModelHint returns the session's model as the statusline payload
// knows it, or "" when unobservable. Same sources, same order, as the Go
// side's resolveActiveModel. Used only to reject a verdict written under
// a different model after a mid-session /model switch — unknown means
// "no signal", never "suppress".
//
// model_display (CC's live model, written by hooks/statusline.{sh,ps1}
// from their stdin) beats model_id (cmd_statusline_update's scan of the
// transcript's last ASSISTANT turn) because model_id is one turn behind:
// at UserPromptSubmit for turn N the newest assistant entry is turn
// N-1's, so right after a /model switch it names the model the user just
// left — and this function would then reject a verdict that is in fact
// correct for the current turn. model_id stays as the fallback for hosts
// whose statusline never ran (MODEL-LAG-001).
function activeModelHint(tel) {
  if (tel && typeof tel === "object") {
    if (typeof tel.model_display === "string" && tel.model_display.trim()) {
      return tel.model_display;
    }
    if (typeof tel.model_id === "string") {
      return tel.model_id;
    }
  }
  return process.env.CLAUDE_MODEL || "";
}

// readSessionVerdict returns THIS session's validated verdict for THIS
// prompt, or null. Never consults the shared prompt-hash cache.
function readSessionVerdict(input, promptText, tel) {
  const sid = extractSessionID(input || {}) || "";
  if (!sid) return null;
  return routeState.toVerdict(
    routeState.readRouteState(sid, {
      promptHash: routeState.promptHash(promptText),
      model: activeModelHint(tel),
    }),
  );
}

// readLegacyCacheVerdict returns a prompt-hash cache verdict ONLY when the
// entry predates route-state support. A state-capable writer's entry is
// refused: the cache is keyed on prompt text alone, so honoring it after a
// state miss would hand session B the verdict session A computed under
// session A's model — the cross-session bleed this whole channel exists to
// remove. Never call this before attempting classification.
function readLegacyCacheVerdict(promptText) {
  const entry = readRouteCache(promptText);
  return routeState.legacyCacheIsUsable(entry) ? entry : null;
}

// readRouteVerdict resolves this prompt's verdict without spawning:
// session state first, legacy cache only if a pre-migration binary wrote
// it. Used by shapeNudgeContext, which runs after routeInjectContext has
// already classified — a second spawn for the same prompt would double the
// hot-path subprocess cost for an identical verdict.
function readRouteVerdict(input, promptText, tel) {
  return (
    readSessionVerdict(input, promptText, tel) || readLegacyCacheVerdict(promptText)
  );
}

// ── Route verdict channel policy (ADR-0010, 2026-07-27 addendum) ────────────
//
// The per-turn verdict lives on the STATUSLINE: `tkr route classify`
// mirrors route_class/route_effort into the per-session payload and
// statusline.{sh,ps1} render an RT badge — zero context cost.
// additionalContext is reserved for verdicts the model can act on: a
// SUSTAINED mismatch between recommended and active effort. Official
// effort guidance treats effort as a standing preference, not a
// per-task dial, and acting on a recommendation busts the prefix
// cache — so one-turn disagreements never inject.
//
// TKR_ROUTE_INJECT_MODE:
//   mismatch (default) — inject only after ROUTE_STREAK_MIN consecutive
//       classified prompts carrying the same under-effort verdict, once
//       per session per verdict. Over-effort/model-overkill lines are
//       shapeNudgeContext's job, gated the same way.
//   always — legacy per-turn injection (A/B baseline, plumbing tests).
//   off    — classify + statusline mirror only; never inject.
const ROUTE_STREAK_MIN = 3;

function routeInjectMode() {
  const v = String(process.env.TKR_ROUTE_INJECT_MODE || "").trim().toLowerCase();
  return v === "always" || v === "off" ? v : "mismatch";
}

// Per-session sustained-mismatch state. Two independent tracks (route =
// under-effort, shape = over-effort/model-overkill) so one line's
// streak isn't reset by the other's verdict changing.
function routeNudgeStatePath(sid) {
  return path.join(TKR_STATE_DIR, `route-nudge-${sid || "default"}.json`);
}

function readRouteNudgeState(sid) {
  try {
    const parsed = JSON.parse(fs.readFileSync(routeNudgeStatePath(sid), "utf8"));
    if (parsed && typeof parsed === "object") {
      parsed.route = parsed.route || {};
      parsed.shape = parsed.shape || {};
      return parsed;
    }
  } catch {
    // missing or corrupt → fresh state
  }
  return { route: {}, shape: {} };
}

function writeRouteNudgeState(sid, state) {
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    const target = routeNudgeStatePath(sid);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// trackSustained — advance one track's consecutive-verdict streak.
// Returns true exactly once per session per key: when the same key has
// been seen ROUTE_STREAK_MIN turns in a row and was never injected
// before. A turn with a different key — or null/"" meaning "no
// mismatch this turn" — resets the streak, keeping "consecutive"
// honest.
function trackSustained(track, key) {
  if (!key) {
    track.last_key = "";
    track.streak = 0;
    return false;
  }
  track.streak = track.last_key === key ? (track.streak || 0) + 1 : 1;
  track.last_key = key;
  if (track.streak < ROUTE_STREAK_MIN) return false;
  track.injected = track.injected || {};
  if (track.injected[key]) return false;
  track.injected[key] = true;
  return true;
}

function routeInjectContext(input, tel) {
  try {
    // Skip: subagent dispatch (Agent/Task tool)
    if (input && input.subagent_type && String(input.subagent_type).length > 0) return "";
    // Skip: defensive scope check
    if (input && input.scope === "subagent") return "";
    // Skip: feature kill switch
    if (process.env.TKR_ROUTE_DISABLED === "1") return "";

    const promptText = (input && input.prompt) ? String(input.prompt).trim() : "";
    if (!promptText) return "";

    // The per-session state is a TRANSPORT for this invocation, not a
    // prompt cache — so classify first and read the result, rather than
    // reading a prior turn's verdict and skipping the classifier.
    //
    // Two defects come from treating it as a cache. (1) A verdict also
    // depends on pressure tier, conservative mode, and project paths, none
    // of which are in the state's identity — so an identical prompt
    // resubmitted after crossing a pressure threshold would reuse the
    // pre-threshold policy for the rest of the TTL. (2) Consulting any
    // cached verdict before classifying is what let the shared prompt-hash
    // cache answer for a session that had never classified at all.
    //
    // Cost: one `tkr route classify` per prompt. That was already the
    // common case — distinct prompts always missed — so this only adds a
    // spawn when the SAME prompt repeats inside one session, which is rare.
    let parsed;
    if (process.env.TKR_ROUTE_SYNC === "0") {
      // Legacy async path: no synchronous classify, so the best available
      // verdict is whatever a previous detached run left for this session.
      parsed = readRouteVerdict(input, promptText, tel);
      if (!parsed) {
        spawnRouteClassify(promptText);
        return "";
      }
    } else {
      classifyRouteSync(promptText, input);
      parsed = readSessionVerdict(input, promptText, tel);
      // Only after our own classification failed to produce state does a
      // pre-migration binary's cache entry become the best available
      // answer. A state-capable writer's entry is refused outright.
      if (!parsed) parsed = readLegacyCacheVerdict(promptText);
      if (!parsed) return "";
    }

    // Extract classification fields.
    const taskClass = parsed.task_class || "";
    const effort = parsed.effort || "";
    const why = parsed.why || "";

    // No verdict → nothing on any channel.
    if (!effort || effort === "none") return "";

    // When the matrix names a different MODEL, this verdict's effort
    // figure describes THAT model, not the session's — `recommended_model`
    // is set only when the active model cannot serve the shape at any
    // effort (ADR-0010, 2026-07-29 addendum). Injecting it here told a
    // Haiku session to raise effort to `xhigh`, a parameter its tier does
    // not accept at all, while the escalation that WAS the answer went
    // undelivered (#143 finding 3). The model recommendation is
    // shapeNudgeContext's to carry; this channel stays silent so the
    // session gets one recommendation instead of two that contradict.
    if (parsed.escalate_model || parsed.recommended_model) return "";

    const mode = routeInjectMode();
    if (mode === "off") return "";
    if (mode === "always") {
      return "[tkr route: " + taskClass + " → effort=" + effort + (why ? " (" + why + ")" : "") + "]";
    }

    // mismatch (default): the statusline carries the verdict; inject
    // only a sustained UNDER-effort mismatch (verdict above active).
    // Over-effort is shapeNudgeContext's territory. Unknown active
    // effort → nothing to compare against → statusline only.
    const active = detectActiveEffort(input);
    const sid = extractSessionID(input || {}) || "";
    const state = readRouteNudgeState(sid);

    const aRank = effortRank(active);
    const vRank = effortRank(effort);
    const underEffort = !!active && aRank >= 0 && vRank > aRank;
    const key = underEffort ? `${taskClass}→${effort}` : "";

    let out = "";
    if (trackSustained(state.route, key)) {
      out =
        "[tkr route: " + taskClass + " → effort=" + effort +
        (why ? " (" + why + ")" : "") +
        ` — sustained ${ROUTE_STREAK_MIN}+ turns above active=${active}; raise at a natural break]`;
    }
    writeRouteNudgeState(sid, state);
    return out;
  } catch (e) {
    // Best-effort — never propagate to caller.
    if (process.env.TKR_ROUTE_DEBUG === "1") {
      process.stderr.write("[tkr route-inject] unexpected error: " + String(e) + "\n");
    }
    return "";
  }
}

// shapeNudgeContext — matrix-aware effort nudge (Task #3 / shape×model).
//
// Closes the awareness loop the v1.txt system-prompt matrix block
// already assumes exists: read the same per-prompt cache routeInject
// consumes, and surface a `[tkr: shape=X recommend=Y active=Z]` line
// ONLY when the active effort exceeds the matrix recommendation.
//
// Silent when:
//   - cache miss / expired (routeInjectContext's sync classify failed)
//   - cache has no shape field (legacy entry from older CLI build)
//   - active effort unknown (no effort env var AND no SessionStart-
//     captured effort-<sid>.json state file)
//   - active effort <= recommended (no over-effort to flag)
//   - matrix asked us to escalate model — that's a different nudge,
//     not implemented here (would compete with the over-effort signal)
//
// Empty string is the silence sentinel; composeContext filters it out.
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];

function effortRank(e) {
  if (!e) return -1;
  return EFFORT_ORDER.indexOf(String(e).toLowerCase());
}

// effortStatePath — per-session effort captured at SessionStart
// (hooks/lib/sessionstart/effort-log.js persistSessionEffort). Env vars
// stay the primary source: they track mid-session /effort changes, while
// the file is a launch-time snapshot.
function effortStatePath(sid) {
  return path.join(TKR_STATE_DIR, `effort-${sid || "default"}.json`);
}

function detectActiveEffort(input) {
  const v1 = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  if (v1 && v1.trim()) return v1.trim().toLowerCase();
  const v2 = process.env.CLAUDE_EFFORT;
  if (v2 && v2.trim()) return v2.trim().toLowerCase();
  try {
    const sid = extractSessionID(input || {}) || process.env.TKR_SESSION_ID || "";
    if (!sid) return "";
    const parsed = JSON.parse(fs.readFileSync(effortStatePath(sid), "utf8"));
    if (parsed && typeof parsed.effort === "string" && parsed.effort.trim()) {
      return parsed.effort.trim().toLowerCase();
    }
  } catch {
    // missing or corrupt state file → unknown
  }
  return "";
}

function shapeNudgeContext(input, tel) {
  try {
    if (input && input.subagent_type && String(input.subagent_type).length > 0) return "";
    if (input && input.scope === "subagent") return "";
    if (process.env.TKR_ROUTE_DISABLED === "1") return "";

    const promptText = (input && input.prompt) ? String(input.prompt).trim() : "";
    if (!promptText) return "";

    const active = detectActiveEffort(input);

    // routeInjectContext runs first in composeContext and classifies
    // synchronously on miss, so this read is a hit on the same turn.
    // Never spawns — a second classify on the same prompt would double
    // the hot-path subprocess cost for an identical verdict.
    const parsed = readRouteVerdict(input, promptText, tel);
    if (!parsed) return "";

    const shape = parsed.shape || "";
    const recommend = parsed.recommend_effort || "";

    // Model escalation is resolved FIRST, ahead of both the active-effort
    // guard and the recommend_effort guard, because it is the one verdict
    // that survives neither (#143 finding 3):
    //
    //   - an escalation carries no `recommend_effort` — the matrix is
    //     saying this tier cannot serve the shape at ANY effort, so there
    //     is no figure to name — and the guard below dropped it;
    //   - the active model may accept no effort parameter at all (Haiku),
    //     so `detectActiveEffort` returns nothing and the guard above
    //     dropped it too.
    //
    // Between them, the case the matrix is most confident about was the
    // one case no channel ever delivered. Effort is not compared here on
    // purpose: raising it cannot fix a model that is below the shape's
    // threshold, which is exactly why the recommendation is a model.
    const escalate = parsed.escalate_model || parsed.recommended_model || "";
    if (shape && escalate) {
      const mode = routeInjectMode();
      if (mode === "off") return "";
      const stakes = parsed.high_stakes ? " high-stakes" : "";
      const line = `[tkr: shape=${shape}${stakes} — this model is below the threshold ` +
        `for this shape at any effort; ${escalate} recommended; switch at next natural break]`;
      if (mode === "always") return line;
      const sid = extractSessionID(input || {}) || "";
      const state = readRouteNudgeState(sid);
      const fire = trackSustained(state.shape, `escalate:${shape}|${escalate}`);
      writeRouteNudgeState(sid, state);
      return fire ? line : "";
    }

    if (!active) return ""; // can't compare without active signal
    if (!shape || !recommend) return ""; // legacy entry; nothing matrix-aware to say

    const aRank = effortRank(active);
    const rRank = effortRank(recommend);
    if (aRank < 0 || rRank < 0) return ""; // unknown effort string — bail rather than guess

    const downgrade = parsed.downgrade_model || "";
    const mode = routeInjectMode();
    if (mode === "off") return "";
    const sid = extractSessionID(input || {}) || "";

    if (aRank <= rRank) {
      // Effort is fine. When the matrix says the active model itself is
      // overkill for this shape (Opus on trivial edits — 25.1% of weekly
      // cap), surface the cheaper-model hint. Switch only at natural
      // cache-bust moments — never worth a mid-flow rebuild.
      if (downgrade) {
        const line = `[tkr: shape=${shape} — active model overkill; ${downgrade} equivalent for this shape; switch at next natural break]`;
        if (mode === "always") return line;
        const state = readRouteNudgeState(sid);
        const fire = trackSustained(state.shape, `model:${shape}|${downgrade}`);
        writeRouteNudgeState(sid, state);
        return fire ? line : "";
      }
      // Aligned — reset the shape streak so a stale run doesn't carry
      // across an interleaved well-matched turn.
      if (mode === "mismatch") {
        const state = readRouteNudgeState(sid);
        trackSustained(state.shape, "");
        writeRouteNudgeState(sid, state);
      }
      return ""; // active is at or below recommended — no over-effort
    }

    // Escalation is handled above and returns before reaching here, so
    // this branch is unreachable for an escalating verdict. Kept as a
    // belt-and-braces guard rather than deleted: if a future verdict
    // shape carries escalate_model WITHOUT the recommend_effort the
    // block above keys on, silence still beats telling an underpowered
    // model to lower its effort.
    if (parsed.escalate_model) return "";

    const stakes = parsed.high_stakes ? " high-stakes" : "";
    const downgradeHint = downgrade ? `; ${downgrade} also equivalent at next break` : "";
    const line = `[tkr: shape=${shape}${stakes} recommend=${recommend} active=${active} — consider lowering${downgradeHint}]`;
    if (mode === "always") return line;
    const state = readRouteNudgeState(sid);
    const fire = trackSustained(state.shape, `effort:${shape}|${recommend}|${active}`);
    writeRouteNudgeState(sid, state);
    return fire ? line : "";
  } catch {
    return "";
  }
}

// spawnRouteClassify — fire-and-forget: populate cache for next turn.
// Detached + unref'd so the hook returns immediately. stdio ignored.
function spawnRouteClassify(promptText) {
  try {
    const child = spawnBounded(
      "tkr",
      ["route", "classify", promptText, "--json"],
      { detached: true, stdio: "ignore", windowsHide: true },
      5_000,
    );
    if (child) child.unref();
  } catch {
    // Best-effort — never fail the hook
  }
}

// ── Work-route coordinator directive (native-work-routing PR 3 §10) ─────────
//
// Emits the same-turn `[tkr worker ...]` line when the work policy has
// produced a native plan AND the mode permits acting on one. This is the
// first channel through which a work plan reaches the model at all — PR 2
// made plans visible (statusline, ledger, `tkr route stats`) and
// deliberately not audible.
//
// SAME-TURN, deliberately. The sustained-mismatch rule above (three
// consecutive prompts, once per session) governs changes to the MAIN
// session's effort or model — standing preferences where acting on a
// one-turn signal would thrash and bust the prefix cache. Worker
// delegation is not a preference; it is a decision about the task in
// front of the model right now, and a directive that arrives three
// prompts later describes work already done. Plan §10.3.
//
// NO NEW SUBPROCESS. routeInjectContext has already run `tkr route
// classify` for this prompt and the state it wrote carries the plan, so
// this function only reads. It must therefore stay ordered AFTER
// routeInjectContext in the parts list; running first would find no state
// and silently never fire.

// WORK_MODES_ACTIONABLE mirrors route.WorkMode.Actionable() in
// internal/route/workplan.go. Kept as a literal set rather than derived,
// because the two live in different languages — but a mode added there and
// not here degrades to silence, never to acting on an unknown mode.
const WORK_MODES_ACTIONABLE = new Set(["advisory", "assisted", "managed"]);

// workAgentsDir resolves the plugin's agents/ directory. CLAUDE_PLUGIN_ROOT
// is what the plugin manifest itself uses; __dirname/.. is the fallback for
// a direct checkout. TKR_WORK_AGENTS_DIR overrides both — tests need to
// place a profile somewhere writable, and an unusual packaging layout may
// need it too.
function workAgentsDir() {
  const override = process.env.TKR_WORK_AGENTS_DIR;
  if (override) return override;
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  return path.join(root || path.join(__dirname, ".."), "agents");
}

// workProfileInstalled implements plan §10.3 rule 8, "profile exists".
//
// This is load-bearing rather than defensive. `tkr route classify` builds
// its plan with route.AllProfiles() — every profile marked present — which
// is right for observe mode, where the question is "what WOULD policy
// choose". It is wrong the moment a directive tells the model to invoke
// the named profile: the worker definitions do not ship until PR 4, so
// without this check the very first advisory directive would name an Agent
// that does not exist.
//
// Consequence, stated plainly: with no agents/ directory, this returns
// false for everything and the directive never fires. PR 3 ships inert and
// PR 4 switches it on. That is what rule 8 means today, not a gap.
function workProfileInstalled(profile) {
  const name = String(profile || "").trim();
  if (!name) return false;
  // "tkr:explore-haiku" is the plugin-scoped id; the file is
  // agents/explore-haiku.md. Reject anything that could escape the dir.
  const base = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  if (!base || !/^[a-z0-9][a-z0-9-]*$/i.test(base)) return false;
  try {
    return fs.existsSync(path.join(workAgentsDir(), `${base}.md`));
  } catch {
    return false;
  }
}

// workRouteContext returns the coordinator directive, or "" — and leaves
// a receipt either way.
//
// The receipt is what lets the Agent PreToolUse hook prove a plan belongs
// to the turn in front of it. That hook holds an Agent's prompt, not the
// user's, so it cannot check the prompt hash the way this one does;
// session + freshness alone would let turn A's plan reshape turn B's
// spawn whenever turn B's classify fails to write inside the 5-minute
// TTL. Writing it here — including a tombstone when nothing was emitted
// — is the only place that knowledge exists.
// recordSlashMarker notes, once per turn, that the user typed a slash
// command — the signal the skill ledger needs to tell a MANUAL
// invocation from an AUTO trigger. Written here because this is the
// only hook that sees the raw prompt; skill-invoked.js fires later,
// holds a skill name and no prompt, and cannot afford the transcript
// scan that was the alternative. See hooks/lib/slash-marker.js.
//
// No-ops on ordinary prompts: one regex, no I/O.
function recordSlashMarker(input) {
  try {
    const promptText = (input && input.prompt) ? String(input.prompt) : "";
    if (!promptText) return;
    slashMarker.recordSlashCommand(
      promptText,
      extractSessionID(input || {}) || "",
      (input && input.prompt_id) || ""
    );
  } catch {
    // Attribution is telemetry; it never blocks a prompt.
  }
}

function workRouteContext(input, tel) {
  recordSlashMarker(input);
  const directive = computeWorkRouteDirective(input, tel);
  try {
    const sid = extractSessionID(input || {}) || "";
    if (sid) {
      const promptText = (input && input.prompt) ? String(input.prompt).trim() : "";
      // Same extraction the injection log uses, so the receipt can only
      // ever claim a plan the model was actually told about.
      const m = /\[tkr worker id=([^\s:;\]]+)/.exec(directive || "");
      workRouteState.writeDirectiveReceipt(sid, {
        promptHash: promptText ? routeState.promptHash(promptText) : "",
        planID: m ? m[1] : "",
        directiveEmitted: Boolean(m),
      });
      // Durable counterpart to the receipt. The receipt is per-session and
      // overwritten every turn — it answers "is this plan current?" — so
      // it cannot also answer "how many directives has this feature ever
      // emitted?", which is the funnel's denominator. Only on an actual
      // emission: a ledger of directives must not contain tombstones.
      if (m) {
        // Profile is matched separately, and its failure is survivable:
        // the receipt above gates whether assisted routing may act, so it
        // keeps the exact pattern it was reviewed with. A ledger row with
        // an empty profile is a small loss; a receipt that stopped being
        // written because a second capture group missed would silently
        // disable the feature.
        const p = /\[tkr worker id=[^\s:;\]]+:\s*([^;\]]*)/.exec(directive);
        // Parsed back out of the emitted text, same as profile: the row
        // describes what the model was TOLD, and a legacy directive that
        // never named an objective leaves both fields empty.
        const om = /;\s*objective=([a-z_]+);\s*model=([a-z_]+);/.exec(directive);
        workDirectives.emitWorkDirective({
          sessionID: sid,
          promptID: (input && input.prompt_id) || "",
          planID: m[1],
          profile: p ? p[1].trim() : "",
          objective: om ? om[1] : "",
          modelStrategy: om ? om[2] : "",
        });
      }
    }
  } catch {
    // A receipt that cannot be written means assisted routing declines to
    // act — the safe direction.
  }
  return directive;
}

// computeWorkRouteDirective is workRouteContext's decision half: it
// returns the directive text, or "" for every condition in plan §10.3
// that does not hold.
function computeWorkRouteDirective(input, tel) {
  try {
    // A worker must never be told to spawn a worker.
    if (input && input.subagent_type && String(input.subagent_type).length > 0) return "";
    if (input && input.scope === "subagent") return "";

    // Kill switches. TKR_ROUTE_DISABLED is included because a plan is a
    // product of classification: disabling routing must not leave the one
    // channel that acts on it still live.
    if (process.env.TKR_HOOKS_DISABLED === "1") return "";
    if (process.env.TKR_ROUTE_DISABLED === "1") return "";
    if (process.env.TKR_WORK_ROUTE_DISABLED === "1") return "";

    const promptText = (input && input.prompt) ? String(input.prompt).trim() : "";
    if (!promptText) return "";

    const sid = extractSessionID(input || {}) || "";
    if (!sid) return "";

    // Read only — no classify. readRouteState validates schema, session,
    // prompt hash, active model and TTL, which covers §10.3's "plan is for
    // the current prompt and session" and "plan has not expired" in one
    // place rather than re-checking them here.
    const state = routeState.readRouteState(sid, {
      promptHash: routeState.promptHash(promptText),
      model: activeModelHint(tel),
    });
    if (!state) return "";
    if (state.classification && state.classification.disabled === true) return "";

    const plan = state.work_plan;
    if (!plan || typeof plan !== "object") return "";

    // Mode comes from the PLAN, not the environment. The Go binary reads
    // config.toml and the JS hooks read config.json; resolving the mode
    // twice would let the two disagree about which mode a plan was
    // computed under. workplan.go carries it for exactly this reason.
    if (!WORK_MODES_ACTIONABLE.has(String(plan.mode || ""))) return "";
    if (plan.disposition !== "native_subagent") return "";

    // Belt-and-braces safety floors. The policy already refuses both, so
    // these can only ever be redundant — but they are the difference
    // between "the policy is correct" and "the policy is correct AND a
    // regression in it cannot reach the model through this channel". They
    // are floors, not a reimplementation of the configurable threshold:
    // they can only suppress, never permit.
    if (plan.high_stakes === true) return "";
    if (String(plan.confidence || "") === "low") return "";

    // Anthropic-compatible backend (§10.3). An unrecognized model family
    // means an unknown backend, and a directive naming a Claude Code Agent
    // profile is meaningless there.
    if (!routeState.modelFamily(state.active_model)) return "";

    const profile = String(plan.agent_profile || "");
    if (!workProfileInstalled(profile)) return "";

    const planID = String(plan.plan_id || state.plan_id || "");
    if (!planID) return "";

    // §11 allowlist, shared with the Agent hook so the two cannot drift.
    // Unknown or partial objective/strategy state declines the directive
    // outright; absent-both is a legacy (pre-vocabulary) plan and emits
    // the original directive format below.
    const objective = workRouteState.planObjective(plan);
    if (!objective.ok) return "";

    // Shape comes from the SHAPE result, not from the plan. WorkPlan
    // recovers a shape from its agent profile, which makes it a restatement
    // of the profile rather than an independent fact — the same trap the
    // decision ledger hit in PR 2.
    const shape = String((state.shape && state.shape.shape) || "");
    const mainRole = String(plan.main_role || "");
    const verify = String(plan.verification || "");
    if (!shape || !mainRole || !verify) return "";

    // Format per §10.2, extended per §13.1: the objective is load-bearing
    // for same-model routing — without it a coordinator reads a same-model
    // worker as redundant and executes directly. `model=` carries the
    // STRATEGY (same/downshift/upshift), not a model id; the profile owns
    // the id (or inherits by omission). Legacy plans keep the original
    // format byte-for-byte. The reason code is deliberately NOT included:
    // it is already on every ledger row as work_reason (PR 2), so spending
    // context bytes on it every prompt would buy nothing the audit trail
    // does not already have.
    if (objective.legacy) {
      return `[tkr worker id=${planID}: ${profile}; shape=${shape}; main=${mainRole}; verify=${verify}]`;
    }
    return `[tkr worker id=${planID}: ${profile}; objective=${objective.objective}; model=${objective.strategy}; shape=${shape}; main=${mainRole}; verify=${verify}]`;
  } catch {
    // Fail open — a hook that cannot read state says nothing.
    return "";
  }
}

// composeContext assembles non-empty parts into a single newline-joined
// string. Returned to caller so the log writer can measure exact bytes
// emitted without re-deriving them. Empty string when nothing to emit.
function composeContext(parts) {
  return parts.filter(Boolean).join("\n");
}

// Emit assembled context as a single hookSpecificOutput. Caller passes
// the pre-composed text from composeContext so log row matches what
// went out byte-for-byte.
function emitAdditionalContext(text) {
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: text,
      },
    })
  );
}

// sessionStartStatePath — per-session ISO-8601 timestamp file. First
// write seeds session_age_seconds=0; subsequent reads derive elapsed.
// Cleanup deferred to a later PR (state files accumulate; one tiny
// file per session_id; negligible disk impact short term).
function sessionStartStatePath(sid) {
  return path.join(TKR_STATE_DIR, `${INJECTION_SESSION_START_PREFIX}${sid || "default"}.txt`);
}

// sessionAgeSeconds — read seed timestamp, return elapsed seconds.
// First call seeds the file atomically and returns 0. Missing/corrupt
// file → re-seed + 0. Best-effort throughout.
function sessionAgeSeconds(sid) {
  const target = sessionStartStatePath(sid);
  try {
    const raw = fs.readFileSync(target, "utf8").trim();
    const startMs = Date.parse(raw);
    if (Number.isFinite(startMs)) {
      const elapsed = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      return elapsed;
    }
  } catch {
    // missing or unreadable — fall through to seed
  }
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    const nowIso = new Date().toISOString();
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, nowIso);
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
  return 0;
}

// readStatusline — best-effort load of CC's statusline payload. Missing
// or malformed → empty object (writer fills in 0/-1 defaults). Optional
// path override for tests.
function readStatusline(telemetryPath) {
  const target = telemetryPath || getTelemetryPath();
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) || {};
  } catch {
    return {};
  }
}

// getTel — single-read accessor used by every per-prompt context builder.
// If telOverride is a non-null object (passed from runMain after one
// fs.readFileSync) it's returned verbatim; otherwise the file is read.
// Returns null on read/parse failure so callers can short-circuit
// (same semantics as the previous inline `try { tel = ... } catch { return "" }`
// pattern that each helper duplicated).
//
// H-5 fix: collapses 6-8 readFileSync+JSON.parse calls per UserPromptSubmit
// down to one. Tests that pass telemetryPath continue to work — telOverride
// is the new (and optional) third argument.
function getTel(telemetryPath, telOverride) {
  if (telOverride && typeof telOverride === "object") return telOverride;
  const target = telemetryPath || getTelemetryPath();
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

// writeInjectionLogRow — append one row to ~/.tkr/injection-events.jsonl.
// Hot-path-cheap fields only (9 keys); richer fields hydrated post-hoc
// by scripts/session_analysis/injection_roi.py via parser.py join on
// (session_id, turn).
//
// Stable field shape — every row carries all 9 keys even when source
// telemetry is absent. Downstream JSONL parsers rely on consistent
// schema. Sentinels: numeric=-1 means "missing" (fivehour_pct,
// sevenday_pct); 0 means "absent but known" (turn, ctx_k, idle_secs).
//
// Best-effort. Wrapped catch-all; hook NEVER fails user prompts on
// log error. Env escape hatch: TKR_INJECTION_LOG_DISABLED=1 → no-op.
//
// emittedText is the assembled additionalContext string from
// composeContext — used to compute hook_inject_bytes accurately.
function writeInjectionLogRow(input, emittedText, telemetryPath, logPath, telOverride) {
  if (process.env.TKR_INJECTION_LOG_DISABLED === "1") return;
  const target = logPath || INJECTION_LOG;
  try {
    const sid = extractSessionID(input || {});
    // H-5: prefer pre-parsed telemetry from runMain. readStatusline falls
    // back to file read when telOverride is undefined (test path).
    const tel =
      telOverride && typeof telOverride === "object"
        ? telOverride
        : readStatusline(telemetryPath);
    const row = {
      ts: new Date().toISOString(),
      session_id: typeof sid === "string" ? sid : "",
      turn: typeof tel.turn_count === "number" ? tel.turn_count : 0,
      ctx_k: typeof tel.last_ctx_k === "number" ? tel.last_ctx_k : 0,
      idle_secs: typeof tel.idle_secs === "number" ? tel.idle_secs : 0,
      fivehour_pct: typeof tel.five_hour_pct === "number" ? tel.five_hour_pct : -1,
      sevenday_pct: typeof tel.seven_day_pct === "number" ? tel.seven_day_pct : -1,
      age_s: sessionAgeSeconds(sid),
      inject_b: emittedText ? Buffer.byteLength(emittedText, "utf8") : 0,
      md: injectionModes(),
    };
    // wr — the plan id of a coordinator directive that actually went out
    // (native-work-routing PR 3). Absent when none did.
    //
    // This is the injected half of "was the plan followed?". decisions.jsonl
    // already records which plan the POLICY chose (PR 2), but a native plan
    // and an injected directive are different facts: mode, an uninstalled
    // profile, a kill switch, or any §10.3 gate can produce the first
    // without the second. Without this field, a follow-rate computed after
    // PR 4 lands would silently divide by plans the model was never told
    // about.
    //
    // Parsed back out of the emitted text rather than threaded through, on
    // the same principle as inject_b above: the row describes what actually
    // went out, not what a caller intended to send.
    const wr = emittedText ? /\[tkr worker id=([^\s:;\]]+)/.exec(emittedText) : null;
    if (wr) row.wr = wr[1];
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    rotateIfLarge(target, INJECTION_LOG_MAX_BYTES);
    fs.appendFileSync(target, JSON.stringify(row) + "\n");
  } catch {
    // best-effort — never propagate
  }
}

// injectionModes — compact A/B arm attribution for injection-events
// rows: first letter of the route-inject mode (m|a|o) and of the
// state-line mode (b(ucket)|e(very-turn)). Readers group by this to
// compare cadence arms without time-boxing sessions.
function injectionModes() {
  const route = routeInjectMode()[0];
  const state =
    String(process.env.TKR_STATE_LINE_MODE || "").trim().toLowerCase() === "every-turn"
      ? "e"
      : "b";
  return `${route}/${state}`;
}

function brevityLabel(mode) {
  const labels = {
    lite: "no filler, no hedging, professional but tight",
    full: "fragments, no articles, no filler, no hedging",
    ultra: "abbreviate, arrows for causality, one word when one word enough",
  };
  return labels[mode] || labels.full;
}

// Read prompt from stdin (Claude Code sends JSON: { "prompt": "..." })
// Guarded: skip stdin processing when imported as a module (tests).
// CR-06 + M-12: stdin timeout + master kill switch.
function runMain(input) {
  try {
    const data = JSON.parse(input || "{}");
    const prompt = (data.prompt || "").trim().toLowerCase();

    // Set per-session telemetry env early so every getTelemetryPath() call
    // downstream (coldResume, stateLine, pressure, writeInjectionLogRow…)
    // reads/writes this session's claude-statusline-<slug>-<sid>.json
    // instead of the previous session's leftover payload. Tests still
    // override via TKR_STATUSLINE_PATH (higher priority in the resolver).
    // INV-039: payload sid always wins. An inherited TKR_SESSION_ID can be
    // a stale launch-time pin (pre-fix `tkr claude` wrapper env), which made
    // this hook read another session's telemetry. extractSessionID already
    // falls back to env when the payload has no sid, so this is a no-op then.
    const earlySid = extractSessionID(data);
    if (earlySid) {
      process.env.TKR_SESSION_ID = earlySid;
    }

    // Fire-and-forget: record prompt event for session continuity (PLAN-5).
    spawnRecordPromptEvent(input, earlySid);

    // Issue #123: refresh the standing active-effort snapshot every turn,
    // not just at SessionStart (session-start.js also calls this). `tkr
    // top` runs as a separate process with no view into this session's
    // live env vars, so a mid-session /effort change only reaches it via
    // this file being rewritten. Claude Code withholds both `input.effort`
    // and CLAUDE_EFFORT from session-lifecycle hooks, so in practice this
    // detects nothing and post-tool-call.js is what keeps the file
    // current; clearWhenAbsent stays false so this hook's blindness
    // cannot delete what the last tool call observed. Best-effort —
    // already wrapped internally, never throws.
    persistSessionEffort(earlySid, data, process.env, { clearWhenAbsent: false });

    // Keepalive activity touch (issue #129) — folded in from the former
    // hooks/keepalive/activity-touch.sh, whose ~9 process spawns per
    // prompt timed out the whole UserPromptSubmit group under Windows
    // multi-session load. MUST stay above the brevity early-returns:
    // a /brevity turn is genuine user activity too. Best-effort.
    activityTouch({ rawInput: input, data, sid: earlySid });

    // Tombstone the work-route receipt for THIS prompt, before any branch
    // below can return.
    //
    // The receipt's whole job is proving a plan belongs to the turn in
    // front of it, which only works if every turn leaves one. The brevity
    // commands below return early, so writing it only at
    // workRouteContext left `/brevity` (and "stop brevity", and "normal
    // mode") carrying the PREVIOUS turn's receipt for the rest of the
    // 5-minute TTL — and with it, authority for the previous turn's plan
    // to reshape an Agent call made on this one.
    //
    // workRouteContext overwrites this with directive_emitted:true if it
    // actually emits, so the cost on a normal prompt is one extra small
    // write that is immediately superseded.
    if (earlySid) {
      workRouteState.writeDirectiveReceipt(earlySid, {
        promptHash: prompt ? routeState.promptHash(prompt.trim()) : "",
        planID: "",
        directiveEmitted: false,
      });
    }

    // Brevity mode commands — handle and exit early (no other context needed).
    // Canonical: /brevity. Transition alias: /tkr-brevity (matches public docs
    // pre-v3.13; see issue #8). Match on exact token so /brevityfoo doesn't fire.
    const parts = prompt.split(/\s+/);
    const cmd = parts[0];
    if (cmd === "/brevity" || cmd === "/tkr-brevity") {
      const requested = parts[1] || DEFAULT_MODE;
      const mode = VALID_MODES.includes(requested) ? requested : DEFAULT_MODE;
      setBrevityMode(mode);
      let text = "";
      if (mode !== "off") {
        text = composeContext([`[tkr brevity: ${mode} — ${brevityLabel(mode)}]`]);
        emitAdditionalContext(text);
      }
      writeInjectionLogRow(data, text);
      return;
    }

    if (prompt.includes("stop brevity") || prompt === "normal mode") {
      setBrevityMode("off");
      writeInjectionLogRow(data, "");
      return;
    }

    // Collect context parts for normal prompts.
    const contextParts = [];
    const sid = earlySid;

    // H-5: read the statusline JSON ONCE per prompt. Every context helper
    // below previously did its own fs.readFileSync + JSON.parse of the
    // same file (6-8 reads per UserPromptSubmit). readStatusline returns
    // {} on failure (vs getTel returning null) so we pass null to each
    // helper when the read failed — they'll bail out the same way.
    const telRaw = readStatusline();
    const tel =
      telRaw && Object.keys(telRaw).length > 0 ? telRaw : null;

    // Prefix-aware injection path — proposal §3.2. (The legacy per-turn
    // brevity-label + pressureContext branch was deleted per INV-073.)
    // - No per-turn brevity reinforcement (drift signal logged in Phase 1).
    // - No pressureContext (replaced by state line + tier-cross).
    // - Cold-resume / L1 / L2 kept (orthogonal event detectors per §3.2).
    // - Composable state line + rate-tier advisories.
    contextParts.push(coldResumeContext(undefined, tel));
    contextParts.push(l1IdleGapContext(sid, undefined, tel));
    contextParts.push(l2HandoffContext(sid, undefined, tel));
    contextParts.push(shapeAdvisorContext(sid, undefined, tel, data));
    contextParts.push(stateLineContext(sid, undefined, undefined, tel));
    contextParts.push(tierCrossContext(sid, undefined, tel));

    // Route inject — ADR-0010 §6 / PLAN-3 T8. Reads the per-session route
    // state (authoritative) or the legacy prompt-hash cache; classifies
    // synchronously on a miss so this prompt's verdict lands this turn.
    // `tel` carries the session's model_id so a verdict written before a
    // mid-session /model switch is rejected rather than reused.
    contextParts.push(routeInjectContext(data, tel));
    // Shape nudge — matrix-aware over-effort signal. Silent unless
    // active effort exceeds the (shape × model) recommendation.
    contextParts.push(shapeNudgeContext(data, tel));
    // Work-route directive — native-work-routing PR 3 §10. MUST stay after
    // routeInjectContext: it reads the state that classify wrote rather
    // than spawning its own, so running earlier would find nothing.
    contextParts.push(workRouteContext(data, tel));

    const text = composeContext(contextParts);
    emitAdditionalContext(text);
    writeInjectionLogRow(data, text, undefined, undefined, tel);
  } catch {
    // Malformed input — ignore silently
  }
}

if (require.main === module) {
  if (hooksDisabled()) {
    process.exit(0);
  } else {
    readStdinWithTimeout(3000).then(runMain).catch(() => process.exit(0));
  }
}

module.exports = {
  COLD_RESUME_IDLE_SECS,
  COLD_RESUME_MIN_CENTS,
  PRE_TTL_IDLE_SECS,
  L1_IDLE_SECS,
  L1_LAST_CTX_K,
  L2_TURN_COUNT,
  L2_CACHE_READ_PCT,
  ROUTE_CACHE_TTL_SECS,
  getTelemetryPath,
  INJECTION_LOG,
  INJECTION_LOG_MAX_BYTES,
  coldResumeContext,
  composeContext,
  l1IdleGapContext,
  l1StatePath,
  l2HandoffContext,
  l2StatePath,
  shapeAdvisorContext,
  shapeAdvisorStatePath,
  routeInjectContext,
  shapeNudgeContext,
  workRouteContext,
  workProfileInstalled,
  workAgentsDir,
  WORK_MODES_ACTIONABLE,
  effortRank,
  detectActiveEffort,
  effortStatePath,
  readRouteCache,
  readRouteVerdict,
  activeModelHint,
  classifyRouteSync,
  ROUTE_SYNC_TIMEOUT_MS,
  ROUTE_STREAK_MIN,
  routeInjectMode,
  routeNudgeStatePath,
  readRouteNudgeState,
  trackSustained,
  sessionAgeSeconds,
  sessionStartStatePath,
  runwaySuffix,
  stateLineContext,
  stateLineFilePath,
  tierCrossContext,
  tierCrossFilePath,
  writeInjectionLogRow,
};
