// Tests for hooks/lib/work-route-state.js — the two mechanisms that make
// assisted routing safe to act on a plan.
//
// The exclusivity test is the important one, and it is deliberately at
// THIS level rather than through the Agent hook. A hook-level race is
// dominated by node startup: the first process boots, claims and exits
// long before its siblings reach the claim, so a broken check-then-write
// implementation passes. Verified — the hook-level test does not catch
// it. Here the racers are released from a barrier after they are all
// booted, which is the only arrangement that exercises the window.
//
// Run: node --test hooks/lib/work-route-state.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MODULE = path.join(__dirname, "work-route-state.js");
const wrs = require("./work-route-state.js");
const routeState = require("./route-state.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-work-route-"));
}

function withStateDir(dir, fn) {
  const saved = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = saved;
  }
}

// ── Exclusive claim ─────────────────────────────────────────────────────────

test("a plan can be claimed exactly once", () => {
  const dir = tmpdir();
  try {
    withStateDir(dir, () => {
      assert.strictEqual(wrs.claimPlan("sid-1", "wr-1"), true);
      assert.strictEqual(wrs.claimPlan("sid-1", "wr-1"), false, "claimed twice");
      // A different plan in the same session is a separate claim.
      assert.strictEqual(wrs.claimPlan("sid-1", "wr-2"), true);
      // As is the same plan in a different session.
      assert.strictEqual(wrs.claimPlan("sid-2", "wr-1"), true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The regression gate for "one plan, one spawn". Parallel
// PreToolUse(Agent) processes are routine whenever the coordinator
// dispatches several workers at once; check-then-write lets every one of
// them observe the plan as unclaimed before any writes.
test("concurrent claimants: exactly one wins", async () => {
  const ROUNDS = 5;
  const RACERS = 12;
  const SRC = `
    const wrs = require(${JSON.stringify(MODULE)});
    process.env.TKR_STATE_DIR = process.argv[1];
    // Register the release handler, then announce readiness, so every
    // racer is already inside the module and waiting before any claims.
    process.stdin.once("data", () => {
      process.stdout.write(wrs.claimPlan("sid-race", "wr-race") ? "WON" : "LOST");
      process.exit(0);
    });
    process.stdout.write("ready\\n");
  `;
  for (let round = 0; round < ROUNDS; round++) {
    const dir = tmpdir();
    try {
      const kids = Array.from({ length: RACERS }, () =>
        spawn(process.execPath, ["-e", SRC, dir], { stdio: ["pipe", "pipe", "pipe"] }),
      );
      const outs = kids.map(() => "");
      await Promise.all(kids.map((k, i) => new Promise((res) => {
        k.stdout.on("data", (d) => {
          outs[i] += d;
          if (outs[i].includes("ready")) res();
        });
      })));
      for (const k of kids) k.stdin.end("go");
      await Promise.all(kids.map((k) => new Promise((res) => k.once("close", res))));

      const won = outs.filter((o) => o.includes("WON")).length;
      assert.strictEqual(won, 1, `round ${round}: ${won} racers claimed the same plan`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Ids reach the filesystem as path components. Refusing is the correct
// answer, not sanitizing into a different-but-valid name.
test("unsafe ids are refused rather than sanitized", () => {
  const dir = tmpdir();
  try {
    withStateDir(dir, () => {
      for (const [sid, plan] of [
        ["../escape", "wr-1"],
        ["sid", "../../etc/passwd"],
        ["sid/nested", "wr-1"],
        ["", "wr-1"],
        ["sid", ""],
        ["sid", "wr\u0000null"],
        ["sid", "wr null"],
      ]) {
        assert.strictEqual(wrs.claimPath(sid, plan), "", `claimPath accepted ${sid} / ${plan}`);
        assert.strictEqual(wrs.claimPlan(sid, plan), false, `claimPlan accepted ${sid} / ${plan}`);
      }
      // Nothing escaped the state dir.
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An unwritable state dir must disable routing, not enable unbounded
// rewriting. TKR prefers a missed optimization over a plan applied too
// broadly.
//
// The dir has to be genuinely unmakeable to test this. An earlier version
// pointed at a merely-nonexistent path, which claimPlan's own
// mkdirSync(recursive) simply creates. Rooting the state dir under a
// regular FILE gives a deterministic ENOTDIR everywhere.
test("a state dir that cannot be created fails closed", () => {
  const dir = tmpdir();
  try {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    withStateDir(path.join(blocker, "state"), () => {
      assert.strictEqual(wrs.claimPlan("sid", "wr-1"), false,
        "an unwritable state dir must not hand out claims");
      // The receipt side degrades the same way: no receipt means
      // assisted routing declines rather than proceeding unproven.
      wrs.writeDirectiveReceipt("sid", { planID: "wr-1", directiveEmitted: true });
      assert.strictEqual(wrs.receiptProvesTurn("sid", "wr-1"), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Per-turn receipt ────────────────────────────────────────────────────────

test("a receipt round-trips and proves its turn", () => {
  const dir = tmpdir();
  try {
    withStateDir(dir, () => {
      wrs.writeDirectiveReceipt("sid-r", {
        promptHash: "abc", planID: "wr-7", directiveEmitted: true,
      });
      const r = wrs.readDirectiveReceipt("sid-r");
      assert.strictEqual(r.plan_id, "wr-7");
      assert.strictEqual(r.directive_emitted, true);
      assert.strictEqual(wrs.receiptProvesTurn("sid-r", "wr-7"), true);
      assert.strictEqual(wrs.receiptProvesTurn("sid-r", "wr-8"), false,
        "a receipt must only vouch for the plan it names");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The tombstone is the whole point: written even when nothing was
// emitted, so last turn's receipt can never be mistaken for this turn's.
test("a tombstone receipt proves nothing", () => {
  const dir = tmpdir();
  try {
    withStateDir(dir, () => {
      wrs.writeDirectiveReceipt("sid-t", { promptHash: "abc", planID: "wr-7", directiveEmitted: true });
      assert.strictEqual(wrs.receiptProvesTurn("sid-t", "wr-7"), true);
      // Next turn emitted nothing.
      wrs.writeDirectiveReceipt("sid-t", { promptHash: "def", planID: "", directiveEmitted: false });
      assert.strictEqual(wrs.receiptProvesTurn("sid-t", "wr-7"), false,
        "last turn's plan is still on disk and must no longer be vouched for");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing receipt proves nothing", () => {
  const dir = tmpdir();
  try {
    withStateDir(dir, () => {
      assert.strictEqual(wrs.readDirectiveReceipt("sid-none"), null);
      assert.strictEqual(wrs.receiptProvesTurn("sid-none", "wr-1"), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, mutate] of [
  ["another session's", (d) => ({ ...d, session_id: "other" })],
  ["one older than the state TTL", (d) => ({
    ...d, written_at: new Date(Date.now() - (routeState.STATE_TTL_SECS + 60) * 1000).toISOString(),
  })],
  ["one stamped in the future", (d) => ({
    ...d, written_at: new Date(Date.now() + (routeState.STATE_TTL_SECS + 60) * 1000).toISOString(),
  })],
  ["one with an unparseable timestamp", (d) => ({ ...d, written_at: "not-a-date" })],
]) {
  test(`${label} receipt is rejected`, () => {
    const dir = tmpdir();
    try {
      withStateDir(dir, () => {
        wrs.writeDirectiveReceipt("sid-x", { planID: "wr-1", directiveEmitted: true });
        const p = wrs.receiptPath("sid-x");
        fs.writeFileSync(p, JSON.stringify(mutate(JSON.parse(fs.readFileSync(p, "utf8")))));
        assert.strictEqual(wrs.receiptProvesTurn("sid-x", "wr-1"), false);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a corrupt receipt is rejected, not thrown on", () => {
  const dir = tmpdir();
  try {
    withStateDir(dir, () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(wrs.receiptPath("sid-c"), "{not json");
      assert.strictEqual(wrs.readDirectiveReceipt("sid-c"), null);
      assert.strictEqual(wrs.receiptProvesTurn("sid-c", "wr-1"), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Mode predicates ─────────────────────────────────────────────────────────

test("only assisted rewrites; only advisory and above are scored", () => {
  for (const m of ["assisted"]) assert.ok(wrs.modeAllowsRewrite(m), m);
  for (const m of ["off", "observe", "advisory", "managed", "", "nonsense", null]) {
    assert.ok(!wrs.modeAllowsRewrite(m), `${m} must not rewrite`);
  }
  for (const m of ["advisory", "assisted", "managed"]) {
    assert.ok(wrs.modeIsFollowable(m), `${m} should be scored`);
  }
  for (const m of ["off", "observe", "", "nonsense", null]) {
    assert.ok(!wrs.modeIsFollowable(m), `${m} must not be scored`);
  }
});

// ── Sweep ───────────────────────────────────────────────────────────────────

test("stale receipts and claims are swept, fresh ones kept", () => {
  const dir = tmpdir();
  try {
    withStateDir(dir, () => {
      wrs.writeDirectiveReceipt("sid-old", { planID: "wr-1", directiveEmitted: true });
      wrs.claimPlan("sid-old", "wr-1");
      wrs.writeDirectiveReceipt("sid-new", { planID: "wr-2", directiveEmitted: true });
      // Unrelated state must survive — the sweep is prefix-scoped.
      fs.writeFileSync(path.join(dir, "mode-sid-new.json"), "{}");

      const old = Date.now() - 2 * wrs.STALE_MS;
      for (const n of [`work-receipt-sid-old.json`, `work-claim-sid-old-wr-1`]) {
        fs.utimesSync(path.join(dir, n), new Date(old), new Date(old));
      }

      assert.strictEqual(wrs.sweepStaleWorkFiles(), 2);
      const left = fs.readdirSync(dir).sort();
      assert.deepStrictEqual(left, ["mode-sid-new.json", "work-receipt-sid-new.json"]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── §11 planObjective allowlist ──────────────────────────────────────────────

test("planObjective: absent-both is legacy, recognized pairs pass, anything else declines", () => {
  const { planObjective } = require("./work-route-state.js");
  // Legacy: a plan written by a pre-vocabulary Go binary.
  assert.deepStrictEqual(planObjective({}), { ok: true, legacy: true, objective: "", strategy: "" });
  assert.deepStrictEqual(planObjective(null), { ok: true, legacy: true, objective: "", strategy: "" });
  // Recognized vocabulary.
  for (const [o, s] of [["economize", "downshift"], ["isolate", "same"], ["escalate", "upshift"]]) {
    const got = planObjective({ objective: o, model_strategy: s });
    assert.deepStrictEqual(got, { ok: true, legacy: false, objective: o, strategy: s });
  }
  // Unknown value, partial pair, wrong types: all decline.
  for (const plan of [
    { objective: "turbo", model_strategy: "same" },
    { objective: "isolate", model_strategy: "sideways" },
    { objective: "isolate" },
    { model_strategy: "same" },
    { objective: 7, model_strategy: "same" },
  ]) {
    assert.strictEqual(planObjective(plan).ok, false, JSON.stringify(plan));
  }
});
