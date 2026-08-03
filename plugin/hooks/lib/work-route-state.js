// hooks/lib/work-route-state.js
//
// Native-work-routing §13.2 — the Agent PreToolUse hook's view of the
// current work plan.
//
// UserPromptSubmit reads route state to decide whether to EMIT a
// coordinator directive; this module exists so the Agent hook can decide
// whether to ACT on the plan that directive named.
//
// Two things make acting harder than emitting, and both are enforced
// here rather than left to the caller.
//
// PROOF OF TURN. The UserPromptSubmit read validates the prompt hash, so
// its directive provably belongs to the prompt in front of it. An Agent
// hook holds a different prompt entirely and cannot make that check, and
// session+freshness alone is not enough: if turn B's classify times out
// or never writes, turn A's plan is still inside the 5-minute TTL, the
// directive correctly stays silent for turn B (hash mismatch), and a
// naive Agent hook would happily reshape turn B's spawn using turn A's
// safety verdict. Turn B might be the mutation-heavy one. So
// UserPromptSubmit now leaves a per-turn RECEIPT naming the plan it
// actually told the coordinator about, and acting requires one. The
// receipt is JS-owned, which keeps route-current-<sid>.json's
// single-writer rule (the Go binary) intact.
//
// EXCLUSIVITY. "One plan, one spawn" cannot be enforced by reading a
// marker and then writing it: parallel PreToolUse(Agent) processes are
// normal whenever the coordinator dispatches several workers at once,
// and both would read "unconsumed" before either wrote. Claiming is a
// single exclusive-create instead, so exactly one process can win.
//
// Fail closed, not open. Every failure here means "do not rewrite" —
// a missed optimization, never a plan applied to work it was not
// written for.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const routeState = require("./route-state.js");

// Modes in which the Agent hook may rewrite tool input. Advisory
// deliberately absent: it records what the coordinator did, it does not
// change it. Managed is absent because it does not exist yet — §13.3
// leaves it as future opt-in, and an unrecognized mode must never fall
// through to "rewrite".
const REWRITE_MODES = new Set(["assisted"]);

// Modes in which the coordinator was TOLD about the plan, and so the
// only modes where "did it follow?" is a meaningful question. In observe
// nothing reaches the model, so a matching profile is coincidence and a
// mismatch is not a refusal — scoring either would corrupt the metric
// this telemetry exists to produce.
const FOLLOWABLE_MODES = new Set(["advisory", "assisted", "managed"]);

// Stale receipts/claims are swept at SessionStart on the same 24h policy
// as mode and statusline files.
const STALE_MS = 24 * 60 * 60 * 1000;

// §6.1/§6.2 vocabulary the JS side recognizes (isolation proposal §11).
// Both hooks gate on this allowlist in the same PR that first emits
// `objective`: there is no JS-side same-model check other than this and
// the isolate-only exemption in the Agent hook, so an unknown objective
// must make the hooks DECLINE — an unrecognized reason for leaving the
// main session is not one they can represent to the coordinator, and
// filling a spawn under it could be exactly the same-model cost-doubling
// the Go gate exists to refuse.
const WORK_OBJECTIVES = new Set(["economize", "isolate", "escalate"]);
const MODEL_STRATEGIES = new Set(["downshift", "same", "upshift"]);

// planObjective classifies a plan's objective/model_strategy pair.
//
// Three outcomes, not two, because old Go binaries are a real deployment
// state: a plan written before the vocabulary existed carries NEITHER
// field, and declining on it would silence the whole (already-shipped)
// advisory directive during every mixed-version window. Absent-both is
// the pre-vocabulary economize route by construction — v1 selection only
// ever routed the economize/downshift matrix row — so it stays usable as
// legacy. Anything partial or unrecognized is untrusted state: decline.
//
//	{ ok: true,  legacy: true,  objective: "", strategy: "" }   old binary
//	{ ok: true,  legacy: false, objective, strategy }           recognized
//	{ ok: false }                                               decline
function planObjective(plan) {
  const objective = String((plan && plan.objective) || "");
  const strategy = String((plan && plan.model_strategy) || "");
  if (!objective && !strategy) {
    return { ok: true, legacy: true, objective: "", strategy: "" };
  }
  if (WORK_OBJECTIVES.has(objective) && MODEL_STRATEGIES.has(strategy)) {
    return { ok: true, legacy: false, objective, strategy };
  }
  return { ok: false, legacy: false, objective: "", strategy: "" };
}

