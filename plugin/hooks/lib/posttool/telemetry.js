// PostToolUse compression telemetry — appends one line per compression
// event to telemetry-history.jsonl. Best-effort; never blocks hook exit.
//
// TEL-001: rotates before append per the hooks/CLAUDE.md hot-path rule.
// The cap MUST match internal/telemetry HistoryMaxBytes — the Go Flush
// path appends to the same file with the same rotation semantics, and
// the statusline tail-reader sizes its read to this cap.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");
const { rotateIfLarge } = require("../rotate-jsonl");

// Matches internal/telemetry/telemetry.go HistoryMaxBytes. Test override:
// TKR_TELEMETRY_MAX_BYTES (same env the Go side honors).
const TELEMETRY_MAX_BYTES = 2 * 1024 * 1024;

function telemetryCap() {
  const v = Number(process.env.TKR_TELEMETRY_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : TELEMETRY_MAX_BYTES;
}

// Counterfactual clamp — MUST match internal/util CounterfactualCapBytes
// (same default, same TKR_COUNTERFACTUAL_CAP_BYTES override, 0 disables):
// bytes past the harness per-result truncation budget never reach the
// model, with or without tkr, so they must not be booked as saved.
const COUNTERFACTUAL_CAP_BYTES = 30000;

function clampCounterfactual(n) {
  let cap = COUNTERFACTUAL_CAP_BYTES;
  const v = process.env.TKR_COUNTERFACTUAL_CAP_BYTES;
  if (v !== undefined && v !== "") {
    const parsed = Number(v);
    if (Number.isInteger(parsed) && parsed >= 0) cap = parsed;
  }
  return cap > 0 && n > cap ? cap : n;
}

// hostOutputCapBytes is the counterfactual cap layered with
// BASH_MAX_OUTPUT_LENGTH — Claude Code's own env var for the host's
// actual configured Bash-result truncation threshold (#337 P0-1).
// TKR_COUNTERFACTUAL_CAP_BYTES still wins outright when set (explicit
// override, tests); absent that, the host's real configured value beats
// the hardcoded default whenever the two diverge. Mirrors
// internal/util.HostOutputCapBytes — MUST match.
function hostOutputCapBytes() {
  const override = process.env.TKR_COUNTERFACTUAL_CAP_BYTES;
  if (override !== undefined && override !== "") {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  const hostCap = Number(process.env.BASH_MAX_OUTPUT_LENGTH);
  if (Number.isInteger(hostCap) && hostCap > 0) return hostCap;
  return COUNTERFACTUAL_CAP_BYTES;
}

// Record a telemetry event to the JSONL history file.
// Appending a single short line is atomic on all platforms (well under 4KB).
//
// #337 P0-1: the host's truncate-to-file-and-preview behavior fires off
// bytesBefore (the RAW size) alone, before a filtered replacement is
// ever considered — above hostOutputCapBytes(), the replacement is
// discarded outright and the model sees the host's own treatment
// whether or not tkr ran. No real saving occurred in that case, and
// bytesAfter plays no part in that fact: clamping it too (the previous
// symmetric clamp) still booked a positive `cap - bytesAfter` saving for
// an event that never happened.
function recordTelemetry(stream, bytesBefore, bytesAfter, detail) {
  try {
    const cap = hostOutputCapBytes();
    const hostCapExceeded = cap > 0 && bytesBefore > cap;
    const saved = hostCapExceeded
      ? 0
      : Math.max(0, bytesBefore - bytesAfter);
    // Forced past the zero-saving skip when the host cap explains the
    // zero: that case is diagnostically interesting (compression ran and
    // was thrown away) rather than "nothing happened here".
    if (saved === 0 && !hostCapExceeded) return;
    const entry = {
      stream: stream,
      bytes_saved: saved,
      tokens_saved: Math.floor(saved / 4),
      detail: detail.substring(0, 80),
      timestamp: new Date().toISOString(),
    };
    if (hostCapExceeded) entry.reason = "host_cap_exceeded";
    const dir = stateDir();
    const historyPath = path.join(dir, "telemetry-history.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    rotateIfLarge(historyPath, telemetryCap());
    fs.appendFileSync(historyPath, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort — never fail the hook for telemetry
  }
}

module.exports = {
  recordTelemetry,
  clampCounterfactual,
  hostOutputCapBytes,
  TELEMETRY_MAX_BYTES,
};
