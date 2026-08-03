#!/usr/bin/env node
// tkr PreToolUse hook — Agent tool input rewriter.
//
// Three responsibilities:
//   1. (DELEG-INT-001) Force run_in_background=false on every Agent/Task call.
//      Mechanical anti-stall — replaces the prompt-text contract that LLMs
//      could ignore. Mirrors free-claude-code's
//      _normalize_task_run_in_background (sse.py:156-159).
//   2. Inject search-first guidance into Explore subagent prompts so they
//      use tkr search before chaining Glob/Grep/Read.
//   3. (COMPETE-002, opt-in) Auto-route: when the pressure classifier's
//      persisted verdict says delegate via cheap model (delegate_via in
//      the statusline payload, written by `tkr statusline-update`),
//      mechanically downgrade Explore subagent spawns to haiku. Off by
//      default — ~/.tkr/config.json {"autoroute":{"enabled":true}}.
//
// All rewrites use PreToolUse hookSpecificOutput.updatedInput, which the
// existing tkr-rewrite.js hook already proves is mutable.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { getSessionID } = require("./lib/session-id");
const { emitTaskSpawn } = require("./lib/task-spawns");
const { loadAutorouteConfig } = require("./lib/injection-config");
const { getTelemetryPath } = require("./lib/statusline-path");
const { readJSONSync } = require("./lib/safe-json");
const { rotateIfLarge } = require("./lib/rotate-jsonl");
const routeState = require("./lib/route-state");
const {
  claimPlan,
  currentWorkPlan,
  modeAllowsRewrite,
  modeIsFollowable,
} = require("./lib/work-route-state");

// Wave 4 (CR-06 + M-12): stdin timeout + master kill switch.
if (hooksDisabled()) {
  process.exit(0);
}

readStdinWithTimeout(2000).then(handleInput).catch(() => process.exit(0));

