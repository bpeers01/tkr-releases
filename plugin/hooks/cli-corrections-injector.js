#!/usr/bin/env node
// tkr PostToolUse hook (Bash matcher) — injects matching cli-corrections
// guidance when a Bash command fails. Reads .claude/rules/cli-corrections.md
// as a data file; the file's `paths: __tkr_disabled__/**` frontmatter
// keeps it from auto-pinning. This hook surfaces relevant lines on demand.
//
// Output: `{}` when no match, otherwise
//   {"hookSpecificOutput": {"hookEventName": "PostToolUse",
//                           "additionalContext": "..."}}
//
// Failure detection: tool_response.is_error || interrupted || stdout starts
// with /Exit code [1-9]/ || stderr non-empty AND no stdout.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { readJSONSync, writeJSONAtomic } = require("./lib/safe-json");
const { stateDir } = require("./lib/state-dir");

const TKR_STATE_DIR = stateDir();
const DEBUG_LOG = path.join(TKR_STATE_DIR, "cli-corrections-debug.log");
const CACHE_FILE = path.join(TKR_STATE_DIR, "cli-corrections-path.json");
const MAX_MATCHES = parseInt(process.env.TKR_CLI_CORR_MAX || "3", 10);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// M-14: cache findCorrectionsFile per process so we don't re-walk parents on
// every Bash failure. Also a 5min negative cache when no corrections file
// exists in the tree — avoids hammering the FS on every Bash call.
let CORR_FILE_CACHE = null;
let CORR_FILE_CACHE_AT = 0;
const CORR_NEG_CACHE_MS = 5 * 60 * 1000;

function debugLog(msg) {
  if (process.env.TKR_CLI_CORR_DEBUG !== "1") return;
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// Compute SHA1 hash of the cwd to use as a stable cache key.
function cwdHash(cwd) {
  return crypto.createHash("sha1").update(cwd || process.cwd()).digest("hex");
}

// Read the persistent cache from disk. Returns object mapping cwd-hash to
// {path, resolved_at}. Tolerates missing/corrupt JSON gracefully.
function readDiskCache() {
  return readJSONSync(CACHE_FILE) || {};
}

// Check if a cached entry is stale (older than 24h).
function isCacheStale(resolvedAt) {
  if (!resolvedAt) return true;
  try {
    const ts = new Date(resolvedAt).getTime();
    return Date.now() - ts > CACHE_TTL_MS;
  } catch {
    return true;
  }
}

// Write a positive result to the persistent disk cache.
function writeDiskCacheEntry(cwd, filePath) {
  try {
    const diskCache = readDiskCache();
    const key = cwdHash(cwd);
    diskCache[key] = {
      path: filePath,
      resolved_at: new Date().toISOString(),
    };
    writeJSONAtomic(CACHE_FILE, diskCache);
  } catch {
    // best-effort
  }
}

// Find .claude/rules/cli-corrections.md by walking up from cwd.
// M-14: per-process cache + 5min negative cache + persistent disk cache
// (24h TTL) to avoid re-walking on subsequent invocations.
function findCorrectionsFile(cwd) {
  const actualCwd = cwd || process.cwd();

  // Cached positive result: re-use unconditionally (file path doesn't change
  // for a given hook process lifetime).
  if (CORR_FILE_CACHE) return CORR_FILE_CACHE;

  // Cached negative result: re-check after 5min in case repo state changes.
  if (CORR_FILE_CACHE === false && Date.now() - CORR_FILE_CACHE_AT < CORR_NEG_CACHE_MS) {
    return null;
  }

  // Check persistent disk cache (24h TTL).
  const diskCache = readDiskCache();
  const cacheKey = cwdHash(actualCwd);
  const cacheEntry = diskCache[cacheKey];
  if (cacheEntry && !isCacheStale(cacheEntry.resolved_at)) {
    const filePath = cacheEntry.path;
    if (fs.existsSync(filePath)) {
      CORR_FILE_CACHE = filePath;
      CORR_FILE_CACHE_AT = Date.now();
      return filePath;
    }
    // Cached path no longer exists; fall through to walk.
  }

  // Walk up from cwd looking for corrections file.
  let dir = actualCwd;
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, ".claude", "rules", "cli-corrections.md");
    if (fs.existsSync(cand)) {
      CORR_FILE_CACHE = cand;
      CORR_FILE_CACHE_AT = Date.now();
      // Persist positive result to disk.
      writeDiskCacheEntry(actualCwd, cand);
      return cand;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No file found; set negative cache (in-process only, not persisted).
  CORR_FILE_CACHE = false;
  CORR_FILE_CACHE_AT = Date.now();
  return null;
}

// Parse cli-corrections.md → array of {cmd, error, line}.
function parseCorrections(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  // Strip frontmatter
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) text = text.slice(end + 4);
  }
  const out = [];
  // Match: - `<cmd>` fails often with: <error> (NNNx, NN sessions)[. <suggestion>]
  const re = /^- `([^`]+)` fails often with:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ cmd: m[1].trim(), error: m[2].trim(), line: m[0] });
  }
  return out;
}

function isFailure(toolResponse, command) {
  if (!toolResponse || typeof toolResponse !== "object") return false;
  if (toolResponse.is_error === true || toolResponse.interrupted === true) return true;
  const stdout = String(toolResponse.stdout || toolResponse.output || "");
  const stderr = String(toolResponse.stderr || "");
  if (/^Exit code [1-9]/m.test(stdout)) return true;
  if (stderr && !stdout) return true;
  return false;
}

// Extract first command token (e.g. "git" from "git push origin main").
// Handles `tkr <cmd>` prefix — strips tkr to surface the underlying tool.
function commandToken(command) {
  if (!command || typeof command !== "string") return "";
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0) return "";
  let head = tokens[0];
  // Strip env-var prefixes like FOO=bar baz
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  if (i < tokens.length) head = tokens[i];
  // Strip "tkr <real-cmd>" prefix
  if (head === "tkr" && i + 1 < tokens.length) head = tokens[i + 1];
  return head;
}

function findMatches(corrections, cmdToken, errorText) {
  if (!cmdToken) return [];
  // Lowercase + strip placeholder tokens (`<path>`, `<N>`, `<hash>`) so
  // they don't break substring containment against real error output.
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/<[^>]+>/g, " ")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const errorNorm = norm(errorText);
  const matches = [];
  for (const c of corrections) {
    if (c.cmd !== cmdToken) continue;
    let score = 1;
    if (errorNorm && c.error) {
      const snippet = norm(c.error.split("(")[0]);
      if (snippet) {
        // Take a meaningful prefix (first 3 alphabetic words) for matching.
        const head = snippet.split(" ").filter(Boolean).slice(0, 3).join(" ");
        if (head && errorNorm.includes(head)) score = 2;
      }
    }
    matches.push({ ...c, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_MATCHES);
}

function buildContext(matches, cmdToken) {
  if (matches.length === 0) return "";
  const lines = matches.map((m) => `- ${m.line.replace(/^- /, "")}`);
  return (
    `tkr cli-corrections — \`${cmdToken}\` has failed before in this project:\n` +
    lines.join("\n") +
    `\n(${matches.length} match${matches.length === 1 ? "" : "es"} from .claude/rules/cli-corrections.md.` +
    ` Run \`tkr learn\` to refresh patterns.)`
  );
}

