#!/usr/bin/env node
// Tests for the per-session current-route state channel
// (native-work-routing PR 0 §6.3): the UserPromptSubmit hook must treat
// route-current-<sid>.json as the AUTHORITATIVE verdict and validate the
// identity the old prompt-hash cache could not carry — session, prompt,
// active model, schema, freshness — while failing open on everything.
//
// Run: node hooks/user-prompt-submit.route-state.test.js

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Must precede the hook require: user-prompt-submit.js resolves its state
// dir once at module init.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-route-state-test-"));
process.env.TKR_STATE_DIR = STATE_DIR;

const test = require("node:test");
const assert = require("node:assert");

const {
  routeInjectContext,
  shapeNudgeContext,
  readRouteVerdict,
  activeModelHint,
  routeNudgeStatePath,
  ROUTE_STREAK_MIN,
  effortStatePath,
} = require("./user-prompt-submit.js");

const routeState = require("./lib/route-state.js");

const SCHEMA = routeState.STATE_SCHEMA_VERSION;

// ── Fixtures ────────────────────────────────────────────────────────────────

// writeState plants a state doc in the shape internal/route/state.go
// persists. Overrides are shallow-merged so each test can corrupt exactly
// one identity field.
function writeState(sid, prompt, overrides) {
  const doc = Object.assign(
    {
      schema_version: SCHEMA,
      session_id: sid,
      prompt_hash: crypto.createHash("sha1").update(prompt).digest("hex"),
      active_model: "claude-opus-5",
      written_at: new Date().toISOString(),
      classification: {
        active_model: "claude-opus-5",
        model: "claude-opus-5",
        effort: "high",
        brevity: "full",
        confidence: "high",
        why: "task-class=from_state",
        scope: "main",
        task_class: "from_state",
      },
      shape: {
        shape: "deep_exploration",
        high_stakes: false,
        confidence: "high",
        recommendation: { effort: "xhigh" },
        active_model: "claude-opus-5",
        legacy_class: "from_state",
        why: "task-class=from_state",
      },
    },
    overrides || {},
  );
  const fp = routeState.routeStatePath(sid);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(doc));
  return fp;
}

// writeCache plants a legacy prompt-hash cache entry with a deliberately
// DIFFERENT task_class, so which channel answered is unambiguous.
function writeCache(prompt, entry) {
  const sha1 = crypto.createHash("sha1").update(prompt).digest("hex");
  const fp = path.join(os.tmpdir(), "tkr-route-" + sha1 + ".json");
  fs.writeFileSync(
    fp,
    JSON.stringify({
      written_at: new Date().toISOString(),
      task_class: "from_cache",
      effort: "high",
      why: "cache",
      ...entry,
    }),
  );
  return fp;
}

function writeEffortFile(sid, effort) {
  const fp = effortStatePath(sid);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ effort }));
  return fp;
}

function cleanup(...fps) {
  for (const fp of fps) {
    try {
      fs.rmSync(fp, { force: true });
    } catch {}
  }
}

