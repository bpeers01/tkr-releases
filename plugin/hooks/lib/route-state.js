// hooks/lib/route-state.js
//
// Reader for the per-session CURRENT route state written by
// `tkr route classify` (internal/route/state.go). This is the
// authoritative transport for a route verdict; the prompt-hash cache
// (tkr-route-<sha1>.json) remains only as a fallback for verdicts
// written by a pre-migration binary.
//
// Why the state exists: the prompt-hash cache is keyed on prompt text
// alone, so two sessions submitting identical text within the TTL shared
// one verdict — and the second session's classify never ran, because the
// cache hit short-circuited before the spawn. Its model therefore never
// reached the shape matrix. Everything this module validates is identity
// the cache could not carry.
//
// Contract with the Go writer — both sides must agree or every read
// silently misses:
//   path    <state-dir>/route-current-<sid>.json
//   schema  schema_version === STATE_SCHEMA_VERSION
//   fields  session_id, prompt_hash, active_model, written_at,
//           classification{...}, shape{...}
//
// Fail-open is absolute: every failure mode — missing, unreadable,
// corrupt, wrong schema, wrong session, wrong prompt, wrong model,
// stale — returns null. Callers treat null as "no verdict available"
// and stay silent.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { stateDir } = require("./state-dir");

// Mirrors internal/route/state.go CurrentStateSchemaVersion. Bump both
// together; a mismatch is a miss, so old binary + new hook degrades to
// silence rather than to misinterpretation.
const STATE_SCHEMA_VERSION = 1;

// Mirrors internal/route/state.go CurrentStateTTL (5 minutes). The read
// normally lands microseconds after the write — classify runs
// synchronously on the same prompt — so this is a backstop against a
// crashed-then-resumed session replaying a stale verdict.
const STATE_TTL_SECS = 300;

function routeStatePath(sid) {
  if (!sid) return "";
  return path.join(stateDir(), `route-current-${sid}.json`);
}

// promptHash mirrors route.PromptHash (SHA-1 hex of the raw prompt).
function promptHash(promptText) {
  return crypto.createHash("sha1").update(String(promptText)).digest("hex");
}

// modelFamily reduces any model identifier or display name to its family
// — the same haiku < sonnet < opus < fable tiers route.Family uses.
// Returns "" for anything unrecognized.
function modelFamily(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return "";
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "";
}

const FAMILY_ALT = "fable|opus|sonnet|haiku";
// Bare or dated capability key: claude-sonnet-5, claude-sonnet-4-6,
// claude-opus-5-20260724. The trailing -YYYYMMDD date suffix is stripped
// because route.NormalizeModel resolves dated IDs to the undated key.
const ID_RE = new RegExp(`^claude-(${FAMILY_ALT})-(\\d[\\d-]*?)(?:-\\d{8})?$`);
// Display name: "Sonnet 5", "Claude Sonnet 4.6", "Claude Sonnet 5 (1M context)".
const DISPLAY_RE = new RegExp(`^(${FAMILY_ALT})\\s+([\\d.]+)$`);

// normalizeModelKey maps any model identifier or display name to the
// capability-matrix key the Go side stores in state ("claude-sonnet-5").
// Returns "" when the string doesn't resolve to that form.
//
// Version granularity matters and family granularity is not enough: the
// capability matrix distinguishes claude-sonnet-4-6 from claude-sonnet-5
// (different effort ladders — 4-6 has no xhigh band), so treating them as
// interchangeable would serve a verdict computed against the wrong ladder.
// This mirrors route.NormalizeModel's two recognized shapes WITHOUT
// duplicating its tier table — the version is carried through rather than
// validated, so a new model release needs no change here.
function normalizeModelKey(model) {
  let s = String(model || "").trim().toLowerCase();
  if (!s) return "";
  const id = s.match(ID_RE);
  if (id) return `claude-${id[1]}-${id[2]}`;
  s = s.replace(/^claude\s+/, "");
  const paren = s.indexOf("(");
  if (paren >= 0) s = s.slice(0, paren);
  const disp = s.trim().match(DISPLAY_RE);
  if (disp) return `claude-${disp[1]}-${disp[2].replace(/\./g, "-")}`;
  return "";
}