function processEvent(event) {
  if (!event || event.tool_name !== "Bash") return null;
  const command = (event.tool_input || {}).command;
  if (!command) return null;
  if (!isFailure(event.tool_response, command)) return null;

  const file = findCorrectionsFile(event.cwd);
  if (!file) {
    debugLog("no cli-corrections.md found");
    return null;
  }

  const corrections = parseCorrections(file);
  if (corrections.length === 0) return null;

  const token = commandToken(command);
  const errText =
    String((event.tool_response || {}).stdout || "") +
    String((event.tool_response || {}).stderr || "");
  const matches = findMatches(corrections, token, errText);
  if (matches.length === 0) return null;

  const ctx = buildContext(matches, token);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ctx,
    },
  };
}

if (require.main === module) {
  // CR-06 + M-12: stdin timeout + master kill switch.
  if (hooksDisabled()) {
    process.stdout.write("{}");
  } else {
    readStdinWithTimeout(3000)
      .then((inputRaw) => {
        let event = {};
        try {
          event = JSON.parse(inputRaw || "{}");
        } catch {
          process.stdout.write("{}");
          return;
        }
        try {
          const result = processEvent(event);
          if (result) process.stdout.write(JSON.stringify(result));
          else process.stdout.write("{}");
        } catch (err) {
          debugLog(`processEvent threw: ${err.message}`);
          process.stdout.write("{}");
        }
      })
      .catch(() => {
        process.stdout.write("{}");
      });
  }
}

module.exports = {
  parseCorrections,
  isFailure,
  commandToken,
  findMatches,
  buildContext,
  processEvent,
  findCorrectionsFile,
  cwdHash,
  readDiskCache,
  isCacheStale,
  writeDiskCacheEntry,
  CACHE_FILE,
  CACHE_TTL_MS,
};
