// hooks/lib/stage-trace.js
//
// Per-stage timing for the UserPromptSubmit hot path (INV-085 step 2).
// Measurement only — this module changes no hook behavior.
//
// ── Why an end-of-run report would not have worked ──────────────────────────
//
// The event we are trying to attribute is Claude Code SIGKILLing the hook at
// its 10s ceiling. A tracer that accumulates marks in memory and writes them
// when the hook finishes writes NOTHING on exactly the runs we care about, and
// we would have shipped a second instrument with INV-085's own blind spot:
// `classify-timeouts.jsonl` already fails this way — 984 rows in normal
// operation, zero within +/-60s of any of the nine 2026-08-19 cancellations,
// because the process was killed before it could append.
//
// So the trace is a BREADCRUMB, not a report. Each mark is appended to a small
// per-session file the moment the stage is entered. If the hook completes, the
// file is unlinked and (below the threshold) nothing durable is written at all.
// If the hook is killed, the file survives with the stage it died in as its
// last line, and the NEXT run for that session promotes it to the durable
// ledger as an `abandoned` row. Attribution costs one extra file read per
// prompt and survives a kill -9, which an in-memory report cannot.
//
// ── Cost, and why it is opt-in ──────────────────────────────────────────────
//
// One appendFileSync of ~60-100 bytes per mark (8 marks), one read, one
// unlink. Well inside the hook's <100ms budget, and cheap next to the thing it
// measures: a process creation under the load in question costs 4-6s, an
// append costs a fraction of a millisecond.
//
// OFF by default (TKR_HOOK_STAGE_TRACE=1 to enable), per hooks/CLAUDE.md:
// pure-observability writes are env-gated. The argument for flipping it on —
// these cancellations appear a handful of times a week, on a box nobody is
// watching, so a trace you must enable in advance may never see one — is real
// but does not apply to how this gets used. INV-085's re-verification is a
// PROVOKED run (step 4: drive concurrency to the 2026-08-16 condition of 11+
// sessions and read the ledger afterwards), and provoking it means setting the
// variable first. An operator who does want passive capture sets it once in
// their environment, which is the same effect without making every install pay
// for one box's investigation.
//
// Enable:    TKR_HOOK_STAGE_TRACE=1
// Threshold: TKR_HOOK_STAGE_TRACE_MS (default 1000) — a completed run below it
//            appends nothing, so the durable ledger stays quiet in steady
//            state even while tracing is on.
//
// Singleton state is correct here: the hook is a one-shot process, and marks
// are emitted from several modules (runMain, routeInjectContext) that would
// otherwise have to thread a tracer object through every call site.

"use strict";

const fs = require("fs");
const path = require("path");
const { stateDir } = require("./state-dir");

const SCHEMA = 1;
const DEFAULT_THRESHOLD_MS = 1000;

let st = null;

function enabled() {
  return process.env.TKR_HOOK_STAGE_TRACE === "1";
}

function thresholdMs() {
  const v = Number(process.env.TKR_HOOK_STAGE_TRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_THRESHOLD_MS;
}

function inFlightDir() {
  return path.join(stateDir(), "stage");
}

function ledgerPath() {
  return path.join(stateDir(), "hook-stages.jsonl");
}

// safeSid keeps the in-flight filename inside one directory. A session id is
// already a UUID in practice, but this file is named from hook input and a
// path separator arriving here would write outside inFlightDir().
function safeSid(sid) {
  const s = String(sid || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return s ? s.slice(0, 80) : "nosid";
}

function appendLedger(row) {
  try {
    const target = ledgerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Shared-file convention (see spawn-bounded.js): whoever appends rotates.
    try {
      const { rotateIfLarge } = require("./rotate-jsonl");
      rotateIfLarge(target);
    } catch {
      // best-effort
    }
    fs.appendFileSync(target, JSON.stringify(row) + "\n");
  } catch {
    // Observability must never fail the prompt path.
  }
}

// promoteOrphan reads a leftover in-flight file and records it as an
// `abandoned` run. Its last line names the stage the previous run was inside
// when it died — the whole point of the file existing.
//
// Note what this row does NOT claim: the elapsed figure is measured at stage
// ENTRY, not at death, so it is a lower bound on where the time went, never a
// duration. The matching `durationMs` comes from the transcript's
// hook_cancelled record (scripts/session_analysis/hook_cancel_scan.py); this
// row supplies the stage that record cannot see. Joining the two is the
// attribution — neither half is it alone.
function promoteOrphan(file, sid, hook) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // No orphan (the common case) or unreadable — either way, nothing to do.
  }
  try {
    const lines = String(raw).trim().split("\n").filter(Boolean);
    if (!lines.length) return;
    const marks = [];
    for (const line of lines) {
      try {
        marks.push(JSON.parse(line));
      } catch {
        // Torn final write — a killed process can leave a partial line.
        // Skipping it is right: the surviving marks are still the evidence.
      }
    }
    if (!marks.length) return;
    const last = marks[marks.length - 1];
    appendLedger({
      schema: SCHEMA,
      kind: "abandoned",
      ts: new Date().toISOString(),
      session_id: sid,
      hook,
      died_in_stage: last && last.stage ? last.stage : "",
      entered_at_ms: last && typeof last.at_ms === "number" ? last.at_ms : null,
      started: marks[0] && marks[0].started ? marks[0].started : "",
      pid: marks[0] && marks[0].pid ? marks[0].pid : null,
      stages: marks.map((m) => [m.stage, m.at_ms]),
      torn_lines: lines.length - marks.length,
    });
  } catch {
    // best-effort
  }
}

// start opens a trace for this hook run. Safe to call more than once; the
// second call is ignored rather than resetting the clock.
function start(sid, hook) {
  if (st) return;
  if (!enabled()) return;
  try {
    const dir = inFlightDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeSid(sid) + ".jsonl");
    // Promote BEFORE truncating: this file, if present, belongs to the
    // previous run for this session, and that run did not reach done().
    promoteOrphan(file, String(sid || ""), hook);
    try {
      fs.unlinkSync(file);
    } catch {
      // Absent is the normal case.
    }
    st = {
      sid: String(sid || ""),
      hook: String(hook || ""),
      t0: Date.now(),
      started: new Date().toISOString(),
      file,
      marks: [],
    };
    mark("start");
  } catch {
    st = null;
  }
}

// mark records entering a stage. No-op when tracing is off or start() was
// never called, so call sites need no guard of their own.
function mark(stage) {
  if (!st) return;
  try {
    const at = Date.now() - st.t0;
    st.marks.push([String(stage), at]);
    fs.appendFileSync(
      st.file,
      JSON.stringify({
        stage: String(stage),
        at_ms: at,
        pid: process.pid,
        started: st.started,
      }) + "\n",
    );
  } catch {
    // best-effort
  }
}

// done closes the trace: a slow-but-completed run is recorded, a normal run
// leaves nothing behind but the unlink.
function done() {
  if (!st) return;
  const cur = st;
  st = null;
  try {
    const total = Date.now() - cur.t0;
    if (total >= thresholdMs()) {
      appendLedger({
        schema: SCHEMA,
        kind: "slow",
        ts: new Date().toISOString(),
        session_id: cur.sid,
        hook: cur.hook,
        total_ms: total,
        started: cur.started,
        pid: process.pid,
        stages: cur.marks,
      });
    }
  } catch {
    // best-effort
  }
  try {
    fs.unlinkSync(cur.file);
  } catch {
    // best-effort
  }
}

// active is for tests: whether a trace is currently open.
function active() {
  return st !== null;
}

module.exports = { start, mark, done, active, ledgerPath, inFlightDir };