// sameModel reports whether a verdict written under model `a` may be
// served to a session running model `b`.
//
// Strictest comparison both sides support: when both normalize to a
// capability key, they must be the SAME key — version included. When one
// side doesn't normalize (an unrecognized backend string), fall back to
// family. When a family can't be determined either, accept — the
// alternative is suppressing every verdict in sessions where the model is
// unobservable, which is most of them, and an absent signal is not
// evidence of a mismatch.
function sameModel(a, b) {
  const ka = normalizeModelKey(a);
  const kb = normalizeModelKey(b);
  if (ka && kb) return ka === kb;
  const fa = modelFamily(a);
  const fb = modelFamily(b);
  if (!fa || !fb) return true;
  return fa === fb;
}

// readRouteState returns the validated state object for sid, or null.
//
// opts.promptHash — when set, the state must have been written for this
//   exact prompt. The prompt hook always passes it; a verdict for the
//   previous turn's prompt is not a verdict for this one.
// opts.model — when set, the state must have been written under a
//   compatible active model (see sameModelFamily).
function readRouteState(sid, opts) {
  const options = opts || {};
  try {
    const target = routeStatePath(sid);
    if (!target) return null;

    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schema_version !== STATE_SCHEMA_VERSION) return null;
    if (!parsed.session_id || parsed.session_id !== sid) return null;

    const writtenAt = parsed.written_at ? Date.parse(parsed.written_at) : NaN;
    if (!Number.isFinite(writtenAt)) return null;
    // Absolute age: a far-future timestamp is clock skew or a hand-edited
    // file, not a usable verdict. Matches CurrentState.Fresh().
    if (Math.abs(Date.now() - writtenAt) / 1000 > STATE_TTL_SECS) return null;

    if (options.promptHash && parsed.prompt_hash !== options.promptHash) return null;
    if (options.model && !sameModel(parsed.active_model, options.model)) return null;

    return parsed;
  } catch {
    return null;
  }
}

// legacyCacheIsUsable reports whether a prompt-hash cache entry may be
// honored after a per-session state miss.
//
// The cache is keyed on prompt text alone, so session A's entry is
// readable by session B. Honoring it unconditionally re-creates the exact
// cross-session bleed the state exists to prevent: B finds A's verdict,
// treats the prompt as already classified, and never runs its own
// classifier. The `state_schema` marker separates the two reasons a state
// lookup misses — a state-capable writer (miss means "not yours", refuse)
// from a pre-migration binary (the cache is its only channel, honor it).
function legacyCacheIsUsable(entry) {
  if (!entry || typeof entry !== "object") return false;
  return !entry.state_schema;
}

// toVerdict flattens a state object into the flat shape the hook's
// injection logic already speaks (the prompt-hash CacheEntry shape), so
// state and cache are interchangeable downstream. Returns null when the
// state carries no usable classification.
function toVerdict(state) {
  if (!state || typeof state !== "object") return null;
  const c = state.classification || {};
  if (c.disabled === true) return null;
  const s = state.shape || {};
  const rec = s.recommendation || {};
  return {
    task_class: c.task_class || "",
    effort: c.effort || "",
    why: c.why || "",
    confidence: c.confidence || "",
    model: c.model || "",
    active_model: state.active_model || c.active_model || "",
    recommended_model: c.recommended_model || "",
    shape: s.shape || "",
    recommend_effort: rec.effort || "",
    escalate_model: rec.escalate_model || "",
    downgrade_model: rec.downgrade_model || "",
    high_stakes: s.high_stakes === true,
    source: "state",
  };
}

module.exports = {
  STATE_SCHEMA_VERSION,
  STATE_TTL_SECS,
  routeStatePath,
  promptHash,
  modelFamily,
  normalizeModelKey,
  sameModel,
  readRouteState,
  legacyCacheIsUsable,
  toVerdict,
};
