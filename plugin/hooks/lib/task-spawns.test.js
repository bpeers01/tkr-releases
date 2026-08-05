// Tests for the rotation half of hooks/lib/task-spawns.js.
//
// This ledger is appended by hooks/agent-search-inject.js on every
// PreToolUse(Agent), so when Claude dispatches several agents at once
// the appends — and the rotations — come from parallel processes. The
// module used to carry a PRIVATE copy of the rotator that removed the old
// .1 before renaming onto it, which is the data-loss race #86 fixed in
// hooks/lib/rotate-jsonl.js and did not reach this copy. It now uses the
// shared module; these tests hold that wiring in place.
//
// The race itself is covered once, at the shared module, in
// hooks/lib/rotate-jsonl.test.js.
//
// Run: node --test hooks/lib/task-spawns.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { emitTaskSpawn, readSpawns } = require("./task-spawns.js");
const { DEFAULT_MAX_BYTES } = require("./rotate-jsonl.js");

function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-task-spawns-"));
  const ledger = path.join(dir, "task-spawns.jsonl");
  const saved = process.env.TKR_TASK_SPAWNS_PATH;
  process.env.TKR_TASK_SPAWNS_PATH = ledger;
  try {
    return fn(ledger);
  } finally {
    if (saved === undefined) delete process.env.TKR_TASK_SPAWNS_PATH;
    else process.env.TKR_TASK_SPAWNS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("an over-cap ledger rotates and the append lands in the fresh file", () => {
  withLedger((ledger) => {
    // Marker at the head, then a sparse extension to the cap: stat
    // reports the full size without writing 10 MB.
    fs.writeFileSync(ledger, '{"marker":"generation-A"}\n');
    fs.truncateSync(ledger, DEFAULT_MAX_BYTES);

    emitTaskSpawn({ session_id: "s1", tool_name: "Agent", subagent_type: "Explore" });

    assert.ok(
      fs.readFileSync(ledger + ".1", "utf8").startsWith('{"marker":"generation-A"}'),
      "the prior window did not become the .1 generation",
    );
    const rows = readSpawns(ledger);
    assert.strictEqual(rows.length, 1, "the fresh ledger should hold only the new row");
    assert.strictEqual(rows[0].subagent_type, "Explore");
  });
});

test("an under-cap ledger is appended, not rotated", () => {
  withLedger((ledger) => {
    emitTaskSpawn({ session_id: "s1", tool_name: "Agent", subagent_type: "Explore" });
    emitTaskSpawn({ session_id: "s1", tool_name: "Agent", subagent_type: "Plan" });

    assert.ok(!fs.existsSync(ledger + ".1"), "a small ledger was rotated");
    assert.deepStrictEqual(
      readSpawns(ledger).map((r) => r.subagent_type),
      ["Explore", "Plan"],
    );
  });
});

// ── Spawn-time veto fields (v4, ADR-0033 Phase 4) ──────────────────────

test("veto_checked=false (or absent) writes no veto_* fields at all", () => {
  withLedger((ledger) => {
    emitTaskSpawn({ session_id: "s1", tool_name: "Agent", subagent_type: "Explore" });
    const row = readSpawns(ledger)[0];
    assert.strictEqual(row.schema_version, 4);
    assert.ok(!("veto_checked" in row), "no check ran; the row must stay silent on veto");
    assert.ok(!("veto_denied" in row));
    assert.ok(!("veto_reason" in row));
    assert.ok(!("veto_would_deny" in row));
  });
});

test("veto_checked=true with an allow verdict: checked+denied written, reason/would_deny omitted", () => {
  withLedger((ledger) => {
    emitTaskSpawn({
      session_id: "s1",
      tool_name: "Agent",
      subagent_type: "tkr:explore-haiku",
      veto_checked: true,
      veto_denied: false,
      veto_reason: "",
      veto_would_deny: false,
    });
    const row = readSpawns(ledger)[0];
    assert.strictEqual(row.veto_checked, true);
    assert.strictEqual(row.veto_denied, false);
    assert.ok(!("veto_reason" in row), "empty reason on an allow row should not be written");
    assert.ok(!("veto_would_deny" in row), "false would_deny is the common case and stays omitted");
  });
});

test("veto_checked=true with a denial: veto_denied and veto_reason both land", () => {
  withLedger((ledger) => {
    emitTaskSpawn({
      session_id: "s1",
      tool_name: "Agent",
      subagent_type: "tkr:explore-haiku",
      veto_checked: true,
      veto_denied: true,
      veto_reason: "mutation_to_readonly_worker",
    });
    const row = readSpawns(ledger)[0];
    assert.strictEqual(row.veto_checked, true);
    assert.strictEqual(row.veto_denied, true);
    assert.strictEqual(row.veto_reason, "mutation_to_readonly_worker");
    assert.ok(!("veto_would_deny" in row));
  });
});

test("veto_checked=true with would_deny (observe mode): flag lands, verdict stays allow-shaped", () => {
  withLedger((ledger) => {
    emitTaskSpawn({
      session_id: "s1",
      tool_name: "Agent",
      subagent_type: "tkr:explore-haiku",
      veto_checked: true,
      veto_denied: false,
      veto_reason: "mutation_to_readonly_worker",
      veto_would_deny: true,
    });
    const row = readSpawns(ledger)[0];
    assert.strictEqual(row.veto_denied, false);
    assert.strictEqual(row.veto_reason, "mutation_to_readonly_worker");
    assert.strictEqual(row.veto_would_deny, true);
  });
});

test("veto fields are top-level, not nested inside the plan_id block", () => {
  withLedger((ledger) => {
    emitTaskSpawn({
      session_id: "s1",
      tool_name: "Agent",
      subagent_type: "tkr:explore-haiku",
      veto_checked: true,
      veto_denied: true,
      veto_reason: "cost_ceiling_exceeded",
      // Deliberately no plan_id — a veto can fire with no work plan
      // current for this spawn at all.
    });
    const row = readSpawns(ledger)[0];
    assert.ok(!("plan_id" in row), "no plan was current for this spawn");
    assert.strictEqual(row.veto_checked, true, "veto fields must not depend on plan_id");
    assert.strictEqual(row.veto_denied, true);
  });
});

// The private rotator this module used to own is the reason hooks/CLAUDE.md
// requires the shared one. If a future edit reintroduces a local copy, the
// #86 fix silently stops applying here again — so assert the wiring, not
// just the behavior.
test("rotation is delegated to the shared module, not reimplemented", () => {
  const src = fs.readFileSync(path.join(__dirname, "task-spawns.js"), "utf8");
  assert.ok(
    /require\(["']\.\/rotate-jsonl["']\)/.test(src),
    "task-spawns.js must require the shared rotate-jsonl module",
  );
  assert.ok(
    !/unlinkSync|rmSync|\.rm\(/.test(src),
    "task-spawns.js must not remove files — rotation is rename-only",
  );
});
