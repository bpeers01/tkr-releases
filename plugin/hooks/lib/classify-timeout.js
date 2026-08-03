// hooks/lib/classify-timeout.js
//
// INV-073 — evidence marker for a classify killed by the hook budget.
//
// hooks/user-prompt-submit.js runs `tkr route classify` synchronously
// under ROUTE_SYNC_TIMEOUT_MS (default 250ms). When spawnSync kills it,
// no decisions.jsonl row and no route state is ever written, and the
// plan-denominated funnel (cmd/tkr/cmd_route_funnel.go) cannot tell
// "no routable work in this window" from "evidence destroyed by the
// timeout". This module writes one JSONL row per kill so the funnel can
// report the loss as a counter instead of silently absorbing it.
//
// Row shape (all fields always present):
//   {"ts":"<ISO8601>","session_id":"<sid>","timeout_ms":250,
//    "source":"user-prompt-submit"}
//
// The ledger lives in the SAME directory as decisions.jsonl — the tkr
// state dir (hooks/lib/state-dir.js; Go mirror internal/state/dir.go) —
// so the Go reader (internal/signals.ClassifyTimeoutsPath) resolves the
// same file the writer appended. Do not invent a second path convention.
//
// Best-effort: any failure is swallowed. This runs on the
// UserPromptSubmit hot path, and an observability write must never
// delay or crash the hook.

"use strict";

const fs = require("fs");
const path = require("path");

const { stateDir } = require("./state-dir");
const { rotateIfLarge } = require("./rotate-jsonl");

function classifyTimeoutsPath() {
  return path.join(stateDir(), "classify-timeouts.jsonl");
}

// appendClassifyTimeout appends one marker row. Never throws.
function appendClassifyTimeout(record) {
  try {
    if (!record || typeof record !== "object") return;
    const row = {
      ts: new Date().toISOString(),
      session_id: String(record.session_id || ""),
      timeout_ms: Number(record.timeout_ms) || 0,
      source: String(record.source || "user-prompt-submit"),
    };
    const target = classifyTimeoutsPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfLarge(target);
    fs.appendFileSync(target, JSON.stringify(row) + "\n");
  } catch {
    // best-effort — a full disk or bad env must not break the hook
  }
}

module.exports = { appendClassifyTimeout, classifyTimeoutsPath };
