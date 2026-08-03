// CACHE-002 — cache-bust detector
//
// Watches Edit/Write tool calls on cache-critical files (CLAUDE.md,
// MEMORY.md, .claude/rules/*, .claude/settings*.json, plugin.json).
// On hit, emits an inline warning so Claude knows the prefix-cache was
// just invalidated and can suggest /clear or new session before the
// rest of the conversation re-reads the prefix uncached.
//
// State: per-session bust count at $TKR_STATE_DIR/cache-bust-<sid>.json.
// Escalates wording at >=3 consecutive busts in one session.
//
// INV-026 (2026-05-20): pattern matches are scoped by path category so
// source-repo edits to a plugin author's own files don't false-positive.
// `.claude-plugin/plugin.json` only busts when under `~/.claude/plugins/`
// (installed copy) or `~/.claude-plugin/` (user-level). Project-level
// cache files (CLAUDE.md, AGENTS.md, rules, settings, MEMORY.md) only
// bust when under the active project cwd OR under `~/.claude/`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { stateDir } = require("./lib/state-dir");

const TKR_STATE_DIR = stateDir();

// Rule categories:
//   project-or-home     — file is in cache-prefix only when under the
//                         active project cwd OR under ~/.claude/.
//   installed-plugin    — file is in cache-prefix only when under
//                         ~/.claude/plugins/ or ~/.claude-plugin/.
//                         A source-repo `<repo>/.claude-plugin/plugin.json`
//                         doesn't affect the running session's cache
//                         (the session loaded the installed copy).
const CACHE_CRITICAL_RULES = [
  // Top-level / nested CLAUDE.md (project + zone)
  { pattern: /(^|[\/\\])CLAUDE\.md$/i, scope: "project-or-home" },
  // Auto-memory MEMORY.md (loaded into every turn)
  { pattern: /(^|[\/\\])MEMORY\.md$/i, scope: "project-or-home" },
  // .claude/rules/*.md path-scoped rules
  { pattern: /[\/\\]\.claude[\/\\]rules[\/\\][^\/\\]+$/i, scope: "project-or-home" },
  // .claude/settings*.json (settings.json, settings.local.json)
  { pattern: /[\/\\]\.claude[\/\\]settings[^\/\\]*\.json$/i, scope: "project-or-home" },
  // .claude-plugin/plugin.json — plugin manifest mounted at session start
  { pattern: /[\/\\]\.claude-plugin[\/\\]plugin\.json$/i, scope: "installed-plugin" },
  // AGENTS.md — treated as part of CLAUDE.md chain via @-import
  { pattern: /(^|[\/\\])AGENTS\.md$/i, scope: "project-or-home" },
];

// Back-compat: bare patterns array for callers / tests that import it.
const CACHE_CRITICAL_PATTERNS = CACHE_CRITICAL_RULES.map((r) => r.pattern);

const ESCALATION_THRESHOLD = 3;

// normalizePath collapses separators and applies case-folding on Windows
// so prefix comparisons survive `C:\Users\...` vs `c:/users/...` mixed
// shapes in hook payloads.
function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  const norm = path.normalize(p).replace(/\\/g, "/");
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

// pathStartsWith returns true when `target` is `prefix` itself or a
// descendant of `prefix`, honoring separator boundaries. "/repo" must
// not match "/repository".
function pathStartsWith(target, prefix) {
  const t = normalizePath(target);
  const p = normalizePath(prefix);
  if (!t || !p) return false;
  if (t === p) return true;
  const withSep = p.endsWith("/") ? p : p + "/";
  return t.startsWith(withSep);
}