// Clear the ambient env the hook reads so file fallbacks are deterministic.
function withEnv(overrides, fn) {
  const keys = [
    "TKR_ROUTE_INJECT_MODE",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_EFFORT",
    "CLAUDE_MODEL",
    "TKR_ROUTE_SYNC",
    "TKR_ROUTE_DISABLED",
  ];
  const prev = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  // The classifier stays off: these tests seed verdicts and assert on
  // RESOLUTION, not classification. Leaving it on would run a real
  // `tkr route classify` on any machine with tkr installed, which for the
  // cross-session tests would then write session B's own state and mask
  // the very refusal being asserted. The classify-then-refuse ORDERING is
  // proven end-to-end against the real binary in route-classifier.sh
  // fixture 16, which is where it belongs.
  process.env.TKR_ROUTE_SYNC = "0";
  for (const [k, v] of Object.entries(overrides || {})) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ── State is authoritative ──────────────────────────────────────────────────

test("state wins over the legacy prompt-hash cache", () => {
  const sid = `rs-primary-${process.pid}`;
  const prompt = `rs-primary-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt);
  const cfp = writeCache(prompt);
  try {
    withEnv({}, () => {
      const v = readRouteVerdict({ prompt, session_id: sid }, prompt, null);
      assert.strictEqual(v.task_class, "from_state");
      assert.strictEqual(v.source, "state");
      assert.strictEqual(v.recommend_effort, "xhigh", "shape.recommendation.effort must flatten");
    });
  } finally {
    cleanup(sfp, cfp);
  }
});

test("cache still answers when no state exists (pre-migration binary)", () => {
  const sid = `rs-fallback-${process.pid}`;
  const prompt = `rs-fallback-prompt-${process.pid}`;
  const cfp = writeCache(prompt);
  try {
    withEnv({}, () => {
      const v = readRouteVerdict({ prompt, session_id: sid }, prompt, null);
      assert.strictEqual(v.task_class, "from_cache");
    });
  } finally {
    cleanup(cfp);
  }
});

// ── Identity validation ─────────────────────────────────────────────────────

test("another session's state is never consumed", () => {
  const mine = `rs-mine-${process.pid}`;
  const theirs = `rs-theirs-${process.pid}`;
  const prompt = `rs-shared-prompt-${process.pid}`;
  // Identical prompt text, verdict written by the OTHER session only.
  const sfp = writeState(theirs, prompt);
  try {
    withEnv({}, () => {
      assert.strictEqual(
        readRouteVerdict({ prompt, session_id: mine }, prompt, null),
        null,
        "session A must not read session B's verdict",
      );
      const v = readRouteVerdict({ prompt, session_id: theirs }, prompt, null);
      assert.strictEqual(v.task_class, "from_state", "the owning session still reads it");
    });
  } finally {
    cleanup(sfp);
  }
});

test("a state whose payload names a different session is rejected", () => {
  const sid = `rs-payload-${process.pid}`;
  const prompt = `rs-payload-prompt-${process.pid}`;
  // Filename says sid, payload says someone else — copied or restored file.
  const sfp = writeState(sid, prompt, { session_id: "some-other-session" });
  try {
    withEnv({}, () => {
      assert.strictEqual(readRouteVerdict({ prompt, session_id: sid }, prompt, null), null);
    });
  } finally {
    cleanup(sfp);
  }
});

test("a verdict for a different prompt is rejected", () => {
  const sid = `rs-prompt-${process.pid}`;
  const prompt = `rs-prompt-current-${process.pid}`;
  const sfp = writeState(sid, prompt, {
    prompt_hash: crypto.createHash("sha1").update("some other prompt").digest("hex"),
  });
  try {
    withEnv({}, () => {
      assert.strictEqual(readRouteVerdict({ prompt, session_id: sid }, prompt, null), null);
    });
  } finally {
    cleanup(sfp);
  }
});

test("a stale state is ignored", () => {
  const sid = `rs-stale-${process.pid}`;
  const prompt = `rs-stale-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt, {
    written_at: new Date(Date.now() - (routeState.STATE_TTL_SECS + 60) * 1000).toISOString(),
  });
  try {
    withEnv({}, () => {
      assert.strictEqual(readRouteVerdict({ prompt, session_id: sid }, prompt, null), null);
    });
  } finally {
    cleanup(sfp);
  }
});

