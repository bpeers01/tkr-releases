// Cap-hit nudge for Glob/Grep.
// Replaces Claude Code's generic truncation message with a tkr-flavored
// nudge pointing at `tkr search` (Glob) or head_limit=0 / path scoping
// (Grep). Single-message replacement — does NOT append on top of the
// native marker, avoiding double-nudge with EXPLORE_NUDGE.
//
// Source-confirmed caps:
//   Glob 100-file silent cap (src/tools/GlobTool/GlobTool.ts:157, sorted by mtime)
//   Grep 250-line default head_limit (src/tools/GrepTool/GrepTool.ts:108)
//
// Native markers (replaced verbatim):
//   "(Results are truncated. Consider using a more specific path or pattern.)"
//   "[Showing results with pagination = limit: N(, offset: M)?]"

const GLOB_TRUNC_MARKER =
  /\(Results are truncated\. Consider using a more specific path or pattern\.\)/;
const GREP_TRUNC_MARKER =
  /\[Showing results with pagination = limit: (\d+)(?:, offset: \d+)?\]/;

// gate(ctx) — pure decision (Phase 2b contract).
//   ctx.env: env-var bag
//   ctx.tool: tool name (e.g. "Glob", "Grep")
//   ctx.hasOutput: bool — caller pre-checks tool_response.text presence
function gate(ctx) {
  const env = (ctx && ctx.env) || {};
  if (env.TKR_CAP_NUDGE_DISABLED === "1") return false;
  const tool = ctx && ctx.tool;
  if (tool !== "Glob" && tool !== "Grep") return false;
  return !!(ctx && ctx.hasOutput);
}

function applyCapNudge(event, outputInfo) {
  if (
    !gate({
      env: process.env,
      tool: event && event.tool_name,
      hasOutput: !!(outputInfo && outputInfo.text),
    })
  ) {
    return null;
  }
  const toolName = event.tool_name;
  const text = outputInfo.text;

  if (toolName === "Glob" && GLOB_TRUNC_MARKER.test(text)) {
    const replacement =
      "[tkr] Glob hit 100-file cap (silent truncation, mtime-sorted). " +
      'Older files absent. Use `tkr search "..." --human` for trust-ranked ' +
      "cross-file lookup without caps, or narrow the path/pattern.";
    return text.replace(GLOB_TRUNC_MARKER, replacement);
  }

  if (toolName === "Grep") {
    const m = text.match(GREP_TRUNC_MARKER);
    if (m) {
      const limit = m[1];
      const replacement =
        `[tkr] Grep hit ${limit}-line cap (mtime-sorted). ` +
        "Older matches absent. Pass `head_limit=0` for unlimited, scope " +
        "`path:` tighter, or use `tkr search` for ranked context.";
      return text.replace(GREP_TRUNC_MARKER, replacement);
    }
  }

  return null;
}

module.exports = { gate, applyCapNudge, GLOB_TRUNC_MARKER, GREP_TRUNC_MARKER };
