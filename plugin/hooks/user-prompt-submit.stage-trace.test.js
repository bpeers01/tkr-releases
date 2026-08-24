// End-to-end wiring check for the INV-085 stage tracer.
//
// stage-trace.test.js proves the tracer works. This proves it is CONNECTED —
// that a real user-prompt-submit.js run emits the marks the attribution
// argument depends on.
//
// It also pins the shape INV-085 step 3 produced. The two spawns the tracer
// was built to tell apart are now ONE for an eligible prompt (`tkr hook
// prompt-submit`) and one for an ineligible one (the detached record-event),
// and which branch a prompt takes is a correctness claim, not a performance
// one: classifying a /brevity turn or a subagent dispatch would write route
// state for a turn the ledger deliberately excludes. The record-before-
// classify ordering the old assertion carried now lives inside the Go verb,
// where a kill is what makes the order observable.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.join(__dirname, "user-prompt-submit.js");
const SID = "sid-stage-wiring";

function run(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ups-stage-"));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  // A TKR_BIN that exits immediately: the marks are what is under test, not
  // whatever the classifier would have written.
  const shim = path.join(dir, "tkr-shim.js");
  fs.writeFileSync(shim, "process.exit(0);\n");

  const env = {
    ...process.env,
    TKR_BIN: shim,
    TKR_STATE_DIR: stateDir,
    TMPDIR: dir,
    TKR_ROUTE_CACHE_DIR: dir,
    TKR_HOOK_STAGE_TRACE: "1",
    // Threshold 0 so the completed run records rather than staying quiet.
    TKR_HOOK_STAGE_TRACE_MS: "0",
  };
  delete env.TKR_SESSION_ID;
  delete env.TKR_HOOKS_DISABLED;
  delete env.TKR_ROUTE_DISABLED;
  delete env.TKR_ROUTE_SYNC;

  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SID, cwd: process.cwd(), prompt }),
    env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });

  let rows = [];
  try {
    rows = fs
      .readFileSync(path.join(stateDir, "hook-stages.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // handled by the assertions
  }
  const leftover = (() => {
    try {
      return fs.readdirSync(path.join(stateDir, "stage"));
    } catch {
      return [];
    }
  })();
  fs.rmSync(dir, { recursive: true, force: true });
  return { res, rows, leftover };
}

test("a normal prompt traces ONE spawn — the merged prompt-submit call", (t) => {
  const { res, rows, leftover } = run("add a retry to the queue helper and test it");
  if (res.error || res.signal) {
    t.skip(`could not run the hook (${res.error ? res.error.code : res.signal}) — inconclusive`);
    return;
  }
  assert.strictEqual(rows.length, 1, "one completed-run row");
  const stages = rows[0].stages.map((s) => s[0]);

  assert.strictEqual(stages[0], "start");
  assert.ok(
    stages.includes("spawn:prompt-submit"),
    `the merged call must be traced (got ${stages.join(",")})`,
  );
  // INV-085 step 3: these two marks were the two per-prompt process
  // creations. An eligible prompt now takes neither — if either reappears
  // here the merge has regressed to the two-creation shape, which is the
  // whole defect, and the fork budget alone would not say which spawn came
  // back.
  assert.ok(
    !stages.includes("spawn:record-event"),
    `the detached record-event must NOT run for an eligible prompt (got ${stages.join(",")})`,
  );
  assert.ok(
    !stages.includes("route-classify"),
    `classifyRouteSync must NOT spawn after the merged call (got ${stages.join(",")})`,
  );
  assert.deepStrictEqual(leftover, [], "a completed run leaves no in-flight file");
});

test("an ineligible prompt still records its event, via the detached spawn", (t) => {
  // /brevity returns early, before routeInjectContext, so classify was never
  // going to run for it — the merged call would be the wrong shape and would
  // write route state for a turn deliberately excluded from the ledger. The
  // ineligible branch keeps the fire-and-forget record-event, which is what
  // stops PLAN-5 session continuity gaining a silent hole on these turns.
  const { res, rows, leftover } = run("/brevity full");
  if (res.error || res.signal) {
    t.skip(`could not run the hook (${res.error ? res.error.code : res.signal}) — inconclusive`);
    return;
  }
  assert.strictEqual(rows.length, 1);
  const stages = rows[0].stages.map((s) => s[0]);
  assert.ok(
    stages.includes("spawn:record-event"),
    `a brevity turn must still record its prompt event (got ${stages.join(",")})`,
  );
  assert.ok(
    !stages.includes("spawn:prompt-submit"),
    `a brevity turn must not take the merged call (got ${stages.join(",")})`,
  );
  assert.strictEqual(rows[0].kind, "slow", "a closed run records as completed, never abandoned");
  assert.deepStrictEqual(leftover, [], "the early return must still unlink the in-flight file");
});