test("a far-future timestamp is ignored (clock skew is not a verdict)", () => {
  const sid = `rs-future-${process.pid}`;
  const prompt = `rs-future-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt, {
    written_at: new Date(Date.now() + (routeState.STATE_TTL_SECS + 600) * 1000).toISOString(),
  });
  try {
    withEnv({}, () => {
      assert.strictEqual(readRouteVerdict({ prompt, session_id: sid }, prompt, null), null);
    });
  } finally {
    cleanup(sfp);
  }
});

test("a foreign schema version is ignored", () => {
  const sid = `rs-schema-${process.pid}`;
  const prompt = `rs-schema-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt, { schema_version: SCHEMA + 1 });
  try {
    withEnv({}, () => {
      assert.strictEqual(readRouteVerdict({ prompt, session_id: sid }, prompt, null), null);
    });
  } finally {
    cleanup(sfp);
  }
});

test("corrupt state fails open — no throw, cache still answers", () => {
  const sid = `rs-corrupt-${process.pid}`;
  const prompt = `rs-corrupt-prompt-${process.pid}`;
  const sfp = routeState.routeStatePath(sid);
  const cfp = writeCache(prompt);
  try {
    for (const body of ["{{{not json", "", "null", "[]"]) {
      fs.writeFileSync(sfp, body);
      withEnv({}, () => {
        const v = readRouteVerdict({ prompt, session_id: sid }, prompt, null);
        assert.strictEqual(v && v.task_class, "from_cache", `corrupt body ${JSON.stringify(body)}`);
      });
    }
  } finally {
    cleanup(sfp, cfp);
  }
});

test("a disabled classification yields no verdict", () => {
  const sid = `rs-disabled-${process.pid}`;
  const prompt = `rs-disabled-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt, {
    classification: { disabled: true, scope: "main", why: "TKR_ROUTE_DISABLED" },
  });
  try {
    withEnv({}, () => {
      assert.strictEqual(readRouteVerdict({ prompt, session_id: sid }, prompt, null), null);
    });
  } finally {
    cleanup(sfp);
  }
});

// ── Active-model validation ─────────────────────────────────────────────────

test("a verdict written under a different model family is rejected", () => {
  const sid = `rs-model-${process.pid}`;
  const prompt = `rs-model-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt); // written under claude-opus-5
  try {
    withEnv({}, () => {
      // Session has since switched to Sonnet — the Opus verdict is wrong
      // even though session and prompt still match.
      assert.strictEqual(
        readRouteVerdict({ prompt, session_id: sid }, prompt, { model_id: "claude-sonnet-5" }),
        null,
      );
      // Same family (dated id) still matches.
      const v = readRouteVerdict({ prompt, session_id: sid }, prompt, {
        model_id: "claude-opus-5-20260724",
      });
      assert.strictEqual(v && v.task_class, "from_state");
    });
  } finally {
    cleanup(sfp);
  }
});

