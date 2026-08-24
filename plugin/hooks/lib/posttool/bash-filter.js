// Bash output compression paths:
//   1. tkr search output: strip internal JSON fields (chunk_id, score, trust_tier)
//   2. Other Bash output: pipe through `tkr filter-stdin "command"` for TOML matching
// Plus the shared extractToolText helper used by every dispatch path.

const { tkrSpawnSync } = require("./tkr-spawn");
const resident = require("../resident-client");

// Strip internal fields from tkr search JSON output
function stripSearchInternals(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return text;

    const cleaned = parsed.map((r) => {
      const out = {};
      if (r.doc_id) out.doc_id = r.doc_id;
      if (r.heading) out.heading = r.heading;
      if (r.snippet) out.snippet = r.snippet;
      if (r.trust_level) out.trust_level = r.trust_level;
      if (r.start_line) out.start_line = r.start_line;
      if (r.end_line) out.end_line = r.end_line;
      if (r.conflicts && r.conflicts.length) out.conflicts = r.conflicts;
      if (r.also_in && r.also_in.length) out.also_in = r.also_in;
      return out;
    });
    return JSON.stringify(cleaned);
  } catch {
    return text;
  }
}

// Pipe stdout through tkr filter-stdin for TOML filter matching.
// H-14: tkrSpawnSync = spawnSync + SIGKILL + 10MB maxBuffer (no shell).
// Previous execFileSync used SIGTERM on timeout which is a no-op on Windows.
//
// #209: async because the resident runtime is a socket round-trip. It is tried
// first and returns null for EVERY failure — disabled, absent, stale endpoint,
// upgraded binary, unreachable, slow — at which point this falls through to
// the spawn that has always been here. The resident path is an optimization,
// never a dependency.
//
// Timeout asymmetry is deliberate: the resident client's budget is ~750ms
// against the spawn's 5000ms, because a slow runtime costs its deadline ON TOP
// of the spawn we then have to do anyway. Fall back early, not late.
async function tryFilterStdin(command, stdout, opts = {}) {
  // #381 item 4 / #337 item 4: the real exit signal of the command whose
  // output is being filtered. The host only exposes a boolean (is_error),
  // not a numeric exit code, so 1 stands in for "nonzero" — enough for
  // ApplyFilter's stage 9 gate (exitCode == 0), which only distinguishes
  // success from failure. Threaded to both paths so they stay behaviorally
  // identical, per this function's own invariant above.
  const exitCode = opts.isError ? 1 : 0;
  try {
    const served = await resident.call("filter-stdin", command, stdout, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      exitCode,
    });
    if (served) {
      // Exit-code parity with the spawn path: tkrSpawnSync throws on any
      // non-zero status and this function's caller reads that as null
      // ("no filter matched"). A resident exit 1 must mean the same thing, or
      // the two paths disagree about identical input — and it must NOT fall
      // through to the spawn, which would redo work already done correctly.
      return served.exit === 0 ? served.body.toString("utf8") : null;
    }
  } catch {
    // fall through to the spawn
  }
  try {
    const args = exitCode
      ? ["filter-stdin", `--exit-code=${exitCode}`, command]
      : ["filter-stdin", command];
    return tkrSpawnSync(args, {
      input: stdout,
      timeout: 5000,
    });
  } catch {
    // Exit 1 = no filter match, or tkr not available — passthrough
    return null;
  }
}

// Flatten an MCP-style content array ([{type:"text",text}, ...]) to one string.
// Non-text blocks (images, embedded resources) carry no `.text` and are dropped.
function joinContentBlocks(blocks) {
  return blocks
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractToolText(event) {
  const response = event.tool_response || {};
  // MCP tools hand PostToolUse a BARE array as tool_response — not the
  // {content:[...]} wrapper the branch below expects. Verified live against
  // Claude Code 2.1.241; see docs/reports/2026-08-23-mcp-response-compression-feasibility.md.
  // Without this branch every mcp__* call extracts to null.
  if (Array.isArray(event.tool_response)) {
    const text = joinContentBlocks(event.tool_response);
    if (text) return { field: "content", text, rootArray: true };
    return null;
  }
  if (typeof response.stdout === "string") {
    return { field: "stdout", text: response.stdout };
  }
  if (typeof response.output === "string") {
    return { field: "output", text: response.output };
  }
  if (typeof response.content === "string") {
    return { field: "content", text: response.content };
  }
  if (Array.isArray(response.content)) {
    const parts = response.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return {
        field: "content",
        text: parts.join("\n\n"),
        asArray: true,
      };
    }
  }
  return null;
}

module.exports = { stripSearchInternals, tryFilterStdin, extractToolText };
