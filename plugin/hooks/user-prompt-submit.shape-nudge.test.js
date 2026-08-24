#!/usr/bin/env node
// Tests for shapeNudgeContext — matrix-aware effort-over-recommendation
// nudge in hooks/user-prompt-submit.js.
//
// Run: node hooks/user-prompt-submit.shape-nudge.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  shapeNudgeContext,
  effortRank,
  detectActiveEffort,
} = require("./user-prompt-submit.js");

// These plumbing tests assert immediate firing under the pre-addendum
// per-turn contract; pin mode=always. Sustained-mismatch policy is
// covered in user-prompt-submit.route-policy.test.js.
process.env.TKR_ROUTE_INJECT_MODE = "always";

// Pin the classifier off by default: these tests seed a verdict and assert
// on what the hook does WITH it. routeInjectContext classifies once per
// prompt by design, so without this a real `tkr` on PATH — the normal state
// for anyone developing this repo — overwrites each seeded entry with a real
// verdict and the assertions fail for unrelated reasons. The one test that
// genuinely exercises synchronous classify re-enables it with its own stub
// binary on PATH.
process.env.TKR_ROUTE_SYNC = "0";

// Write a cache file at the location the hook will look — keyed by SHA1 of prompt.
function writeCache(prompt, entry) {
  const sha1 = crypto.createHash("sha1").update(prompt).digest("hex");
  const fp = path.join(os.tmpdir(), "tkr-route-" + sha1 + ".json");
  fs.writeFileSync(fp, JSON.stringify({
    written_at: new Date().toISOString(),
    ...entry,
  }));
  return fp;
}

function cleanup(fp) {
  try { fs.unlinkSync(fp); } catch {}
}

