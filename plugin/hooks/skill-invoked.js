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
// Output contract: empty `{}` on stdout in the common case. As of
// INV-095 this hook is no longer PURE observability — it also gates
// oversized bundled-skill payloads (see hooks/lib/skill-bundle.js):
//
//   ask (default) -> permissionDecision:"ask"; the human decides, and
//                    the reason carries the on-disk index so a "no"
//                    still leaves the model able to act. Measured fire
//                    rate is 3.2% of Skill dispatches (5 of 156 across
//                    314 sessions), so this is a targeted interruption.
//   warn          -> `{systemMessage}`; the call proceeds. The warning
//                    goes to the USER, not the model, because the
//                    payload is landing anyway and narrating it into
//                    context would only add to the bill.
//   deny          -> block + permissionDecision:"deny", carrying a
//                    redirect that names the on-disk tree so the model
//                    can read the one file it needs.
//
// A Claude Code build that does not understand "ask" ignores the field
// and the call proceeds — the same fail-open direction every other path
// here takes.
//
// A manual `/skill` invocation is NEVER gated — that is the escape
// hatch the denial text points at, so gating it would be circular.
// Gate kill switch: TKR_SKILL_GATE=off (or TKR_SKILL_GATE_DISABLED=1).
//
// Telemetry is emitted BEFORE the gate decision so the ledger records
// the invocation regardless of whether the call was blocked — the same
// ordering agent-search-inject.js uses for its spawn veto.

"use strict";

const fs = require("fs");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { rotateIfLarge } = require("./lib/rotate-jsonl");
const { stateDir } = require("./lib/state-dir");
const { resolveInvocationSource } = require("./lib/slash-marker");
const skillBundle = require("./lib/skill-bundle");

// v1 -> v2: invocation_source is now resolved rather than always
// "unknown". The signal comes from a per-turn marker the
// UserPromptSubmit hook writes when the prompt is a slash command, so
// the resolution costs one small file read instead of the transcript
// scan the <10ms budget could not afford. Readers use the version to
// tell "this writer could not decide" from "this writer decided auto".
// v2 -> v3: adds the INV-095 gate fields — `bundle_tokens`,
// `bundle_files`, `gate_mode`, `gate_action`. All four are written ONLY
// when the skill has a bundled reference tree on disk, so their absence
// on a v3 row means "this skill ships no bundle" (a fact), while their
// absence on a v2-or-earlier row means the writer predated the concept
// and cannot be read as "no bundle". Same additive discipline as the
// task-spawns veto fields.
const SCHEMA_VERSION = 3;

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

function buildRow(input, gateInfo) {
  const skill = extractSkillName(input);
  const sid = (input && input.session_id) || "";
  // "unknown" survives only as the no-skill-name case: with nothing to
  // match a marker against, the question cannot be asked at all. Every
  // other row now carries a real answer — see hooks/lib/slash-marker.js
  // on why "auto" is the honest default rather than a hedge.
  const source = skill
    ? resolveInvocationSource(skill, sid, (input && input.prompt_id) || "")
    : "unknown";
  const row = {
    ts: new Date().toISOString(),
    event: "skill-invoked",
    skill_name: skill,
    invocation_source: source || "unknown",
    session_id: sid,
    schema_version: SCHEMA_VERSION,
  };
  // All-or-nothing: a row either carries the full gate picture or none
  // of it. A partial row would let a reader divide by a denominator that
  // was never measured.
  if (gateInfo && gateInfo.bundle) {
    row.bundle_tokens = gateInfo.bundle.tokens;
    row.bundle_files = gateInfo.bundle.files;
    row.gate_mode = gateInfo.mode;
    row.gate_action = gateInfo.action;
  }
  return row;
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
      const skill = extractSkillName(input);
      if (!skill) {
        // No skill name extractable — nothing to record, nothing to
        // gate. Still {}.
        process.stdout.write("{}");
        return;
      }

      // Measure + decide. Every failure here means the gate COULD NOT
      // RUN, which must read as "allow": a machine whose temp dir is
      // unreadable must not lose the ability to invoke skills.
      let gateInfo = null;
      try {
        const bundle = skillBundle.bundleFor(skill);
        if (bundle) {
          const verdict = skillBundle.gate({
            env: process.env,
            source: resolveInvocationSource(
              skill,
              (input && input.session_id) || "",
              (input && input.prompt_id) || ""
            ),
            bundleTokens: bundle.tokens,
          });
          gateInfo = { bundle, mode: verdict.mode, action: verdict.action, threshold: verdict.threshold };
        }
      } catch {
        gateInfo = null;
      }

      const row = buildRow(input, gateInfo);
      try {
        appendRow(row);
      } catch {
        // Best-effort telemetry; never block tool dispatch.
      }

      if (gateInfo && gateInfo.action === "deny") {
        // Both response forms for Claude Code version compat, per
        // hooks/CLAUDE.md § Hook contract. No updatedInput on a deny.
        const detail = skillBundle.buildRedirect(skill, gateInfo.bundle);
        process.stdout.write(
          JSON.stringify({
            decision: "block",
            reason: detail,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: detail,
            },
          })
        );
        return;
      }

      if (gateInfo && gateInfo.action === "ask") {
        // No top-level `decision`/`reason` here: those mean BLOCK, and
        // an ask is not a block. Only the newer hookSpecificOutput form
        // can express it, so an older build simply proceeds.
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
              permissionDecisionReason: skillBundle.buildAskReason(skill, gateInfo.bundle),
            },
          })
        );
        return;
      }

      if (gateInfo && gateInfo.action === "warn") {
        // systemMessage renders to the user and never enters model
        // context — the whole point of warn mode.
        process.stdout.write(
          JSON.stringify({
            systemMessage: skillBundle.buildWarning(skill, gateInfo.bundle, gateInfo.threshold),
          })
        );
        return;
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
