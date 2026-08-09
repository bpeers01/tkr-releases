// INV-095 — bundled-skill payload gate.
//
// The pure `gate()` cases are the policy contract; the I/O cases pin the
// bundle-discovery and caching behaviour that feeds it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sb = require("./skill-bundle");

const BIG = 200_000;
const SMALL = 1_000;

// --- pure: gate() -----------------------------------------------------

test("gate: default mode is ask — the user gets a decision point, not a notice", () => {
  const v = sb.gate({ env: {}, source: "auto", bundleTokens: BIG });
  assert.equal(v.mode, "ask");
  assert.equal(v.action, "ask");
});

test("gate: TKR_SKILL_GATE=deny escalates to a block", () => {
  const v = sb.gate({ env: { TKR_SKILL_GATE: "deny" }, source: "auto", bundleTokens: BIG });
  assert.equal(v.action, "deny");
});

test("gate: TKR_SKILL_GATE=warn de-escalates to notify-only", () => {
  const v = sb.gate({ env: { TKR_SKILL_GATE: "warn" }, source: "auto", bundleTokens: BIG });
  assert.equal(v.action, "warn");
});

test("gate: every kill switch yields action none", () => {
  for (const env of [
    { TKR_HOOKS_DISABLED: "1" },
    { TKR_SKILL_GATE_DISABLED: "1" },
    { TKR_SKILL_GATE: "off" },
    // A deny-mode install must still honour the master switch.
    { TKR_SKILL_GATE: "deny", TKR_HOOKS_DISABLED: "1" },
    // And so must the default, which now acts without being asked to.
    { TKR_SKILL_GATE_DISABLED: "1", TKR_SKILL_GATE: "ask" },
  ]) {
    const v = sb.gate({ env, source: "auto", bundleTokens: BIG });
    assert.equal(v.action, "none", JSON.stringify(env));
  }
});

test("gate: a manual /skill invocation is never gated", () => {
  for (const mode of ["warn", "ask", "deny"]) {
    const v = sb.gate({ env: { TKR_SKILL_GATE: mode }, source: "manual", bundleTokens: BIG });
    assert.equal(v.action, "none", mode);
  }
});

test("gate: below threshold is silent", () => {
  const v = sb.gate({ env: {}, source: "auto", bundleTokens: SMALL });
  assert.equal(v.action, "none");
});

test("gate: threshold is configurable and respected in both directions", () => {
  const env = { TKR_SKILL_GATE_THRESHOLD: "500" };
  assert.equal(sb.gate({ env, source: "auto", bundleTokens: SMALL }).action, "ask");
  assert.equal(sb.gate({ env, source: "auto", bundleTokens: 100 }).action, "none");
});

test("gate: a garbage threshold falls back to the default rather than gating everything", () => {
  const env = { TKR_SKILL_GATE_THRESHOLD: "not-a-number" };
  assert.equal(sb.thresholdTokens(env), sb.DEFAULT_THRESHOLD_TOKENS);
  assert.equal(sb.gate({ env, source: "auto", bundleTokens: SMALL }).action, "none");
});

test("gate: no measurable bundle means no opinion", () => {
  for (const bundleTokens of [null, undefined, 0, -1, "big"]) {
    assert.equal(sb.gate({ env: {}, source: "auto", bundleTokens }).action, "none");
  }
});

// Absent and malformed are different questions with different answers:
// nothing set means "use the measured default"; a typo means "somebody
// meant something and we cannot tell what", which must not block a call
// and must not interrupt one either.
test("gate: an unrecognised mode string degrades to warn — below the default, nowhere near deny", () => {
  for (const raw of ["block", "yes", "dney", "1"]) {
    assert.equal(sb.gateMode({ TKR_SKILL_GATE: raw }), "warn", raw);
  }
  assert.equal(sb.gate({ env: { TKR_SKILL_GATE: "dney" }, source: "auto", bundleTokens: BIG }).action, "warn");
});

test("gate: an absent or blank setting means the default, not a degraded mode", () => {
  assert.equal(sb.gateMode({}), sb.DEFAULT_MODE);
  assert.equal(sb.gateMode({ TKR_SKILL_GATE: "" }), sb.DEFAULT_MODE);
  assert.equal(sb.gateMode({ TKR_SKILL_GATE: "  " }), sb.DEFAULT_MODE);
  assert.equal(sb.gateMode({ TKR_SKILL_GATE: " ASK " }), "ask");
});

// --- pure: cost reporting --------------------------------------------

// The gate's own number was wrong twice over: it measured the tree
// rather than the payload (overstates ~24%) and estimated at bytes/4
// rather than the ~2.75 chars/token this content actually tokenizes at
// (understates ~45%). Those do not cancel. A range is the only honest
// output until the estimator is investigated on more than one sample.
test("costRange brackets the one payload measured against API ground truth", () => {
  const r = sb.costRange(216_944); // claude-api tree, bytes/4
  assert.equal(r.lo, 216_944);
  assert.ok(r.hi > r.lo, "high bound must exceed bytes/4");
  // Ground truth for that injection was ~253,800 tokens.
  assert.ok(r.lo < 253_800 && r.hi > 253_800, `range ${r.lo}-${r.hi} must contain 253,800`);
  assert.match(r.text, /^~217K-316K tokens$/);
});

test("no cost text states a point estimate", () => {
  const bundle = { dir: "/tmp/x/claude-api", tokens: 174_772, files: 65, index: [["shared/a.md", 44_088]] };
  for (const txt of [
    sb.buildRedirect("claude-api", bundle),
    sb.buildAskReason("claude-api", bundle),
    sb.buildWarning("claude-api", bundle, 25_000),
  ]) {
    assert.doesNotMatch(txt, /174,772/, "raw bytes/4 must not be presented as the cost");
    assert.match(txt, /~175K-254K tokens/);
    assert.match(txt, /estimate|estimated/);
  }
});

