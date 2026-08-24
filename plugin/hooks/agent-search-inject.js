#!/usr/bin/env node
// tkr PreToolUse hook — Agent tool input rewriter.
//
// Four responsibilities:
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
//   4. (ADR-0033, Phase 4) Spawn-time veto: for tkr:* subagent_type
//      candidates, ask `tkr route veto-check` whether the profile's own
//      contract forbids this spawn — a mutating task aimed at a read-only
//      worker, or an explicit model outranking the profile's own tier. In
//      an enforcing mode (advisory/assisted/managed) a violation blocks
//      the tool call outright rather than rewriting it. Fail-open
//      throughout: any transport failure (missing binary, timeout, bad
//      JSON) reads as allow, never as a stuck denial.
//
// All rewrites use PreToolUse hookSpecificOutput.updatedInput, which the
// existing tkr-rewrite.js hook already proves is mutable. The veto path is
// the one exception — a deny response carries no updatedInput, only the
// block decision (see vetoCheck / the deny branch in handleInput below).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { getSessionID } = require("./lib/session-id");
const { emitTaskSpawn } = require("./lib/task-spawns");
const { loadAutorouteConfig } = require("./lib/injection-config");
const { getTelemetryPath } = require("./lib/statusline-path");
const { readJSONSync } = require("./lib/safe-json");
const { rotateIfLarge } = require("./lib/rotate-jsonl");
const { isSubagentContext } = require("./lib/subagent-context");
const { tkrSpawnArgv } = require("./lib/tkr-bin");
const { snapshotGitStatus } = require("./lib/git-status-snapshot");
const {
  rememberMode,
  timeoutVerdict,
  vetoTimeoutMs,
} = require("./lib/veto-fallback");
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

    // INV-097: snapshot the worktree's tracked-file state before this
    // subagent runs, so SubagentStop (subagent-outcome.js) can detect a
    // mutation the agent's own final message never reported. Best-effort
    // and fails open — see hooks/lib/git-status-snapshot.js.
    snapshotGitStatus(sid);

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

    // ADR-0033 Phase 4 — spawn-time veto. Resolved before the ledger row,
    // same reasoning as `work` above: the row needs to carry whether a
    // check ran and what it found. null means "no verdict" (non-tkr
    // profile, feature off, or the check itself failed open) and must
    // never be treated as a denial — only an explicit deny verdict blocks.
    //
    // TWO checks, not one (#143 finding 2). The first is the call as the
    // coordinator wrote it. The second is the call this hook would
    // actually emit — and only that one can see an assisted rewrite,
    // because vetoCheck scopes itself to tkr:* profiles and a generic or
    // Explore spawn carries none until the rewrite gives it one. Without
    // it, a spawn whose prompt carries mutation intent could become
    // tkr:explore-haiku, a read-only profile, with the profile's own
    // contract never consulted about the call that ran.
    const forceForeground = toolInput.run_in_background !== false;
    const shouldInjectPrompt = shouldInject(subagentType);
    // Capacity autoroute is skipped when task routing already owns this
    // spawn's model. The two axes stay separate by design (DELEG is
    // pressure, WRK is task shape) but exactly one of them may write the
    // model field, or the second silently overwrites the first. Keyed on
    // ELIGIBILITY rather than a taken claim so the prospective call is
    // built from the same decisions the real one will be.
    const workEligible = Boolean(work && work.eligible);
    const autoModel = workEligible ? "" : autorouteModel(event, toolInput, subagentType);

    const buildOpts = {
      forceForeground,
      shouldInjectPrompt,
      applyWork: workEligible,
      work,
      autoModel,
    };
    const prospective = buildUpdatedInput(toolInput, prompt, buildOpts);

    const asWritten = vetoCheck(subagentType, toolInput);
    // Only worth a second subprocess when the rewrite would actually
    // change the profile being asked about; otherwise this is the same
    // question the first check already answered.
    // The PROFILE checked is the prospective one; the PROMPT checked is
    // the coordinator's, never the one this hook just assembled. tkr must
    // not read intent from its own boilerplate: SEARCH_GUIDANCE ends
    // "...to explore the codebase, run:", and `run` is in mutationVerbs
    // (internal/route/intent.go), so the injected text alone renders
    // mutation_to_readonly_worker. Passing `prospective` here denied EVERY
    // assisted Explore spawn — the hook shaped the call and then vetoed
    // itself for the shaping. Checking the coordinator's prompt against the
    // emitted profile keeps #143 finding 2 intact (the rewritten profile is
    // still consulted) and drops only the signal tkr wrote.
    const asEmitted = workEligible && work.plannedProfile !== subagentType
      ? vetoCheck(prospective.subagent_type, { ...prospective, prompt: toolInput.prompt || "" })
      : { verdict: null, unavailable: "" };
    // What POLICY said, on the checks that answered. Kept separate from the
    // local fallback below all the way to the ledger: `veto_checked: true`
    // must keep meaning "route.VetoCheck rendered this verdict", or the
    // coverage metric silently starts counting the hook's own guesses.
    const policyVeto = strongestVerdict(asWritten.verdict, asEmitted.verdict);
    // First failure wins. Either check failing means this spawn ran with
    // at least one question unanswered, which is the fact the row records;
    // enumerating both would imply the two are independently actionable.
    const vetoUnavailable = asWritten.unavailable || asEmitted.unavailable;

    // #143 finding 1, second half. A timeout at the MEASURED budget means
    // the binary is hung, not that the box is busy — that is what makes a
    // local decision defensible at all, and it is why the budget had to be
    // measured before this branch could exist. Evaluated per check against
    // the spawn that check was asking about: the as-written call and the
    // rewritten one can name different profiles and carry different prompts,
    // so one may fall inside the fail-closed class while the other does not.
    // Every other unavailable reason (unreachable, bad_response) means the
    // check COULD NOT RUN and stays fail-open — a machine without a working
    // tkr must not have its spawns depend on one.
    const localVeto = strongestVerdict(
      asWritten.unavailable === "timeout"
        ? timeoutVerdict({ subagentType, prompt: toolInput.prompt || "" })
        : null,
      asEmitted.unavailable === "timeout"
        ? timeoutVerdict({
          subagentType: prospective.subagent_type,
          prompt: prospective.prompt || "",
        })
        : null,
    );

    // Severity ordering does the merge, so a local deny cannot be masked by
    // the other check's allow — the same rule finding 2 established for the
    // as-written/as-emitted pair.
    const veto = strongestVerdict(policyVeto, localVeto);
    const vetoDenied = Boolean(veto && veto.enforce === true && veto.verdict === "deny");

    // Claim only once every refusal is settled. A denied spawn leaves the
    // plan unclaimed so a corrected retry can still use it (#143 finding
    // 2); before this, the claim was taken inside workRoute and a veto
    // arriving afterwards consumed the plan for a spawn that never ran.
    if (!vetoDenied) {
      claimWork(sid, work);
    }
    // A lost claim means this process may not apply the plan after all,
    // so the emitted call must fall back to the un-rewritten form. Built
    // from the same builder rather than patched, so the two paths cannot
    // disagree about what "no rewrite" means.
    const applyWork = Boolean(work && work.apply);
    const updatedInput = applyWork === workEligible
      ? prospective
      : buildUpdatedInput(toolInput, prompt, {
        ...buildOpts,
        applyWork,
        autoModel: applyWork ? "" : autorouteModel(event, toolInput, subagentType),
      });

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
      // Veto fields are spawn-level, not plan-level: a veto can fire (or
      // not run at all) independently of whether a work plan was current,
      // so they sit beside the plan_id block rather than inside it.
      ...(policyVeto ? {
        veto_checked: true,
        veto_denied: policyVeto.enforce === true && policyVeto.verdict === "deny",
        veto_reason: policyVeto.reason || "",
        veto_would_deny: policyVeto.would_deny === true,
      } : vetoUnavailable ? {
        // Mutually exclusive with veto_checked, and deliberately a
        // DIFFERENT key rather than veto_checked:false: absence of
        // veto_checked keeps meaning "no check was attempted" on both v4
        // and v5 rows, so nothing that already reads this ledger changes
        // meaning. This key adds the case that was previously
        // indistinguishable from it — attempted, and could not answer.
        veto_unavailable: vetoUnavailable,
      } : {}),
      // v6 (#143 finding 1). A denial the HOOK made because policy did not
      // answer in time. Deliberately its own key rather than folded into
      // veto_denied: that field answers "did the policy refuse this spawn",
      // and a fallback denial is a different claim with different standing —
      // it is made on a cached mode and a keyword scan, and it is the one
      // denial a user can hit with tkr wedged. Counting the two together
      // would make the veto look more authoritative than it is, in exactly
      // the situation where it is least so. Written whenever the fallback
      // denied, independently of whether the OTHER check answered.
      ...(localVeto && localVeto.verdict === "deny" ? {
        veto_local_deny: true,
        veto_local_reason: localVeto.reason || "",
      } : {}),
    });

    // A denial blocks the tool call outright — checked AFTER emitTaskSpawn
    // so the ledger row records the veto regardless of what happens next,
    // and BEFORE any rewrite logic, since a denied spawn is never rewritten.
    // Both response forms are carried for Claude Code version compat: the
    // older top-level decision/reason contract and the newer
    // hookSpecificOutput.permissionDecision one. No updatedInput on a deny.
    if (vetoDenied) {
      const detail = veto.detail || veto.reason || "";
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: detail,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: detail,
        },
      }));
      return;
    }

    // Nothing to change: no forced foreground, no guidance, no model
    // rewrite, no plan applied. Exit without an updatedInput rather than
    // emitting one identical to the input.
    if (!forceForeground && !shouldInjectPrompt && !autoModel && !applyWork) {
      process.exit(0);
      return;
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

// buildUpdatedInput produces the tool_input this hook would emit for a
// given set of decisions.
//
// Factored out so the call the veto INSPECTS and the call that actually
// RUNS are produced by the same code (#143 finding 2). Two hand-rolled
// copies would drift, and the drift would be invisible: the veto would
// keep passing while the emitted call diverged from what it approved.
function buildUpdatedInput(toolInput, prompt, opts) {
  const updatedInput = { ...toolInput };
  if (opts.forceForeground) {
    updatedInput.run_in_background = false;
  }
  if (opts.shouldInjectPrompt) {
    updatedInput.prompt = SEARCH_GUIDANCE.trimEnd() + "\n\n" + prompt;
  }
  if (opts.applyWork) {
    updatedInput.subagent_type = opts.work.plannedProfile;
    updatedInput.model = opts.work.plannedModel;
    updatedInput.run_in_background = false;
    updatedInput.prompt =
      WORKER_CONTRACT_SCAFFOLD.trimEnd() + "\n\n" + (updatedInput.prompt || prompt);
  }
  if (opts.autoModel) {
    updatedInput.model = opts.autoModel;
    // Smaller models execute well on explicit instructions and degrade
    // on ambiguity (larger models absorb it). A downgraded spawn gets
    // an execution contract, not just a cheaper engine — otherwise the
    // savings leak back out as wandering tool calls and rework.
    updatedInput.prompt =
      DOWNGRADE_SCAFFOLD.trimEnd() + "\n\n" + (updatedInput.prompt || prompt);
  }
  return updatedInput;
}

// strongestVerdict picks the verdict that should govern, and the one the
// ledger row should carry, across the two veto checks a spawn can face.
//
// Precedence is by severity, not by which check ran first: an enforcing
// deny outranks an observe-mode would-deny, which outranks a plain
// allow. Anything else and a rewritten call's deny could be masked by
// the original call's allow — which is the whole gap finding 2 names.
function strongestVerdict(a, b) {
  const rank = (v) => {
    if (!v) return 0;
    if (v.enforce === true && v.verdict === "deny") return 3;
    if (v.would_deny === true) return 2;
    return 1;
  };
  return rank(b) > rank(a) ? b : a;
}

// vetoCheck asks `tkr route veto-check` whether this spawn violates the
// named tkr:* profile's own contract (ADR-0033 Phase 4). Returns null for
// "no verdict, proceed" — a non-tkr subagent_type, the kill switch, or any
// transport failure — and the parsed route.VetoVerdict object otherwise.
// null is never treated as a denial; only an explicit {verdict:"deny",
// enforce:true} object blocks a spawn.
//
// Scoped to tkr:* the same way the Go policy scopes itself (veto.go's doc
// comment): a blueprint:* or built-in agent was chosen for capabilities
// this policy knows nothing about, so a check that never ran costs nothing
// and a check that ran and got it wrong would answer a question nobody
// asked.
// Returns { verdict, unavailable }:
//   verdict     — the parsed route.VetoVerdict, or null for "no verdict".
//   unavailable — "" when no check was ATTEMPTED (non-tkr profile, kill
//                 switch), otherwise why an attempted check produced no
//                 verdict: "timeout" | "unreachable" | "bad_response".
//
// That split is the point (#143 finding 1). Fail-open is correct and stays
// exactly as it was — but it used to be SILENT, and a silent fail-open is
// unmeasurable: the ledger row for a veto that timed out was byte-identical
// to one for a spawn nobody ever asked about. On Windows, where a bare
// process spawn degrades to 4-6s under multi-session load (INV-085) against
// this 500ms budget, that is the difference between "the veto is not
// firing" and "the veto had nothing to say".
function vetoCheck(subagentType, toolInput) {
  const none = { verdict: null, unavailable: "" };
  if (!String(subagentType).startsWith("tkr:")) return none;
  if (process.env.TKR_WORK_VETO_DISABLED === "1") return none;
  try {
    const { cmd, argv } = tkrSpawnArgv(["route", "veto-check"]);
    // INV-119: resolveTkrBin now returns null instead of a bare "tkr" when
    // nothing resolves (no TKR_BIN, no install location, no PATH match) —
    // there is genuinely no binary to spawn. Previously this same outcome
    // reached spawnSync as a bare name and came back as an ENOENT res.error,
    // classified below as "unreachable"; short-circuit to the same verdict
    // here rather than letting spawnSync's synchronous "cmd must be a
    // string" TypeError fall through to the generic catch below, which
    // would misreport a resolution failure as "bad_response" (a check that
    // ran and answered oddly, which this is not).
    if (!cmd) return { verdict: null, unavailable: "unreachable" };
    const res = spawnSync(cmd, argv, {
      input: JSON.stringify({
        subagent_type: subagentType,
        model: toolInput.model || "",
        prompt: toolInput.prompt || "",
      }),
      encoding: "utf8",
      timeout: vetoTimeoutMs(),
      windowsHide: true,
    });
    // FAIL OPEN: a missing/hung/watchdog-killed tkr binary, a nonzero
    // exit, or an empty response must never block a spawn — they are all
    // "the check did not run", not "the check said no". Each is now named.
    if (res.error) {
      // Node reports a timeout kill as an ETIMEDOUT error; everything else
      // (ENOENT, EACCES, ENOEXEC) means the binary could not be run.
      const timedOut = res.error.code === "ETIMEDOUT" || res.signal === "SIGTERM";
      return { verdict: null, unavailable: timedOut ? "timeout" : "unreachable" };
    }
    if (res.status !== 0 || !res.stdout) {
      return { verdict: null, unavailable: "bad_response" };
    }
    const parsed = JSON.parse(res.stdout);
    if (!parsed || typeof parsed !== "object") {
      return { verdict: null, unavailable: "bad_response" };
    }
    // Condition 3 of the fail-closed scope needs the work mode, and the
    // process that knows it is this one, on the calls that DID answer. A
    // timeout has no verdict to read a mode off, and growing a second JS
    // reader of the Go config would be a parallel port with all the drift
    // that implies — so every answered verdict leaves its mode behind for
    // the timeout path to find. Best-effort: an unwritable state dir costs
    // a later fail-open and nothing else.
    rememberMode(parsed.mode);
    return { verdict: parsed, unavailable: "" };
  } catch {
    // Includes a stdout payload that failed to parse as JSON — same
    // fail-open rule.
    return { verdict: null, unavailable: "bad_response" };
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

    // Eligible, NOT claimed. The claim moved out to the caller (#143
    // finding 2): it has to happen after the veto, and the veto cannot
    // run until the rewrite this function describes is known. Claiming
    // here burned the plan on spawns the veto then denied, so the
    // corrected retry found nothing to route — "not burned by a spawn
    // that was going to be refused anyway" was the intent all along,
    // and a refusal arriving from the veto is still a refusal.
    descriptor.eligible = true;
    return descriptor;
  } catch {
    return null;
  }
}

// claimWork takes the exclusive plan claim for an eligible descriptor and
// records the outcome on it. Split from workRoute so every reason to
// refuse a spawn — including the veto, which needs the rewritten call
// workRoute describes — is settled before the plan is consumed.
//
// Exclusive create, not check-then-write: parallel PreToolUse(Agent)
// processes are routine when the coordinator dispatches several workers
// at once, and both would pass a read-only check.
//
// A denied claim is recorded, because "one plan reshaped at most one
// spawn" is an invariant nobody can check from a ledger that only shows
// the winner. Denied covers both causes claimPlan collapses together —
// the plan was already used, or the claim could not be written at all —
// and the field name says neither more than that.
function claimWork(sid, work) {
  if (!work || work.eligible !== true) return false;
  if (!claimPlan(sid, work.planID)) {
    work.claimDenied = true;
    return false;
  }
  work.apply = true;
  return true;
}

// isSubagentContext moved to lib/subagent-context.js (contract documented
// there) when the keepalive interactive-answer touch needed the same
// predicate — one definition, so the two callers cannot drift. It stays
// inert when every marker is absent, so the receipt and claim protections
// below remain load-bearing here.

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