// Run a test body with effort env vars set, then restore. Clears BOTH
// supported env keys so an ambient parent-shell value doesn't leak in.
function withEffort(active, fn) {
  const prev1 = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const prev2 = process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_EFFORT;
  if (active === undefined) {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  } else {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = active;
  }
  try { fn(); } finally {
    if (prev1 === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = prev1;
    if (prev2 === undefined) delete process.env.CLAUDE_EFFORT;
    else process.env.CLAUDE_EFFORT = prev2;
  }
}

test("effortRank orders correctly", () => {
  assert.ok(effortRank("none") < effortRank("low"));
  assert.ok(effortRank("low") < effortRank("medium"));
  assert.ok(effortRank("medium") < effortRank("high"));
  assert.ok(effortRank("high") < effortRank("xhigh"));
  assert.ok(effortRank("xhigh") < effortRank("max"));
  assert.strictEqual(effortRank("bogus"), -1);
  assert.strictEqual(effortRank(""), -1);
});

test("detectActiveEffort reads CLAUDE_CODE_EFFORT_LEVEL", () => {
  withEffort("HIGH", () => {
    assert.strictEqual(detectActiveEffort(), "high");
  });
});

test("returns empty when no prompt", () => {
  withEffort("max", () => {
    assert.strictEqual(shapeNudgeContext({}), "");
    assert.strictEqual(shapeNudgeContext({ prompt: "" }), "");
    assert.strictEqual(shapeNudgeContext({ prompt: "   " }), "");
  });
});

test("returns empty for subagent scope", () => {
  withEffort("max", () => {
    assert.strictEqual(
      shapeNudgeContext({ prompt: "hi", subagent_type: "Explore" }),
      ""
    );
    assert.strictEqual(
      shapeNudgeContext({ prompt: "hi", scope: "subagent" }),
      ""
    );
  });
});

// INV-074 residue: this skip previously hand-rolled only the two
// undocumented mirrors (subagent_type/scope) and never gated on the
// documented agent_id/agent_type markers. Now routed through
// lib/subagent-context.js's isSubagentContext.
test("returns empty for agent_id/agent_type, fires for neither marker (INV-074)", () => {
  const prompt = "test-agenttype-gate";
  const fp = writeCache(prompt, {
    shape: "frontier",
    recommend_effort: "",
    escalate_model: "claude-sonnet-5",
  });
  try {
    withEffort("", () => {
      assert.strictEqual(shapeNudgeContext({ prompt, agent_id: "a1" }), "");
      assert.strictEqual(shapeNudgeContext({ prompt, agent_type: "Explore" }), "");
      // Neither marker present → not a subagent context → nudge fires normally.
      assert.match(shapeNudgeContext({ prompt }), /claude-sonnet-5 recommended/);
    });
  } finally { cleanup(fp); }
});

test("returns empty when TKR_ROUTE_DISABLED=1", () => {
  const prev = process.env.TKR_ROUTE_DISABLED;
  process.env.TKR_ROUTE_DISABLED = "1";
  try {
    withEffort("max", () => {
      assert.strictEqual(shapeNudgeContext({ prompt: "hi" }), "");
    });
  } finally {
    if (prev === undefined) delete process.env.TKR_ROUTE_DISABLED;
    else process.env.TKR_ROUTE_DISABLED = prev;
  }
});

test("returns empty when active effort env missing", () => {
  const prompt = "test-no-active";
  const fp = writeCache(prompt, {
    shape: "narrow_reversible",
    recommend_effort: "low",
  });
  try {
    withEffort(undefined, () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
  } finally { cleanup(fp); }
});

test("returns empty on cache miss", () => {
  withEffort("max", () => {
    // No file written for this prompt.
    assert.strictEqual(shapeNudgeContext({ prompt: "uncached-" + Date.now() }), "");
  });
});

test("returns empty when cache expired", () => {
  const prompt = "test-expired";
  const sha1 = crypto.createHash("sha1").update(prompt).digest("hex");
  const fp = path.join(os.tmpdir(), "tkr-route-" + sha1 + ".json");
  // written_at 10 minutes ago — well past TTL (60s).
  fs.writeFileSync(fp, JSON.stringify({
    written_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    shape: "narrow_reversible",
    recommend_effort: "low",
  }));
  try {
    withEffort("max", () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
  } finally { cleanup(fp); }
});

test("returns empty on legacy entry (no shape field)", () => {
  const prompt = "test-legacy";
  const fp = writeCache(prompt, {
    // Older CLI build — no shape / recommend_effort.
    task_class: "localized_edit",
    effort: "medium",
  });
  try {
    withEffort("max", () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
  } finally { cleanup(fp); }
});

test("returns empty when active <= recommended", () => {
  const prompt = "test-at-recommended";
  const fp = writeCache(prompt, {
    shape: "multi_facet_design",
    recommend_effort: "high",
  });
  try {
    withEffort("high", () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
    withEffort("medium", () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
  } finally { cleanup(fp); }
});

// Behavior CHANGED by #143 finding 3. This used to assert "" — the
// escalation was deferred to a nudge that was never built, so the one
// verdict the matrix is most confident about reached no channel at all,
// while routeInjectContext separately told the underpowered session to
// raise its effort to a level its tier does not accept. The escalation
// now lands here, and the effort line stays silent instead.
test("escalate_model emits a model nudge, not silence", () => {
  const prompt = "test-escalate";
  const fp = writeCache(prompt, {
    shape: "frontier",
    recommend_effort: "",
    escalate_model: "claude-opus-4-7",
  });
  try {
    withEffort("max", () => {
      const got = shapeNudgeContext({ prompt });
      assert.match(got, /shape=frontier/);
      assert.match(got, /claude-opus-4-7 recommended/);
      assert.match(got, /below the threshold/,
        "the nudge must say the MODEL is the problem, not the effort");
    });
  } finally { cleanup(fp); }
});

// An escalation carries no recommend_effort by construction, so nothing
// downstream may try to rank it against the active effort.
test("escalate_model fires even when the active model reports no effort", () => {
  const prompt = "test-escalate-no-effort";
  const fp = writeCache(prompt, {
    shape: "frontier",
    recommend_effort: "",
    escalate_model: "claude-sonnet-5",
  });
  try {
    withEffort("", () => {
      assert.match(shapeNudgeContext({ prompt }), /claude-sonnet-5 recommended/,
        "Haiku accepts no effort parameter; the escalation must not need one");
    });
  } finally { cleanup(fp); }
});

test("injects when active > recommended", () => {
  const prompt = "test-over-effort";
  const fp = writeCache(prompt, {
    shape: "narrow_reversible",
    recommend_effort: "low",
  });
  try {
    withEffort("max", () => {
      const out = shapeNudgeContext({ prompt });
      assert.match(out, /\[tkr:/);
      assert.match(out, /shape=narrow_reversible/);
      assert.match(out, /recommend=low/);
      assert.match(out, /active=max/);
      assert.match(out, /consider lowering/);
    });
  } finally { cleanup(fp); }
});

test("injects high-stakes marker when flag set", () => {
  const prompt = "test-high-stakes";
  const fp = writeCache(prompt, {
    shape: "bounded_judgment",
    recommend_effort: "medium",
    high_stakes: true,
  });
  try {
    withEffort("max", () => {
      const out = shapeNudgeContext({ prompt });
      assert.match(out, /high-stakes/);
      assert.match(out, /recommend=medium/);
    });
  } finally { cleanup(fp); }
});

test("returns empty for unknown effort strings (no guessing)", () => {
  const prompt = "test-bogus-effort";
  const fp = writeCache(prompt, {
    shape: "routine_scoped",
    recommend_effort: "extreme", // not in EFFORT_ORDER
  });
  try {
    withEffort("max", () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
    // Also when active is bogus.
    writeCache(prompt, {
      shape: "routine_scoped",
      recommend_effort: "low",
    });
    withEffort("turbo", () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
  } finally { cleanup(fp); }
});

test("injects downgrade nudge when effort fine but downgrade_model set", () => {
  const prompt = "test-downgrade-effort-fine";
  const fp = writeCache(prompt, {
    shape: "narrow_reversible",
    recommend_effort: "low",
    downgrade_model: "claude-sonnet-5",
  });
  try {
    withEffort("low", () => {
      const out = shapeNudgeContext({ prompt });
      assert.match(out, /\[tkr:/);
      assert.match(out, /shape=narrow_reversible/);
      assert.match(out, /claude-sonnet-5/);
      assert.match(out, /natural break/);
    });
  } finally { cleanup(fp); }
});

test("over-effort nudge appends downgrade hint when downgrade_model set", () => {
  const prompt = "test-downgrade-over-effort";
  const fp = writeCache(prompt, {
    shape: "routine_scoped",
    recommend_effort: "low",
    downgrade_model: "claude-sonnet-5",
  });
  try {
    withEffort("high", () => {
      const out = shapeNudgeContext({ prompt });
      assert.match(out, /consider lowering/);
      assert.match(out, /claude-sonnet-5 also equivalent/);
    });
  } finally { cleanup(fp); }
});

test("no downgrade nudge when downgrade_model absent and effort fine", () => {
  const prompt = "test-no-downgrade";
  const fp = writeCache(prompt, {
    shape: "narrow_reversible",
    recommend_effort: "low",
  });
  try {
    withEffort("low", () => {
      assert.strictEqual(shapeNudgeContext({ prompt }), "");
    });
  } finally { cleanup(fp); }
});

// ── ADR-0010 addendum: effort file fallback + sync classify ──────────

const {
  effortStatePath,
  routeInjectContext,
} = require("./user-prompt-submit.js");

// Write the per-session effort state file at the path the hook resolves.
function writeEffortFile(sid, effort) {
  const fp = effortStatePath(sid);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ effort, ts: new Date().toISOString() }));
  return fp;
}

test("detectActiveEffort falls back to effort-<sid>.json when env absent", () => {
  const sid = `test-effort-fallback-${process.pid}`;
  const fp = writeEffortFile(sid, "High");
  try {
    withEffort(undefined, () => {
      assert.strictEqual(detectActiveEffort({ session_id: sid }), "high");
    });
  } finally { cleanup(fp); }
});

test("effort env var beats the state file", () => {
  const sid = `test-effort-env-wins-${process.pid}`;
  const fp = writeEffortFile(sid, "max");
  try {
    withEffort("low", () => {
      assert.strictEqual(detectActiveEffort({ session_id: sid }), "low");
    });
  } finally { cleanup(fp); }
});

test("detectActiveEffort empty on corrupt state file", () => {
  const sid = `test-effort-corrupt-${process.pid}`;
  const fp = effortStatePath(sid);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, "not-json{");
  try {
    withEffort(undefined, () => {
      assert.strictEqual(detectActiveEffort({ session_id: sid }), "");
    });
  } finally { cleanup(fp); }
});

test("shapeNudge fires from file-fallback effort when env vars absent", () => {
  const sid = `test-nudge-file-effort-${process.pid}`;
  const prompt = "test-file-fallback-nudge";
  const efp = writeEffortFile(sid, "max");
  const cfp = writeCache(prompt, {
    shape: "narrow_reversible",
    recommend_effort: "low",
  });
  try {
    withEffort(undefined, () => {
      const out = shapeNudgeContext({ prompt, session_id: sid });
      assert.match(out, /recommend=low active=max/);
    });
  } finally { cleanup(efp); cleanup(cfp); }
});

test("routeInjectContext classifies synchronously on cache miss", { skip: process.platform === "win32" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-route-sync-"));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir);
  // Stub `tkr` writes a valid cache entry for the classify prompt
  // (argv: route classify <prompt> --json) into TKR_ROUTE_CACHE_DIR,
  // mirroring the real binary's write-cache-then-exit contract.
  fs.writeFileSync(path.join(binDir, "tkr"), `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const prompt = process.argv[4];
const sha1 = crypto.createHash("sha1").update(prompt).digest("hex");
fs.writeFileSync(
  path.join(process.env.TKR_ROUTE_CACHE_DIR, "tkr-route-" + sha1 + ".json"),
  JSON.stringify({ written_at: new Date().toISOString(), task_class: "localized_edit", effort: "low", why: "stub" })
);
`, { mode: 0o755 });
  const prevPath = process.env.PATH;
  const prevBin = process.env.TKR_BIN;
  const prevCacheDir = process.env.TKR_ROUTE_CACHE_DIR;
  const prevSync = process.env.TKR_ROUTE_SYNC;
  process.env.PATH = binDir + path.delimiter + prevPath;
  // hooks/lib/tkr-bin.js's resolveTkrBin checks TKR_BIN, THEN the standard
  // install location ($HOME/.local/bin/tkr), and only falls back to a PATH
  // search last. A PATH prepend alone is not enough to guarantee this stub
  // wins: on any runner with a real tkr already at the standard location
  // (true of the self-hosted CI runner — persistent HOME across jobs), that
  // real binary resolves first, classifies for real, and never produces the
  // "(stub)" cache entry this test asserts on. Pin TKR_BIN directly, same
  // pattern as hooks/lib/sessionstart/resident-warm.test.js.
  process.env.TKR_BIN = path.join(binDir, "tkr");
  process.env.TKR_ROUTE_CACHE_DIR = tmp;
  // This is the one test that WANTS the synchronous classify — the stub
  // above is what gets classified — so lift the file-level pin.
  delete process.env.TKR_ROUTE_SYNC;
  try {
    const out = routeInjectContext({ prompt: "sync-classify-" + process.pid });
    assert.match(out, /\[tkr route: localized_edit → effort=low \(stub\)\]/);
  } finally {
    process.env.PATH = prevPath;
    if (prevBin === undefined) delete process.env.TKR_BIN;
    else process.env.TKR_BIN = prevBin;
    if (prevCacheDir === undefined) delete process.env.TKR_ROUTE_CACHE_DIR;
    else process.env.TKR_ROUTE_CACHE_DIR = prevCacheDir;
    if (prevSync === undefined) delete process.env.TKR_ROUTE_SYNC;
    else process.env.TKR_ROUTE_SYNC = prevSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("routeInjectContext TKR_ROUTE_SYNC=0 restores fire-and-forget miss", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-route-nosync-"));
  const prevSync = process.env.TKR_ROUTE_SYNC;
  const prevCacheDir = process.env.TKR_ROUTE_CACHE_DIR;
  process.env.TKR_ROUTE_SYNC = "0";
  process.env.TKR_ROUTE_CACHE_DIR = tmp;
  try {
    assert.strictEqual(routeInjectContext({ prompt: "nosync-" + process.pid }), "");
  } finally {
    if (prevSync === undefined) delete process.env.TKR_ROUTE_SYNC;
    else process.env.TKR_ROUTE_SYNC = prevSync;
    if (prevCacheDir === undefined) delete process.env.TKR_ROUTE_CACHE_DIR;
    else process.env.TKR_ROUTE_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── The reported symptom (#143 finding 3) ───────────────────────────────
//
// Verbatim from the issue: a Haiku session classified for security-review
// work produced `{"active_model":"claude-haiku-4-5","recommended_model":
// "claude-opus-5","effort":"xhigh"}`. That `xhigh` is the figure for the
// RECOMMENDED model — Haiku accepts no effort parameter at all — yet the
// route channel injected it as advice to the running session, and the
// escalation that was the actual answer was suppressed. One verdict now
// goes out, and it names the model.
test("an underpowered session is told to switch models, not to raise effort", () => {
  const prompt = "test-143-finding-3";
  const fp = writeCache(prompt, {
    task_class: "ambiguous_debug",
    effort: "xhigh",
    active_model: "claude-haiku-4-5",
    recommended_model: "claude-opus-5",
    shape: "bounded_judgment",
    recommend_effort: "",
    escalate_model: "claude-opus-5",
  });
  try {
    withEffort("low", () => {
      assert.strictEqual(
        routeInjectContext({ prompt }),
        "",
        "the effort channel must stay silent when the answer is a different model",
      );
      const shapeOut = shapeNudgeContext({ prompt });
      assert.match(shapeOut, /claude-opus-5 recommended/);
      assert.doesNotMatch(shapeOut, /xhigh/,
        "an effort level the active tier cannot accept must never be recommended to it");
    });
  } finally { cleanup(fp); }
});