test("an unobservable model does not suppress the verdict", () => {
  const sid = `rs-nomodel-${process.pid}`;
  const prompt = `rs-nomodel-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt);
  try {
    withEnv({}, () => {
      for (const tel of [null, {}, { model_id: "" }, { model_id: "some-other-backend" }]) {
        const v = readRouteVerdict({ prompt, session_id: sid }, prompt, tel);
        assert.strictEqual(v && v.task_class, "from_state", `tel=${JSON.stringify(tel)}`);
      }
    });
  } finally {
    cleanup(sfp);
  }
});

test("activeModelHint prefers the payload, falls back to CLAUDE_MODEL", () => {
  withEnv({ CLAUDE_MODEL: "Opus 4.8" }, () => {
    assert.strictEqual(activeModelHint({ model_id: "claude-sonnet-5" }), "claude-sonnet-5");
    assert.strictEqual(activeModelHint(null), "Opus 4.8");
    assert.strictEqual(activeModelHint({}), "Opus 4.8");
  });
  withEnv({}, () => assert.strictEqual(activeModelHint(null), ""));
});

// MODEL-LAG-001. model_id is the transcript's last ASSISTANT turn, so at
// UserPromptSubmit for turn N it names turn N-1's model. model_display is
// what CC handed the statusline, which re-renders on `/model`. When they
// disagree — exactly the mid-session switch — the live one wins, or this
// function rejects a verdict that is correct for the current turn.
test("activeModelHint prefers the live model over the lagging one", () => {
  withEnv({ CLAUDE_MODEL: "Opus 4.8" }, () => {
    assert.strictEqual(
      activeModelHint({ model_id: "claude-opus-5-20260724", model_display: "Haiku 4.5" }),
      "Haiku 4.5",
    );
    // Hosts with no statusline, and payloads written before this shipped,
    // carry no model_display — they must keep resolving.
    assert.strictEqual(activeModelHint({ model_id: "claude-sonnet-5" }), "claude-sonnet-5");
    // Present-but-empty must not shadow a real model_id.
    for (const empty of ["", "   "]) {
      assert.strictEqual(
        activeModelHint({ model_id: "claude-sonnet-5", model_display: empty }),
        "claude-sonnet-5",
      );
    }
    // Non-string is not a signal either.
    assert.strictEqual(
      activeModelHint({ model_id: "claude-sonnet-5", model_display: 5 }),
      "claude-sonnet-5",
    );
    // model_display alone still resolves.
    assert.strictEqual(activeModelHint({ model_display: "Haiku 4.5" }), "Haiku 4.5");
  });
});

// The lag has real consequences one layer up: the verdict-vs-model check
// is what suppresses a stale verdict, so feeding it the PREVIOUS turn's
// model made it reject verdicts written for the current one.
test("a verdict matching the live model survives a stale model_id", () => {
  const sid = `rs-live-${process.pid}`;
  const prompt = `rs-live-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt); // written under claude-opus-5
  try {
    withEnv({}, () => {
      // Statusline says the session is on opus NOW; the transcript's last
      // assistant turn was sonnet (the model just switched away from).
      const v = readRouteVerdict({ prompt, session_id: sid }, prompt, {
        model_id: "claude-sonnet-5",
        model_display: "Opus 5",
      });
      assert.strictEqual(v && v.task_class, "from_state");
    });
  } finally {
    cleanup(sfp);
  }
});

test("sameModel is version-exact, not family-exact", () => {
  const { sameModel } = routeState;
  // Same capability key across every spelling the sources produce.
  assert.ok(sameModel("claude-opus-5", "claude-opus-5"));
  assert.ok(sameModel("claude-opus-5", "claude-opus-5-20260724"), "dated id");
  assert.ok(sameModel("claude-opus-5", "Opus 5"), "display name");
  assert.ok(sameModel("claude-sonnet-5", "Claude Sonnet 5 (1M context)"), "decorated");
  // Different VERSION of the same family must be rejected: the capability
  // matrix distinguishes them (sonnet-4-6 has no xhigh band), so a verdict
  // computed against one ladder must not be served against the other.
  assert.ok(!sameModel("claude-sonnet-5", "claude-sonnet-4-6"));
  assert.ok(!sameModel("claude-sonnet-5", "Sonnet 4.6"));
  assert.ok(!sameModel("claude-opus-5", "claude-opus-4-8-20250601"));
  // Different family, obviously.
  assert.ok(!sameModel("claude-opus-5", "claude-sonnet-5"));
  // No signal on either side → accept; absence is not evidence of mismatch.
  assert.ok(sameModel("", "claude-sonnet-5"), "unknown side accepts");
  assert.ok(sameModel("claude-sonnet-5", "gpt-6"), "unrecognized backend accepts");
});