// --- pure: redirect + ask text ---------------------------------------

test("buildRedirect names the cost, the path, the escape hatch and the kill switch", () => {
  const bundle = { dir: "/tmp/x/claude-api", tokens: 174772, files: 65, index: [["shared/a.md", 44088]] };
  const txt = sb.buildRedirect("claude-api", bundle);
  assert.match(txt, /\/tmp\/x\/claude-api/);
  assert.match(txt, /shared\/a\.md/);
  assert.match(txt, /\/claude-api/);
  assert.match(txt, /TKR_SKILL_GATE=off/);
});

test("buildRedirect discloses truncation instead of silently capping", () => {
  const index = Array.from({ length: sb.MAX_INDEX_ROWS + 7 }, (_, i) => [`f${i}.md`, 100 - i]);
  const txt = sb.buildRedirect("s", { dir: "/d", tokens: BIG, files: index.length, index });
  assert.match(txt, /\.\.\. 7 smaller files not listed/);
});

// A denied ask leaves the model holding only this text, so it has to be
// as actionable as the deny redirect — not merely a question.
test("buildAskReason frames both choices and survives a no", () => {
  const bundle = { dir: "/tmp/x/claude-api", tokens: 174772, files: 65, index: [["shared/a.md", 44088]] };
  const txt = sb.buildAskReason("claude-api", bundle);
  assert.match(txt, /Deny/);
  assert.match(txt, /Allow/);
  assert.match(txt, /\/tmp\/x\/claude-api/);
  assert.match(txt, /shared\/a\.md/);
  assert.match(txt, /auto-invoked/);
  // Every way out, including the one that stops the prompting.
  assert.match(txt, /TKR_SKILL_GATE=warn/);
  assert.match(txt, /TKR_SKILL_GATE=off|=off/);
  assert.match(txt, /\/claude-api is never gated/);
});

test("buildAskReason discloses truncation too", () => {
  const index = Array.from({ length: sb.MAX_INDEX_ROWS + 3 }, (_, i) => [`f${i}.md`, 100 - i]);
  const txt = sb.buildAskReason("s", { dir: "/d", tokens: BIG, files: index.length, index });
  assert.match(txt, /\.\.\. 3 smaller files not listed/);
});

test("buildWarning states the cost and both directions to change it", () => {
  const txt = sb.buildWarning("claude-api", { tokens: 174772, files: 65 }, 25000);
  assert.match(txt, /25,000/);
  assert.match(txt, /TKR_SKILL_GATE=ask/);
  assert.match(txt, /=deny/);
});

// --- I/O: discovery, measurement, caching -----------------------------

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sb-"));
  const mk = (ver, hash, skill, files) => {
    const d = path.join(root, ver, hash, skill);
    for (const [rel, bytes] of files) {
      const fp = path.join(d, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, "x".repeat(bytes));
    }
    return d;
  };
  return { root, mk };
}

test("resolveBundleDir returns null when the skill ships no bundle", () => {
  const { root } = fixture();
  assert.equal(sb.resolveBundleDir("tkr:search", root), null);
});

test("resolveBundleDir prefers the most recently touched version dir", () => {
  const { root, mk } = fixture();
  const older = mk("2.1.200", "aaa", "claude-api", [["shared/a.md", 400]]);
  const newer = mk("2.1.226", "bbb", "claude-api", [["shared/a.md", 400]]);
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(9_000_000), new Date(9_000_000));
  assert.equal(sb.resolveBundleDir("claude-api", root), newer);
});

test("measureBundle totals bytes/4 across the tree, largest first", () => {
  const { mk } = fixture();
  const dir = mk("v", "h", "s", [
    ["shared/big.md", 4000],
    ["shared/small.md", 400],
    ["lang/py/README.md", 800],
  ]);
  const m = sb.measureBundle(dir);
  assert.equal(m.files, 3);
  assert.equal(m.tokens, 1000 + 100 + 200);
  assert.deepEqual(m.index[0], ["shared/big.md", 1000]);
  assert.equal(m.index[m.index.length - 1][0], "shared/small.md");
});

test("measureBundle survives an unreadable subtree rather than throwing", () => {
  const { mk } = fixture();
  const dir = mk("v", "h", "s", [["a.md", 400]]);
  assert.equal(sb.measureBundle(path.join(dir, "nope")).tokens, 0);
  assert.equal(sb.measureBundle(dir).tokens, 100);
});

test("bundleFor caches the miss so plugin skills skip the temp walk", () => {
  const { root } = fixture();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-state-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = state;
  try {
    assert.equal(sb.bundleFor("tkr:search", { root }), null);
    const cache = JSON.parse(fs.readFileSync(path.join(state, "skill-bundles.json"), "utf8"));
    assert.equal(cache.entries["tkr:search"].dir, null);
    // Expired negative entry must re-resolve, not stay null forever.
    assert.equal(sb.bundleFor("tkr:search", { root, now: Date.now() + sb.MISS_TTL_MS + 1 }), null);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
  }
});

test("bundleFor re-measures when the cached directory has gone (CLI upgrade)", () => {
  const { root, mk } = fixture();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-state-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = state;
  try {
    const dir = mk("2.1.226", "h", "claude-api", [["a.md", 4000]]);
    assert.equal(sb.bundleFor("claude-api", { root }).tokens, 1000);
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
    mk("2.1.227", "h2", "claude-api", [["a.md", 8000]]);
    assert.equal(sb.bundleFor("claude-api", { root }).tokens, 2000);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
  }
});