function handleInput(input) {
  try {
    const event = JSON.parse(input || "{}");

    // Only intercept subagent dispatch tools.
    // Claude Code uses "Agent"; "Task" reserved for forward-compat / aliases.
    if (event.tool_name !== "Agent" && event.tool_name !== "Task") {
      process.exit(0);
      return;
    }

    const toolInput = event.tool_input || {};
    const subagentType = toolInput.subagent_type || "";
    const prompt = toolInput.prompt || "";
    const sid = getSessionID(event);

    // Work routing is resolved BEFORE the ledger row so the row can carry
    // planned-vs-actual (§14.2). In advisory nothing is rewritten and the
    // row records what the coordinator chose on its own — which is the
    // follow rate the whole feature is evaluated on.
    //
    // §13.2 explicit recursion guard, checked BEFORE any plan state is
    // read: a subagent's tool calls fire this hook with the SAME
    // session_id as the coordinator (sidechains share it), so the
    // parent's plan, receipt, and even an unclaimed plan are all visible
    // here — "subagent sessions have no plan receipt" was never a real
    // guard. A worker spawning another worker is cost doubling, not cost
    // saving, so any subagent marker declines work routing outright and
    // the spawn row carries no plan fields (the plan belongs to the
    // parent's turn, not this spawn).
    const work = isSubagentContext(event) ? null : workRoute(sid, toolInput, subagentType);

    // INV-023 P1 — record every Task spawn to ~/.tkr/task-spawns.jsonl.
    // Fire-and-forget; the spawn observation must not gate the rewrite
    // path because rewrite is correctness-critical and ledger is best-
    // effort observability. Done before the rewrite-eligibility short-
    // circuit so passthrough spawns (run_in_background=false, non-Explore)
    // still produce a ledger row — those are the bulk of real spawns.
    emitTaskSpawn({
      session_id: sid,
      // Lifecycle join anchors, taken verbatim off the payload. prompt_id
      // is the only identifier this event shares with the SubagentStop it
      // eventually produces; tool_use_id identifies this Agent call and
      // nothing else, which is what makes a spawn row addressable.
      prompt_id: event.prompt_id || "",
      tool_use_id: event.tool_use_id || "",
      tool_name: event.tool_name,
      subagent_type: subagentType,
      description: toolInput.description || "",
      model: toolInput.model || "",
      background: toolInput.run_in_background === true,
      ...(work ? {
        plan_id: work.planID,
        plan_mode: work.mode,
        followable: work.followable,
        planned_profile: work.plannedProfile,
        planned_model: work.plannedModel,
        // What the coordinator asked for, before this hook touched it.
        requested_profile: subagentType,
        requested_model: toolInput.model || "",
        // What this hook emitted. NOT what ran: CLAUDE_CODE_SUBAGENT_MODEL
        // sits ABOVE the per-invocation model in Claude Code's resolution
        // order, so it overrides exactly the field written here — and a
        // later hook can change it too. `tkr doctor` detects that variable
        // and names the profiles it contradicts, but the check runs out of
        // band; this row cannot know. Naming these "actual" would claim
        // knowledge the hook does not have.
        emitted_profile: work.apply ? work.plannedProfile : subagentType,
        emitted_model: work.apply ? work.plannedModel : (toolInput.model || ""),
        rewrite_mode: work.apply ? work.mode : "none",
        claim_denied: work.claimDenied === true,
        // §15 vocabulary. Empty on legacy (pre-vocabulary) plans.
        route_objective: work.objective || "",
        model_strategy: work.modelStrategy || "",
      } : {}),
    });

    // Always force foreground execution — idempotent, harmless if already false.
    const forceForeground = toolInput.run_in_background !== false;
    const shouldInjectPrompt = shouldInject(subagentType);
    const applyWork = Boolean(work && work.apply);
    // Capacity autoroute is skipped when task routing already owns this
    // spawn's model. The two axes stay separate by design (DELEG is
    // pressure, WRK is task shape) but exactly one of them may write the
    // model field, or the second silently overwrites the first.
    const autoModel = applyWork ? "" : autorouteModel(event, toolInput, subagentType);

    if (!forceForeground && !shouldInjectPrompt && !autoModel && !applyWork) {
      process.exit(0);
      return;
    }

    const updatedInput = { ...toolInput };
    if (forceForeground) {
      updatedInput.run_in_background = false;
    }
    if (shouldInjectPrompt) {
      const guidance = SEARCH_GUIDANCE.trimEnd() + "\n\n";
      updatedInput.prompt = guidance + prompt;
    }
    if (applyWork) {
      updatedInput.subagent_type = work.plannedProfile;
      updatedInput.model = work.plannedModel;
      updatedInput.run_in_background = false;
      updatedInput.prompt =
        WORKER_CONTRACT_SCAFFOLD.trimEnd() + "\n\n" + (updatedInput.prompt || prompt);
      // No consumption bookkeeping here: workRoute already claimed the
      // plan exclusively, and only the winning process reaches this.
    }
    if (autoModel) {
      updatedInput.model = autoModel;
      // Smaller models execute well on explicit instructions and degrade
      // on ambiguity (larger models absorb it). A downgraded spawn gets
      // an execution contract, not just a cheaper engine — otherwise the
      // savings leak back out as wandering tool calls and rework.
      updatedInput.prompt =
        DOWNGRADE_SCAFFOLD.trimEnd() + "\n\n" + (updatedInput.prompt || prompt);
    }

    const result = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: updatedInput,
      },
    };

    process.stdout.write(JSON.stringify(result));
  } catch {
    // Parse error — passthrough
    process.exit(0);
  }
}

const SEARCH_GUIDANCE = `## tkr search — use before exploring

This project has a semantic search tool. Before chaining Glob/Grep/Read calls to explore the codebase, run:

\`\`\`bash
tkr search "your query" --human
\`\`\`

One search call replaces 5-10 file reads. Use \`--context-pack\` for grouped multi-source results.
Reserve raw Glob/Grep/Read for known paths or follow-up after search results.`;