// isInScope returns true when `fp` is in a cache-prefix path for `scope`.
// `cwd` is the active project cwd from the hook payload; `home` is the
// resolved user-home dir. Either may be empty — scope check fails closed
// when the relevant signal is absent.
function isInScope(fp, scope, cwd, home) {
  if (scope === "installed-plugin") {
    if (!home) return false;
    const installed = path.join(home, ".claude", "plugins");
    const userPlugin = path.join(home, ".claude-plugin");
    return pathStartsWith(fp, installed) || pathStartsWith(fp, userPlugin);
  }
  if (scope === "project-or-home") {
    if (cwd && pathStartsWith(fp, cwd)) return true;
    if (home && pathStartsWith(fp, path.join(home, ".claude"))) return true;
    return false;
  }
  // Unknown scope: fail open so a future category addition isn't silent.
  return true;
}

// isCacheBustEdit returns the matched file path if the event is an
// Edit/Write/MultiEdit on a cache-critical file IN the active prefix
// scope, null otherwise. Reads event.cwd for project-scope checks and
// os.homedir() for user-level checks.
function isCacheBustEdit(event) {
  if (!event || typeof event !== "object") return null;
  const tool = event.tool_name;
  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") return null;
  const fp = event.tool_input && event.tool_input.file_path;
  if (!fp || typeof fp !== "string") return null;
  const cwd = typeof event.cwd === "string" ? event.cwd : "";
  const home = os.homedir();
  for (const rule of CACHE_CRITICAL_RULES) {
    if (rule.pattern.test(fp) && isInScope(fp, rule.scope, cwd, home)) return fp;
  }
  return null;
}

// bustStateFile returns the per-session state file path. sessionID may
// be empty/null — falls back to "default" so warnings still emit.
function bustStateFile(sessionID) {
  const sid = sessionID && String(sessionID).trim() ? String(sessionID).trim() : "default";
  return path.join(TKR_STATE_DIR, `cache-bust-${sid}.json`);
}

// recordBustEvent increments the per-session bust counter and returns
// the new count. Best-effort — returns 1 if state read/write fails.
function recordBustEvent(sessionID, filePath) {
  const file = bustStateFile(sessionID);
  let prev = { count: 0, paths: [] };
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof prev.count !== "number") prev.count = 0;
    if (!Array.isArray(prev.paths)) prev.paths = [];
  } catch {
    // First bust this session — file missing or malformed.
  }
  const count = prev.count + 1;
  // defense: cap before spread
  const paths = [...prev.paths.slice(-100), filePath].slice(-5);
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    // M-10: atomic tmp+rename. Multiple Edit/Write fires can race here;
    // unrenamed writes leave the file half-written and the next read
    // returns count=0 — over-firing the warning.
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ count, paths }));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort — never fail the hook for telemetry.
  }
  return count;
}

// formatBustWarning produces the inline warning text. Wording escalates
// at ESCALATION_THRESHOLD consecutive busts in one session.
function formatBustWarning(filePath, count) {
  const basename = filePath.split(/[\/\\]/).pop() || filePath;
  if (count >= ESCALATION_THRESHOLD) {
    return (
      `[tkr cache-bust #${count}] ${basename} edited again — prefix cache ` +
      `invalidated ${count}× this session. Rest of conversation will ` +
      `re-read the full prefix uncached. Strongly consider \`/clear\` ` +
      `or a fresh session before continuing.`
    );
  }
  return (
    `[tkr cache-bust] ${basename} edited — prefix cache invalidated. ` +
    `Rest of session re-reads full prefix uncached. Consider \`/clear\` ` +
    `or new session if more edits planned.`
  );
}

// checkCacheBust is the hook entry point. Returns warning text or null.
function checkCacheBust(event, sessionID) {
  const fp = isCacheBustEdit(event);
  if (!fp) return null;
  const count = recordBustEvent(sessionID, fp);
  return formatBustWarning(fp, count);
}

module.exports = {
  CACHE_CRITICAL_PATTERNS,
  CACHE_CRITICAL_RULES,
  ESCALATION_THRESHOLD,
  isCacheBustEdit,
  isInScope,
  pathStartsWith,
  recordBustEvent,
  formatBustWarning,
  checkCacheBust,
};
