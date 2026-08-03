#!/usr/bin/env node
// Probe test for hooks/skill-invoked.js — confirms one row per call,
// kill-switch behavior, and field shape.
//
// Run: node hooks/skill-invoked.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA_VERSION } = require("./skill-invoked.js");

const HOOK = path.resolve(__dirname, "skill-invoked.js");
const LOG_NAME = "instructions-load.jsonl";

function runHook(payload, extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-skill-test-"));
  const env = { ...process.env, TKR_STATE_DIR: tmp };
  // Strip any inherited kill switches unless caller asked for them.
  delete env.TKR_HOOKS_DISABLED;
  delete env.TKR_SKILL_AUDIT_DISABLED;
  Object.assign(env, extraEnv || {});
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  const log = path.join(tmp, LOG_NAME);
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { res, rows, tmp, log };
}

test("returns {} on stdout for a valid Skill call", () => {
  const { res, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill: "ctx-audit" },
    session_id: "s-1",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
});

test("appends row with required PLAN-4 fields", () => {
  const { rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill: "tkr:continue", args: "" },
    session_id: "s-abc",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.event, "skill-invoked");
  assert.strictEqual(r.skill_name, "tkr:continue");
  assert.strictEqual(r.session_id, "s-abc");
  assert.strictEqual(r.schema_version, SCHEMA_VERSION);
  // v2: resolved, not hedged. No slash marker was written for this turn,
  // and a Skill dispatch on a turn the user did not open with /<skill>
  // is an auto trigger. "unknown" was the honest answer only while
  // nothing could tell the two apart.
  assert.strictEqual(r.invocation_source, "auto");
  assert.ok(typeof r.ts === "string" && r.ts.length > 0);
});

test("accepts spec-shape tool_input.skill_name as fallback", () => {
  // PLAN-4 L45 verify-gate uses skill_name; real CC uses skill.
  const { rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill_name: "ctx-audit" },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].skill_name, "ctx-audit");
});

test("prefers tool_input.skill over skill_name when both present", () => {
  const { rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill: "real", skill_name: "fallback" },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].skill_name, "real");
});

test("no row when skill name missing", () => {
  const { res, rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: {},
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("no row when tool_name is not Skill (misrouted matcher)", () => {
  const { rows, tmp } = runHook({
    tool_name: "Bash",
    tool_input: { skill: "ctx-audit" },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 0);
});

test("TKR_HOOKS_DISABLED=1 makes hook a no-op", () => {
  const { res, rows, tmp } = runHook(
    { tool_name: "Skill", tool_input: { skill: "ctx-audit" } },
    { TKR_HOOKS_DISABLED: "1" }
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("TKR_SKILL_AUDIT_DISABLED=1 makes hook a no-op (T7)", () => {
  const { res, rows, tmp } = runHook(
    { tool_name: "Skill", tool_input: { skill: "ctx-audit" } },
    { TKR_SKILL_AUDIT_DISABLED: "1" }
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("malformed JSON stdin → {} and no row", () => {
  const { res, rows, tmp } = runHook("{not json");
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("buildRow unit shape", () => {
  const { buildRow } = require("./skill-invoked.js");
  const row = buildRow({
    tool_name: "Skill",
    tool_input: { skill: "x" },
    session_id: "s",
  });
  assert.strictEqual(row.event, "skill-invoked");
  assert.strictEqual(row.schema_version, SCHEMA_VERSION);
  assert.strictEqual(row.skill_name, "x");
  assert.strictEqual(row.session_id, "s");
});

test("a slash-command turn is recorded as manual, not auto", () => {
  // The point of schema v2: "the skill fired 40 times" is not a trigger
  // measurement if the user typed /foo 40 times. The marker is written
  // by UserPromptSubmit; this asserts the reader half honors it.
  const { recordSlashCommand } = require("./lib/slash-marker.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-skill-manual-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = tmpDir;
  try {
    recordSlashCommand("/compress", "s-manual", "p-1");
    const { buildRow } = require("./skill-invoked.js");
    const row = buildRow({
      tool_name: "Skill",
      tool_input: { skill: "compress" },
      session_id: "s-manual",
      prompt_id: "p-1",
    });
    assert.strictEqual(row.invocation_source, "manual");

    // Same skill, a later turn. Must not inherit the marker.
    const later = buildRow({
      tool_name: "Skill",
      tool_input: { skill: "compress" },
      session_id: "s-manual",
      prompt_id: "p-2",
    });
    assert.strictEqual(later.invocation_source, "auto");
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a row with no skill name still says unknown", () => {
  // The one case that genuinely cannot be answered: with no skill name
  // there is nothing to match a marker against, so the question was
  // never askable rather than answered "auto".
  const { buildRow } = require("./skill-invoked.js");
  const row = buildRow({ tool_name: "Skill", tool_input: {}, session_id: "s" });
  assert.strictEqual(row.skill_name, "");
  assert.strictEqual(row.invocation_source, "unknown");
});