// Injected above the task when autoroute downgrades a spawn to a
// smaller model. ~110 tokens in the child's isolated context, spent on
// the failure mode downgrades actually have: ambiguity tolerance.
const DOWNGRADE_SCAFFOLD = `## Execution contract (cost-routed spawn)

You are a smaller, faster model on a bounded read-only task. Ambiguity
is not yours to absorb — follow this contract:

1. Restate the task in one sentence before starting; if it doesn't fit
   in one sentence, report that instead of exploring.
2. Work the narrowest path: search first, read only matched ranges,
   never bulk-read directories.
3. Return findings as: files (path:line) with one-line evidence each,
   plus an explicit "not found / not checked" list. No prose beyond
   that.
4. Stop at ~10 tool calls or the first complete answer, whichever
   comes first — a partial-but-labeled result beats a long crawl.`;

// Injected above the task when a work plan shapes this spawn (§13.5).
// Deliberately short and profile-agnostic: the agent's own markdown
// already carries its role, so duplicating it here would pay for the
// same instructions twice, once in the profile and once per spawn.
const WORKER_CONTRACT_SCAFFOLD = `## TKR bounded worker contract

Follow the coordinator's objective and scope exactly.
Do not broaden the task. Return changed files or evidence, validation commands
and results, assumptions, unresolved risks, and incomplete work. If scope or
verification is insufficient, stop and report the limitation.`;

// Subagent types a work plan may reshape (§13.4). Two families: the
// general-purpose agents, which have no commitments a plan would
// contradict, and tkr's own workers, which the plan names directly.
//
// Everything else is refused, and Plan is the clearest case — a
// coordinator asking for planning is not asking for the bounded
// execution a worker profile promises. A specialist (code-reviewer,
// statusline-setup, some other plugin's agent) was chosen for
// capabilities the plan knows nothing about; silently swapping it for
// tkr:explore-haiku would answer a question nobody asked.
const WORK_ROUTABLE_TYPES = new Set(["", "general-purpose", "Explore"]);

function workTypeIsRoutable(subagentType, plannedProfile) {
  const t = String(subagentType || "");
  if (WORK_ROUTABLE_TYPES.has(t)) return true;
  // Already the planned worker: not a conflict, and the plan can still
  // contribute the model and the contract scaffold.
  return t === plannedProfile;
}

