#!/usr/bin/env node
// tkr PreToolUse(Skill) hook — telemetry only.
//
// Appends one row to ~/.tkr/instructions-load.jsonl per Skill tool
// dispatch with shape:
//   {ts, event:"skill-invoked", skill_name, invocation_source,
//    session_id, schema_version:1}
//
// Field source: stdin `tool_input.skill` (real Claude Code) with a
// `tool_input.skill_name` fallback for tests + future schema drift —
// see docs/spikes/skill-tool-pretooluse-findings.md §"Deviations".
//
// invocation_source: kept as a forward-compat field but set to
// "unknown" at hook time. PLAN-4 T4 derives manual|auto by joining
// against the per-session JSONL transcript (the `<command-name>`
// marker on the prior turn is the authoritative signal). Doing the
// inference at hook time would require reading the transcript,
// which we cannot afford on the <10ms p95 hot path (T8 budget).
//
// Kill switches (in order, both no-op the hook):
//   1. TKR_HOOKS_DISABLED=1 — master tkr-hooks kill switch (M-12)
//   2. TKR_SKILL_AUDIT_DISABLED=1 — PLAN-4-specific kill switch (T7)
//
// Output contract: empty `{}` on stdout. Pure observability.

"use strict";

const fs = require("fs");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { rotateIfLarge } = require("./lib/rotate-jsonl");
const { stateDir } = require("./lib/state-dir");
const { resolveInvocationSource } = require("./lib/slash-marker");

// v1 -> v2: invocation_source is now resolved rather than always
// "unknown". The signal comes from a per-turn marker the
// UserPromptSubmit hook writes when the prompt is a slash command, so
// the resolution costs one small file read instead of the transcript
// scan the <10ms budget could not afford. Readers use the version to
// tell "this writer could not decide" from "this writer decided auto".
const SCHEMA_VERSION = 2;

function skillAuditDisabled() {
  return process.env.TKR_SKILL_AUDIT_DISABLED === "1";
}

function extractSkillName(input) {
  const ti = input && input.tool_input;
  if (!ti || typeof ti !== "object") return "";
  // T0 finding: real Claude Code emits `skill`; spec verify-gate uses
  // `skill_name`. Accept both, prefer `skill`.
  return (
    (typeof ti.skill === "string" && ti.skill) ||
    (typeof ti.skill_name === "string" && ti.skill_name) ||
    ""
  );
}

function buildRow(input) {
  const skill = extractSkillName(input);
  const sid = (input && input.session_id) || "";
  // "unknown" survives only as the no-skill-name case: with nothing to
  // match a marker against, the question cannot be asked at all. Every
  // other row now carries a real answer — see hooks/lib/slash-marker.js
  // on why "auto" is the honest default rather than a hedge.
  const source = skill
    ? resolveInvocationSource(skill, sid, (input && input.prompt_id) || "")
    : "unknown";
  return {
    ts: new Date().toISOString(),
    event: "skill-invoked",
    skill_name: skill,
    invocation_source: source || "unknown",
    session_id: sid,
    schema_version: SCHEMA_VERSION,
  };
}

function appendRow(row) {
  const dir = stateDir();
  const logPath = path.join(dir, "instructions-load.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  rotateIfLarge(logPath);
  fs.appendFileSync(logPath, JSON.stringify(row) + "\n");
}

function main() {
  if (hooksDisabled() || skillAuditDisabled()) {
    process.stdout.write("{}");
    return;
  }
  readStdinWithTimeout(2000)
    .then((raw) => {
      let input = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        process.stdout.write("{}");
        return;
      }
      // Guard: only fire on Skill tool. If matcher misroutes or a
      // future fallback path (per T0 §"Fallback path") delivers
      // non-Skill stdin, no-op.
      if (input.tool_name && input.tool_name !== "Skill") {
        process.stdout.write("{}");
        return;
      }
      const row = buildRow(input);
      if (!row.skill_name) {
        // No skill name extractable — nothing to record. Still {}.
        process.stdout.write("{}");
        return;
      }
      try {
        appendRow(row);
      } catch {
        // Best-effort telemetry; never block tool dispatch.
      }
      process.stdout.write("{}");
    })
    .catch(() => {
      process.stdout.write("{}");
    });
}

// Test surface
module.exports = { buildRow, extractSkillName, skillAuditDisabled, SCHEMA_VERSION };

if (require.main === module) {
  main();
}
