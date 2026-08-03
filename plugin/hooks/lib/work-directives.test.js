#!/usr/bin/env node
// Emitted-directive ledger rows (native-work-routing §14).
//
// The single property this ledger has to hold is that a row exists only
// when the coordinator was genuinely told something. It is the
// denominator for follow rate, so any row it gains for free — a tombstone,
// a plan that stayed silent, a retry — inflates the denominator and
// depresses a number the feature is judged on. Every test here is a way
// that could happen.
//
// Run: node --test hooks/lib/work-directives.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { emitWorkDirective, ledgerPath, EVENT } = require("./work-directives.js");

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-work-directives-"));
  const saved = { ...process.env };
  process.env.TKR_STATE_DIR = dir;
  delete process.env.TKR_DECISIONS_PATH;
  delete process.env.TKR_HOOKS_DISABLED;
  delete process.env.TKR_WORK_ROUTE_DISABLED;
  const rows = () => {
    const p = path.join(dir, "decisions.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  };
  try {
    fn({ dir, rows });
  } finally {
    for (const k of ["TKR_STATE_DIR", "TKR_DECISIONS_PATH", "TKR_HOOKS_DISABLED", "TKR_WORK_ROUTE_DISABLED"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test("an emitted directive produces one row", () => {
  withDir(({ rows }) => {
    emitWorkDirective({
      sessionID: "s1",
      promptID: "pr-1",
      planID: "wr-1",
      profile: "tkr:explore-haiku",
    });
    const r = rows();
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].event, EVENT);
    assert.strictEqual(r[0].session_id, "s1");
    assert.strictEqual(r[0].prompt_id, "pr-1");
    assert.strictEqual(r[0].plan_id, "wr-1");
    assert.strictEqual(r[0].profile, "tkr:explore-haiku");
  });
});

test("the timestamp field is ts, the one every decisions.jsonl reader keys on", () => {
  // The sibling ledgers use `at`. A row in this file with `at` has, as far
  // as signals.LoadRecords and the funnel's day window are concerned, no
  // timestamp at all — and would be dropped from every windowed report
  // while looking perfectly well-formed on disk.
  withDir(({ rows }) => {
    emitWorkDirective({ sessionID: "s1", planID: "wr-1" });
    assert.ok(rows()[0].ts, "row must carry ts");
    assert.ok(!("at" in rows()[0]), "row must not carry at");
    assert.ok(!Number.isNaN(Date.parse(rows()[0].ts)));
  });
});

test("no plan id means no row", () => {
  // The caller is supposed to gate on an actual emission, but this is the
  // failure that would be invisible: a tombstone written every prompt
  // would quietly triple the denominator on a busy session.
  withDir(({ rows }) => {
    emitWorkDirective({ sessionID: "s1", planID: "" });
    emitWorkDirective({ sessionID: "s1" });
    emitWorkDirective({});
    emitWorkDirective(null);
    assert.deepStrictEqual(rows(), []);
  });
});

test("it shares decisions.jsonl without disturbing the other writers' rows", () => {
  withDir(({ dir, rows }) => {
    const p = path.join(dir, "decisions.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ts: "2026-07-30T00:00:00.000Z", event: "route-classified" }) + "\n");
    emitWorkDirective({ sessionID: "s1", planID: "wr-1" });
    const r = rows();
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].event, "route-classified");
    assert.strictEqual(r[1].event, EVENT);
  });
});

for (const killSwitch of ["TKR_HOOKS_DISABLED", "TKR_WORK_ROUTE_DISABLED"]) {
  test(`${killSwitch}=1 writes nothing`, () => {
    withDir(({ rows }) => {
      process.env[killSwitch] = "1";
      emitWorkDirective({ sessionID: "s1", planID: "wr-1" });
      assert.deepStrictEqual(rows(), []);
    });
  });
}

test("an unwritable ledger is swallowed", () => {
  withDir(({ dir }) => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    process.env.TKR_DECISIONS_PATH = path.join(blocker, "nested", "decisions.jsonl");
    assert.doesNotThrow(() => emitWorkDirective({ sessionID: "s1", planID: "wr-1" }));
  });
});

test("TKR_DECISIONS_PATH overrides the resolved location", () => {
  withDir(({ dir }) => {
    const custom = path.join(dir, "elsewhere.jsonl");
    process.env.TKR_DECISIONS_PATH = custom;
    assert.strictEqual(ledgerPath(), custom);
    emitWorkDirective({ sessionID: "s1", planID: "wr-1" });
    assert.ok(fs.existsSync(custom));
  });
});