// workRoute resolves this spawn against the session's current work plan.
//
// Returns null when there is no plan, or a descriptor carrying both the
// plan and whether it may be APPLIED. The split matters: advisory mode
// returns a descriptor with apply=false, because the plan is still worth
// recording against the coordinator's choice even though nothing is
// rewritten. That recording is how follow rate becomes measurable
// before anything is allowed to act.
function workRoute(sid, toolInput, subagentType) {
  try {
    const current = currentWorkPlan(sid);
    if (!current) return null;

    const plan = current.plan;
    const plannedProfile = String(plan.agent_profile || "");
    const plannedModel = String(plan.worker_model || "");
    const mode = current.mode;
    if (!plannedProfile) return null;

    const descriptor = {
      planID: current.planID,
      plannedProfile,
      plannedModel,
      mode,
      // §6.1/§6.2 vocabulary, already allowlist-checked by
      // currentWorkPlan (unknown vocabulary returns no plan at all).
      // Empty strings on legacy plans.
      objective: current.objective || "",
      modelStrategy: current.modelStrategy || "",
      // Whether "did the coordinator follow?" is even a question. In
      // observe nothing reached the model, so a match is coincidence —
      // and `announced` covers the rest: if the directive never went out
      // (an uninstalled profile, an unrecognized backend), there was
      // nothing to follow in any mode.
      followable: modeIsFollowable(mode) && current.announced === true,
      apply: false,
      claimDenied: false,
    };

    // §13.4 compatibility. Session, freshness, disposition, high-stakes
    // and confidence are already enforced by currentWorkPlan.
    if (!modeAllowsRewrite(mode)) return descriptor;
    if (!plannedModel) return descriptor;
    if (!String(toolInput.prompt || "").trim()) return descriptor;
    if (!workTypeIsRoutable(subagentType, plannedProfile)) return descriptor;
    // An explicit model is the coordinator (or the user) having decided.
    // Routing over it would be the one thing this feature must never do,
    // so an explicit choice ends the matter — including when it happens
    // to agree with the plan, because "agrees today" is not consent.
    if (toolInput.model) return descriptor;

    // §13.2: a planned model in the ACTIVE model's family may be filled
    // only under ObjectiveIsolate — that objective is defined as paying
    // the same rate for a fresh context. Under any other objective a
    // same-model fill is the cost-doubling the Go gate exists to refuse,
    // so a plan claiming one here is an upstream regression: record it,
    // never apply it. (Isolate plans themselves stay born-rejected until
    // PR 7, so this branch admits nothing today; it is the seam PR 5
    // fills through.)
    const activeFamily = routeState.modelFamily(current.state && current.state.active_model);
    const plannedFamily = routeState.modelFamily(plannedModel);
    if (descriptor.objective !== "isolate" && activeFamily && plannedFamily === activeFamily) {
      return descriptor;
    }

    // A directive naming THIS plan actually went out this turn.
    // currentWorkPlan has already proven the plan belongs to this turn at
    // all; this is the stronger fact that the coordinator was told about
    // it, which is what makes filling in its spawn a completion of an
    // instruction rather than a surprise.
    if (current.announced !== true) return descriptor;

    // Claim last, and only once everything else has passed, so a plan is
    // not burned by a spawn that was going to be refused anyway.
    // Exclusive create, not check-then-write: parallel PreToolUse(Agent)
    // processes are routine when the coordinator dispatches several
    // workers at once, and both would pass a read-only check.
    //
    // A denied claim is recorded, because "one plan reshaped at most one
    // spawn" is an invariant nobody can check from a ledger that only
    // shows the winner. Denied covers both causes claimPlan collapses
    // together — the plan was already used, or the claim could not be
    // written at all — and the field name says neither more than that.
    if (!claimPlan(sid, current.planID)) {
      descriptor.claimDenied = true;
      return descriptor;
    }

    descriptor.apply = true;
    return descriptor;
  } catch {
    return null;
  }
}

// isSubagentContext reports whether THIS hook invocation happened inside
// a subagent (sidechain) rather than the main session. agent_id and
// agent_type are the documented markers — hooks.md lists both as present
// only when the hook fires inside a subagent, and documents that the
// sidechain shares the parent's session_id. scope==="subagent" and a
// top-level subagent_type are the undocumented mirrors
// user-prompt-submit.js already checks; tool_input.subagent_type (the
// SPAWN TARGET) is deliberately not consulted. Inert when every marker
// is absent — the receipt and claim protections remain underneath.
function isSubagentContext(event) {
  if (!event || typeof event !== "object") return false;
  if (event.agent_id || event.agent_type) return true;
  if (event.scope === "subagent") return true;
  return typeof event.subagent_type === "string" && event.subagent_type.length > 0;
}

function shouldInject(subagentType) {
  // Only inject for Explore agents — they exist for orientation/discovery
  // where tkr search genuinely outperforms native Glob/Grep/Read.
  // Implementation agents (senior-implementer, junior-implementer, etc.)
  // do targeted edits where native tools are faster and more precise.
  return subagentType === "Explore";
}

// Max age of the persisted verdict before autoroute ignores it. Mirrors
// the freshness discipline of latestRouteEffort (cmd_statusline_update.go,
// 5-min cutoff) — without it, a crashed-then-resumed session could route
// on yesterday's verdict until the first statusline tick overwrites it.
const AUTOROUTE_MAX_VERDICT_AGE_MS = 10 * 60 * 1000;

