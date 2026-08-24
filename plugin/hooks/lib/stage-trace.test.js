// Tests for hooks/lib/stage-trace.js — INV-085 step 2.
//
// The behavior worth pinning is the one the module exists for: a run that is
// KILLED must leave attributable evidence behind. That cannot be tested in
// process — the singleton would still be holding state — so the killed run is
// a real child that exits without reaching done(), and the assertion is made
// by a subsequent start() in the parent.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MODULE = require.resolve("./stage-trace");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-stage-trace-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// runChild executes a snippet with the module loaded and TKR_STATE_DIR pointed
// at the fixture. `trace` is the module; the snippet decides whether to close.
function runChild(dir, snippet, extraEnv = {}) {
  const res = spawnSync(
    process.execPath,
    ["-e", `const trace = require(${JSON.stringify(MODULE)});\n${snippet}`],
    {
      env: {
        ...process.env,
        TKR_STATE_DIR: dir,
        TKR_HOOK_STAGE_TRACE: "1",
        ...extraEnv,
      },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return res;
}

function ledgerRows(dir) {
  const p = path.join(dir, "hook-stages.jsonl");
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function inFlightFiles(dir) {
  try {
    return fs.readdirSync(path.join(dir, "stage"));
  } catch {
    return [];
  }
}

test("off unless TKR_HOOK_STAGE_TRACE=1 — no files, no rows", () => {
  const fx = fixture();
  try {
    const res = runChild(
      fx.dir,
      'trace.start("sid-off", "h"); trace.mark("a"); trace.done();',
      { TKR_HOOK_STAGE_TRACE: "" },
    );
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(inFlightFiles(fx.dir), [], "no in-flight file when disabled");
    assert.deepStrictEqual(ledgerRows(fx.dir), [], "no ledger rows when disabled");
  } finally {
    fx.cleanup();
  }
});

test("a fast completed run leaves nothing behind", () => {
  const fx = fixture();
  try {
    const res = runChild(
      fx.dir,
      'trace.start("sid-fast", "h"); trace.mark("a"); trace.mark("b"); trace.done();',
    );
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(
      inFlightFiles(fx.dir),
      [],
      "done() must unlink the in-flight file",
    );
    assert.deepStrictEqual(
      ledgerRows(fx.dir),
      [],
      "below the threshold a completed run appends no durable row",
    );
  } finally {
    fx.cleanup();
  }
});

test("a slow completed run records its stages", () => {
  const fx = fixture();
  try {
    const res = runChild(
      fx.dir,
      'trace.start("sid-slow", "user-prompt-submit"); trace.mark("route-classify"); trace.done();',
      { TKR_HOOK_STAGE_TRACE_MS: "0" },
    );
    assert.strictEqual(res.status, 0, res.stderr);
    const rows = ledgerRows(fx.dir);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, "slow");
    assert.strictEqual(rows[0].session_id, "sid-slow");
    assert.strictEqual(rows[0].hook, "user-prompt-submit");
    assert.ok(typeof rows[0].total_ms === "number");
    const stages = rows[0].stages.map((s) => s[0]);
    assert.deepStrictEqual(stages, ["start", "route-classify"]);
  } finally {
    fx.cleanup();
  }
});

test("a killed run is promoted by the next run, naming the stage it died in", () => {
  const fx = fixture();
  try {
    // The killed run: marks two stages, then exits without done() — exactly
    // what a SIGKILL at Claude Code's 10s ceiling leaves behind.
    const dead = runChild(
      fx.dir,
      'trace.start("sid-kill", "user-prompt-submit");\n' +
        'trace.mark("spawn:record-event");\n' +
        'trace.mark("route-classify");\n' +
        "process.exit(0);",
    );
    assert.strictEqual(dead.status, 0, dead.stderr);
    assert.deepStrictEqual(
      inFlightFiles(fx.dir),
      ["sid-kill.jsonl"],
      "the in-flight file must survive a run that never closed",
    );
    assert.deepStrictEqual(ledgerRows(fx.dir), [], "nothing durable yet — promotion is the next run's job");

    // The next run for the same session promotes it.
    const next = runChild(
      fx.dir,
      'trace.start("sid-kill", "user-prompt-submit"); trace.done();',
    );
    assert.strictEqual(next.status, 0, next.stderr);

    const rows = ledgerRows(fx.dir);
    assert.strictEqual(rows.length, 1, "exactly one abandoned row");
    assert.strictEqual(rows[0].kind, "abandoned");
    assert.strictEqual(rows[0].session_id, "sid-kill");
    assert.strictEqual(
      rows[0].died_in_stage,
      "route-classify",
      "the LAST mark is the stage the run was inside when it died",
    );
    assert.deepStrictEqual(
      rows[0].stages.map((s) => s[0]),
      ["start", "spawn:record-event", "route-classify"],
      "the full breadcrumb trail survives, not just the last mark",
    );
    assert.strictEqual(rows[0].torn_lines, 0);
    assert.deepStrictEqual(
      inFlightFiles(fx.dir),
      [],
      "the promoting run closes cleanly and leaves nothing",
    );
  } finally {
    fx.cleanup();
  }
});

test("a torn final line is skipped, not fatal", () => {
  // A process killed mid-append can leave a partial JSON line. The surviving
  // marks are still the evidence, so the row must be written and must say how
  // many lines it could not parse.
  const fx = fixture();
  try {
    const stageDir = path.join(fx.dir, "stage");
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(
      path.join(stageDir, "sid-torn.jsonl"),
      JSON.stringify({ stage: "start", at_ms: 0, pid: 1, started: "x" }) +
        "\n" +
        JSON.stringify({ stage: "spawn:record-event", at_ms: 3, pid: 1, started: "x" }) +
        '\n{"stage":"route-cla',
    );
    const res = runChild(fx.dir, 'trace.start("sid-torn", "h"); trace.done();');
    assert.strictEqual(res.status, 0, res.stderr);
    const rows = ledgerRows(fx.dir);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].died_in_stage, "spawn:record-event");
    assert.strictEqual(rows[0].torn_lines, 1);
  } finally {
    fx.cleanup();
  }
});

test("a session id cannot escape the in-flight directory", () => {
  const fx = fixture();
  try {
    const res = runChild(
      fx.dir,
      'trace.start("../../escaped", "h"); trace.mark("a"); trace.done();',
      { TKR_HOOK_STAGE_TRACE_MS: "0" },
    );
    assert.strictEqual(res.status, 0, res.stderr);
    // The run completed and unlinked its own file, so assert on the ledger row
    // plus the absence of anything written outside the stage directory.
    const rows = ledgerRows(fx.dir);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].session_id, "../../escaped");
    const stray = fs
      .readdirSync(fx.dir)
      .filter((n) => n !== "stage" && n !== "hook-stages.jsonl");
    assert.deepStrictEqual(stray, [], "nothing written outside stage/ and the ledger");
  } finally {
    fx.cleanup();
  }
});