test("normalizeModelKey resolves ids and display names, else empty", () => {
  const { normalizeModelKey } = routeState;
  assert.strictEqual(normalizeModelKey("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.strictEqual(normalizeModelKey("claude-opus-5-20260724"), "claude-opus-5");
  assert.strictEqual(normalizeModelKey("Sonnet 4.6"), "claude-sonnet-4-6");
  assert.strictEqual(normalizeModelKey("Claude Haiku 4.5"), "claude-haiku-4-5");
  assert.strictEqual(normalizeModelKey("gpt-6"), "");
  assert.strictEqual(normalizeModelKey(""), "");
});

// ── Cross-session bleed through the legacy cache (PR review finding 1) ──────
//
// The shared prompt-hash cache is keyed on prompt text ALONE, so session
// A's entry is readable by session B. An earlier revision consulted it on
// every state miss, which re-created the exact defect this channel exists
// to remove: B found A's verdict, treated the prompt as classified, and
// never ran its own classifier.
//
// Neither original test caught it — one wrote another session's STATE with
// no cache, the other wrote a cache with no other-session state. The bug
// only appears when BOTH are present, which is the normal steady state.

test("session B refuses session A's cache entry when both state and cache exist", () => {
  const sidA = `rs-bleed-a-${process.pid}`;
  const sidB = `rs-bleed-b-${process.pid}`;
  const prompt = `rs-bleed-shared-prompt-${process.pid}`;
  // Session A classified: it has BOTH its own state AND the shared cache
  // entry, exactly as a real classify leaves things.
  const sfpA = writeState(sidA, prompt);
  const cfp = writeCache(prompt, { state_schema: SCHEMA });
  try {
    withEnv({}, () => {
      assert.strictEqual(
        readRouteVerdict({ prompt, session_id: sidB }, prompt, null),
        null,
        "session B must not inherit session A's verdict via the shared cache",
      );
      // A still reads its own.
      const v = readRouteVerdict({ prompt, session_id: sidA }, prompt, null);
      assert.strictEqual(v && v.task_class, "from_state");
    });
  } finally {
    cleanup(sfpA, cfp);
  }
});

test("routeInjectContext refuses a marked cross-session cache instead of injecting it", () => {
  const sidA = `rs-inject-a-${process.pid}`;
  const sidB = `rs-inject-b-${process.pid}`;
  const prompt = `rs-inject-shared-${process.pid}`;
  const sfpA = writeState(sidA, prompt);
  const cfp = writeCache(prompt, { state_schema: SCHEMA });
  const efpB = writeEffortFile(sidB, "low"); // would make A's high verdict inject
  try {
    withEnv({ TKR_ROUTE_INJECT_MODE: "always" }, () => {
      // `tkr` is not on PATH in the test env, so the synchronous classify
      // produces nothing. The only other candidate is A's cache entry —
      // which must be refused, leaving silence rather than A's verdict.
      for (let i = 0; i < ROUTE_STREAK_MIN + 1; i++) {
        assert.strictEqual(
          routeInjectContext({ prompt, session_id: sidB }, null),
          "",
          "a state-capable writer's cache entry must never serve another session",
        );
      }
    });
  } finally {
    cleanup(sfpA, cfp, efpB, routeNudgeStatePath(sidB));
  }
});

test("legacyCacheIsUsable honors pre-migration entries, refuses marked ones", () => {
  const { legacyCacheIsUsable } = routeState;
  assert.ok(legacyCacheIsUsable({ task_class: "x" }), "no marker → old binary → honor");
  assert.ok(!legacyCacheIsUsable({ task_class: "x", state_schema: SCHEMA }));
  assert.ok(!legacyCacheIsUsable({ task_class: "x", state_schema: 99 }));
  assert.ok(!legacyCacheIsUsable(null));
});


// ── Existing injection behavior, now sourced from state ─────────────────────

test("sustained under-effort mismatch still injects once, via state", () => {
  const sid = `rs-sustained-${process.pid}`;
  const prompt = `rs-sustained-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt);
  const efp = writeEffortFile(sid, "low"); // active low vs verdict high
  try {
    withEnv({}, () => {
      const outs = [];
      for (let i = 0; i < ROUTE_STREAK_MIN + 1; i++) {
        outs.push(routeInjectContext({ prompt, session_id: sid }, null));
      }
      for (let i = 0; i < ROUTE_STREAK_MIN - 1; i++) {
        assert.strictEqual(outs[i], "", `turn ${i + 1} must stay silent`);
      }
      assert.match(outs[ROUTE_STREAK_MIN - 1], /sustained/);
      assert.match(outs[ROUTE_STREAK_MIN - 1], /from_state/, "verdict must come from state");
      assert.strictEqual(outs[ROUTE_STREAK_MIN], "", "post-injection turn must dedup");
    });
  } finally {
    cleanup(sfp, efp, routeNudgeStatePath(sid));
  }
});

test("shape over-effort nudge reads the state recommendation", () => {
  const sid = `rs-shape-${process.pid}`;
  const prompt = `rs-shape-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt, {
    shape: {
      shape: "narrow_reversible",
      high_stakes: false,
      recommendation: { effort: "low" },
    },
  });
  const efp = writeEffortFile(sid, "max");
  try {
    withEnv({}, () => {
      const outs = [];
      for (let i = 0; i < ROUTE_STREAK_MIN; i++) {
        outs.push(shapeNudgeContext({ prompt, session_id: sid }, null));
      }
      assert.match(outs[ROUTE_STREAK_MIN - 1], /shape=narrow_reversible/);
      assert.match(outs[ROUTE_STREAK_MIN - 1], /recommend=low active=max/);
    });
  } finally {
    cleanup(sfp, efp, routeNudgeStatePath(sid));
  }
});

// Behavior CHANGED by #143 finding 3: this asserted "" on every turn,
// on the reasoning that a model mismatch is not an effort nudge. True,
// and the conclusion was silence rather than the right nudge — so a
// session running below the shape's threshold heard nothing here while
// the route channel told it to raise effort instead. The escalation now
// fires, under the same sustained-mismatch discipline as the other
// shape nudges.
test("escalate_model in state fires a model nudge once sustained", () => {
  const sid = `rs-escalate-${process.pid}`;
  const prompt = `rs-escalate-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt, {
    shape: {
      shape: "bounded_judgment",
      high_stakes: true,
      recommendation: { escalate_model: "claude-sonnet-5" },
    },
  });
  const efp = writeEffortFile(sid, "max");
  try {
    withEnv({}, () => {
      let fired = "";
      for (let i = 0; i < ROUTE_STREAK_MIN + 1; i++) {
        const got = shapeNudgeContext({ prompt, session_id: sid }, null);
        if (got) fired = got;
      }
      assert.match(fired, /claude-sonnet-5 recommended/,
        "a sustained escalation must reach the model, not be dropped");
      assert.match(fired, /high-stakes/,
        "the stakes marker belongs on the escalation too");
    });
  } finally {
    cleanup(sfp, efp, routeNudgeStatePath(sid));
  }
});

test("subagent dispatch and the kill switch skip the state read entirely", () => {
  const sid = `rs-skip-${process.pid}`;
  const prompt = `rs-skip-prompt-${process.pid}`;
  const sfp = writeState(sid, prompt);
  const efp = writeEffortFile(sid, "low");
  try {
    withEnv({}, () => {
      assert.strictEqual(
        routeInjectContext({ prompt, session_id: sid, subagent_type: "Explore" }, null),
        "",
      );
      assert.strictEqual(routeInjectContext({ prompt, session_id: sid, scope: "subagent" }, null), "");
    });
    withEnv({ TKR_ROUTE_DISABLED: "1" }, () => {
      assert.strictEqual(routeInjectContext({ prompt, session_id: sid }, null), "");
      assert.strictEqual(shapeNudgeContext({ prompt, session_id: sid }, null), "");
    });
  } finally {
    cleanup(sfp, efp, routeNudgeStatePath(sid));
  }
});

test("a sessionless read never resolves a state path", () => {
  assert.strictEqual(routeState.routeStatePath(""), "");
  assert.strictEqual(routeState.readRouteState("", {}), null);
});

process.on("exit", () => {
  try {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});