// autorouteModel — COMPETE-002 mechanical routing. Returns the model to
// force onto this spawn ("" = leave untouched). Fires only when ALL hold:
//   - opt-in flag set (~/.tkr/config.json autoroute.enabled; default off)
//   - env kill switch TKR_AUTOROUTE_DISABLED not set
//   - Explore spawn (read-only orientation work — the class the
//     classifier's subagent_haiku route is scoped to)
//   - the model explicitly chose no model (an explicit choice always wins)
//   - the session's persisted classifier verdict (written each tick by
//     `tkr statusline-update`) says recommend=delegate AND routes via
//     subagent_haiku or payg_delegate. The recommend gate matters:
//     classifyDelegateVia returns subagent_haiku for ANY non-stay verdict
//     including offer-tier reasons (cache_modest, huge_ctx, ...) — firing
//     on those would downgrade exploration on a healthy account far
//     beyond "classifier says delegate". payg_delegate (critical) also
//     downgrades: the PAYG dispatch itself stays advisory (needs the MCP
//     server registered — COMPETE-002b), but a haiku subagent is strictly
//     cheaper than the session model in the meantime.
//   - the payload file is fresh (see AUTOROUTE_MAX_VERDICT_AGE_MS)
// Every fire is recorded in ~/.tkr/decisions.jsonl so adoption and effect
// are measurable — the whole point of the COMPETE-002 experiment.
// Known limitation (pre-existing, shared by all JS payload readers): the
// JS statusline path slugs raw cwd without the Go writer's INV-040
// worktree/project-root resolution, so autoroute is inert in
// agent-isolation worktrees — tracked under COMPETE-002b in TODO.md.
function autorouteModel(event, toolInput, subagentType) {
  if (process.env.TKR_AUTOROUTE_DISABLED === "1") return "";
  if (subagentType !== "Explore") return "";
  if (toolInput.model) return "";
  try {
    if (!loadAutorouteConfig().enabled) return "";
    // Per hooks/CLAUDE.md contract: set TKR_SESSION_ID before resolving
    // the statusline path so we read THIS session's payload.
    const sid = getSessionID(event);
    if (sid) process.env.TKR_SESSION_ID = sid;
    const telPath = getTelemetryPath();
    const age = Date.now() - fs.statSync(telPath).mtimeMs;
    if (age > AUTOROUTE_MAX_VERDICT_AGE_MS) return "";
    const tel = readJSONSync(telPath);
    if (!tel) return "";
    if (String(tel.recommend || "") !== "delegate") return "";
    const via = String(tel.delegate_via || "");
    if (via !== "subagent_haiku" && via !== "payg_delegate") return "";
    emitAutorouteDecision(sid, via, String(tel.rate_class || ""));
    return "haiku";
  } catch {
    return "";
  }
}

// emitAutorouteDecision — best-effort ledger row in ~/.tkr/decisions.jsonl
// (the delegation audit ledger). Field names follow the Go owner's
// DecisionRecord shape (internal/signals/record.go): `ts` for the
// timestamp — NOT `at` — so `tkr signals decisions` / LoadRecords parse
// these rows with a real timestamp; `event` lets typed readers
// (RouteDecisionRow filters event=="route-classified") skip them cleanly.
// reason follows the DELEG-LADDER "interceptor:<name>" convention.
// Rotated before append per hooks/CLAUDE.md hot-path rule.
function emitAutorouteDecision(sessionId, via, rateClass) {
  try {
    const dir =
      process.env.TKR_STATE_DIR ||
      path.join(os.homedir(), ".tkr");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "decisions.jsonl");
    rotateIfLarge(target);
    fs.appendFileSync(
      target,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "autoroute",
        session_id: sessionId || "",
        action: "subagent_model_haiku",
        delegate_via: via,
        rate_class: rateClass,
        reason: "interceptor:autoroute",
      }) + "\n",
    );
  } catch {
    // best-effort observability — never gate the rewrite path
  }
}