function stateDir() {
  return process.env.TKR_STATE_DIR || path.join(os.homedir(), ".tkr");
}

// Session ids and plan ids reach the filesystem as path components, so
// they are validated rather than trusted. Anything outside this charset
// fails the operation closed instead of being sanitized into a
// different-but-valid name.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function safeID(v) {
  const s = String(v || "");
  return s && s.length <= 128 && SAFE_ID.test(s) ? s : "";
}

function receiptPath(sid) {
  const s = safeID(sid);
  return s ? path.join(stateDir(), `work-receipt-${s}.json`) : "";
}

function claimPath(sid, planID) {
  const s = safeID(sid);
  const p = safeID(planID);
  return s && p ? path.join(stateDir(), `work-claim-${s}-${p}`) : "";
}

// writeAtomic — unique temp name per writer. A fixed "<target>.tmp"
// collides between concurrent hook processes, which is the same class of
// bug #91 removed from the rotators.
function writeAtomic(target, body) {
  // BigInt stringifies directly — do NOT wrap in Math.floor, which throws
  // on BigInt and would land in the caller's swallowed catch, silently
  // never writing the receipt and disabling assisted routing entirely.
  const tmp = `${target}.${process.pid}.${process.hrtime.bigint() % 1000000n}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}

// writeDirectiveReceipt records what UserPromptSubmit told the
// coordinator this turn. It MUST be called on every prompt, including
// when nothing was emitted (directive_emitted:false) — a receipt that is
// only written on success is indistinguishable from last turn's receipt,
// which is the whole failure this exists to prevent.
function writeDirectiveReceipt(sid, fields) {
  try {
    const target = receiptPath(sid);
    if (!target) return;
    fs.mkdirSync(stateDir(), { recursive: true });
    writeAtomic(target, JSON.stringify({
      session_id: String(sid),
      prompt_hash: String((fields && fields.promptHash) || ""),
      plan_id: String((fields && fields.planID) || ""),
      directive_emitted: Boolean(fields && fields.directiveEmitted),
      written_at: new Date().toISOString(),
    }));
  } catch {
    // Best-effort, and the failure direction is safe: no receipt means
    // assisted routing declines to act.
  }
}

// readDirectiveReceipt returns this turn's receipt, or null.
function readDirectiveReceipt(sid) {
  try {
    const target = receiptPath(sid);
    if (!target) return null;
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (String(parsed.session_id || "") !== String(sid)) return null;
    const writtenAt = parsed.written_at ? Date.parse(parsed.written_at) : NaN;
    if (!Number.isFinite(writtenAt)) return null;
    // Same absolute-age discipline as route state: a far-future stamp is
    // clock skew or a hand-edited file, not a usable receipt.
    if (Math.abs(Date.now() - writtenAt) / 1000 > routeState.STATE_TTL_SECS) return null;
    return parsed;
  } catch {
    return null;
  }
}

// claimPlan atomically claims planID for this session, returning true
// only for the process that wins. Exclusive create is the whole
// mechanism: the loser gets EEXIST and must not rewrite.
//
// Every other error also returns false. That is deliberate — an
// unwritable state dir disables assisted routing rather than letting an
// unbounded number of spawns be reshaped off one plan.
function claimPlan(sid, planID) {
  let fd;
  try {
    const target = claimPath(sid, planID);
    if (!target) return false;
    fs.mkdirSync(stateDir(), { recursive: true });
    fd = fs.openSync(target, "wx");
    fs.writeSync(fd, JSON.stringify({
      session_id: String(sid),
      plan_id: String(planID),
      pid: process.pid,
      at: new Date().toISOString(),
    }));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// currentWorkPlan returns the session's current plan, or null.
//
// Returning null is what keeps a stale plan out of BOTH channels — the
// rewrite and the ledger. An earlier version proved the turn only on the
// path that rewrites, so a plan from a previous turn could still be
// scored against this turn's spawn: the Agent was correctly left alone,
// and the follow rate was quietly corrupted anyway. Telemetry is the
// justification for ever acting, so it has to be at least as careful as
// acting is.
//
// Proof is the receipt's prompt hash matching route state's. Both are
// written for the same prompt by the same turn, so agreement means the
// plan and the receipt describe the same turn — a check that works even
// in observe, where no directive is emitted and the receipt names no
// plan.
//
// Returns { plan, planID, mode, state, announced }. `announced` is the
// stronger fact: a directive naming this exact plan actually went out.
// Acting requires it; scoring a follow requires it (there is nothing to
// follow otherwise); merely recording the plan does not.
function currentWorkPlan(sid, opts) {
  const options = opts || {};
  try {
    if (!sid) return null;
    if (process.env.TKR_HOOKS_DISABLED === "1") return null;
    if (process.env.TKR_ROUTE_DISABLED === "1") return null;
    if (process.env.TKR_WORK_ROUTE_DISABLED === "1") return null;

    const state = routeState.readRouteState(sid, { model: options.model || "" });
    if (!state) return null;
    if (state.classification && state.classification.disabled === true) return null;

    const plan = state.work_plan;
    if (!plan || typeof plan !== "object") return null;
    if (plan.disposition !== "native_subagent") return null;
    if (plan.high_stakes === true) return null;
    if (String(plan.confidence || "") === "low") return null;

    const planID = String(plan.plan_id || state.plan_id || "");
    if (!planID) return null;

    // §11 allowlist. Unknown or partial objective/strategy state means
    // the plan cannot be trusted at all — not "record it anyway": every
    // downstream reader of this descriptor would be attributing intent
    // the vocabulary does not contain.
    const objective = planObjective(plan);
    if (!objective.ok) return null;

    // Same-turn proof, required for any use of this plan.
    const statePromptHash = String(state.prompt_hash || "");
    if (!statePromptHash) return null;
    const receipt = readDirectiveReceipt(sid);
    if (!receipt) return null;
    if (String(receipt.prompt_hash || "") !== statePromptHash) return null;

    return {
      plan,
      planID,
      mode: String(plan.mode || ""),
      state,
      objective: objective.objective,
      modelStrategy: objective.strategy,
      announced:
        receipt.directive_emitted === true &&
        String(receipt.plan_id || "") === planID,
    };
  } catch {
    return null;
  }
}

// receiptProvesTurn reports whether the coordinator was told about
// planID on the current turn. Without this, "fresh state for this
// session" is the only join, and a plan outlives the turn it was
// computed for by up to the full TTL.
function receiptProvesTurn(sid, planID) {
  const receipt = readDirectiveReceipt(sid);
  if (!receipt) return false;
  if (receipt.directive_emitted !== true) return false;
  return String(receipt.plan_id || "") === String(planID);
}

function modeAllowsRewrite(mode) {
  return REWRITE_MODES.has(String(mode || ""));
}

function modeIsFollowable(mode) {
  return FOLLOWABLE_MODES.has(String(mode || ""));
}

// sweepStaleWorkFiles removes receipts and claims older than staleMs.
// Claims are per-plan, so a long session accumulates one file per plan
// it actually acted on; SessionStart prunes them on the same 24h policy
// as mode and statusline files. Returns the number removed.
function sweepStaleWorkFiles(now = Date.now(), staleMs = STALE_MS) {
  let removed = 0;
  try {
    const dir = stateDir();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("work-receipt-") && !name.startsWith("work-claim-")) continue;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > staleMs) {
          fs.rmSync(full, { force: true });
          removed++;
        }
      } catch {}
    }
  } catch {}
  return removed;
}

module.exports = {
  REWRITE_MODES,
  FOLLOWABLE_MODES,
  MODEL_STRATEGIES,
  STALE_MS,
  WORK_OBJECTIVES,
  planObjective,
  claimPath,
  claimPlan,
  currentWorkPlan,
  modeAllowsRewrite,
  modeIsFollowable,
  readDirectiveReceipt,
  receiptPath,
  receiptProvesTurn,
  sweepStaleWorkFiles,
  writeDirectiveReceipt,
};
