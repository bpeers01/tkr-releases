// PLAN-1 (Wave-0, v3.13.1) — cache-TTL inference at SessionStart.
//
// performTTLInference(sid) calls detectTTL() once per startup and, when
// the detection had real evidence (source "direct" from the Anthropic
// per-tier breakdown, or "inferred" from an idle-gap heuristic), emits
// an L6 fired event to the playbook ledger.
//
// Skipped emits:
//   - source "config"   → operator override, not inference
//   - source "default"  → no signal; emitting would just record absence
//
// The kill switch (TKR_TTL_DETECTION_DISABLED=1) is honored inside
// detectTTL itself — it returns the {300, "default", 0} tuple with no
// persistence, which lands on the no-emit path above. The caller MUST
// NOT re-gate to avoid double-checking semantics.
//
// Hot-path budget: single detectTTL call (~5ms tail-read + JSON parse)
// plus at most one playbook-events.jsonl append. Persistence side-
// effects belong to cache-ttl.js, not this thin wrapper.
//
// Consumers downstream (T4 L5 cache-bust-warn cost estimate, T5 push-
// clear-nudge stale-cache check, T6 pre-compact retention math) call
// detectTTL independently — the cached inference written by cache-ttl
// makes those calls near-free.

"use strict";

const { detectTTL } = require("../cache-ttl");
const { emitEvent } = require("../playbook-emit");

function performTTLInference(sid) {
  const result = detectTTL(sid);
  if (result.source === "direct" || result.source === "inferred") {
    emitEvent(
      "L6",
      "fired",
      {
        ttl_seconds: result.ttl_seconds,
        source: result.source,
        idle_gap_observed_secs: result.idle_gap_observed_secs || 0,
      },
      null,
      sid,
    );
  }
  return result;
}

module.exports = { performTTLInference };
