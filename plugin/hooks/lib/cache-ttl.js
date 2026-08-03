// hooks/lib/cache-ttl.js — PLAN-1 (Wave-0, v3.13.1).
//
// detectTTL(sessionId, opts) infers the active prompt-cache TTL for a
// Claude Code session by reading the session JSONL transcript at
// ~/.claude/projects/<proj>/<sid>.jsonl.
//
// Returns: { ttl_seconds, source, idle_gap_observed_secs }
//   ttl_seconds:              300 | 3600 | <user>
//   source:                   "config" | "direct" | "inferred" | "default"
//   idle_gap_observed_secs:   N when source="inferred"; 0 otherwise
//
// Order of preference:
//   1. config override     env TKR_CACHE_TTL_SECONDS or [cache] ttl_seconds
//                          in ~/.config/tkr/config.toml (or platform equivalent)
//   2. cached inference    ~/.tkr/session-state/<sid>/cache-ttl.json, fresh <24h
//   3. direct read         first JSONL message with
//                          usage.cache_creation.ephemeral_{1h,5m}_input_tokens > 0
//   4. inference fallback  any cache_read_input_tokens > 0 across an idle gap
//                          ≥ 360s between consecutive assistant messages
//   5. default             300s (5m), source "default"
//
// Spike findings (docs/spikes/cache-ttl-field-semantics-findings.md):
// 100% of 5,905 scanned assistant messages across 11 projects carry the
// explicit per-tier breakdown — the direct path catches Max-tier 1h
// cache on the FIRST cache-active message. Inference fallback exists
// for pre-rollout transcripts and future schema drift.
//
// Hot-path budget: <100ms per session-start.js bench (PLAN-1 T10).
// Reads at most TAIL_BYTES from the end of the JSONL transcript.
//
// Kill switch: TKR_TTL_DETECTION_DISABLED=1 → returns {300, "default", 0}
// with no persistence and no telemetry side-effects.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { stateDir } = require("./state-dir");
const { readJSONSync, writeJSONAtomic } = require("./safe-json");

const DEFAULT_TTL = 300;
const EXTENDED_TTL = 3600;

// Inference threshold: cache_read past this idle gap implies 1h cache.
// 360s = 60s margin past the 5-minute baseline to absorb clock noise.
const IDLE_GAP_FOR_1H_SECS = 360;

// How far back to read from the JSONL transcript. The direct signal
// usually appears in the very first cache-active message, but inference
// needs ≥2 messages with a gap. 64KB tail covers ~30-60 messages.
const TAIL_BYTES = 64 * 1024;

// Cap on lines to parse when scanning the tail; defensive against
// pathological single-line files.
const MAX_LINES_SCAN = 200;

// Persistence freshness window for ~/.tkr/session-state/<sid>/cache-ttl.json.
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;

function disabled() {
  return process.env.TKR_TTL_DETECTION_DISABLED === "1";
}

function userConfigPath() {
  // Mirrors Go os.UserConfigDir() for Linux/macOS/Windows.
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "tkr", "config.toml");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "tkr", "config.toml");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "tkr", "config.toml");
}

// readConfigTTL — minimal TOML reader for the one key we need. Avoids
// pulling a TOML dependency into hook-side Node code. Recognizes the
// `[cache]` section and a `ttl_seconds = N` integer entry. Returns
// null on missing file, missing section, or unparseable value.
function readConfigTTL(configPathOverride) {
  const p = configPathOverride || userConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  let inCache = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]\s*$/);
    if (sec) {
      inCache = sec[1].trim() === "cache";
      continue;
    }
    if (!inCache) continue;
    const kv = line.match(/^ttl_seconds\s*=\s*(\d+)/);
    if (kv) {
      const n = parseInt(kv[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// resolveConfigOverride — env first, then config.toml. Returns ttl or null.
function resolveConfigOverride(opts) {
  const env = process.env.TKR_CACHE_TTL_SECONDS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return readConfigTTL(opts && opts.configPath);
}

// persistedPath — ~/.tkr/session-state/<sid>/cache-ttl.json
function persistedPath(sessionId) {
  const sid = sessionId && String(sessionId).trim() ? String(sessionId) : "default";
  return path.join(stateDir(), "session-state", sid, "cache-ttl.json");
}

function readPersisted(sessionId) {
  const obj = readJSONSync(persistedPath(sessionId));
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.ttl_seconds !== "number") return null;
  if (typeof obj.at !== "number") return null;
  if (Date.now() - obj.at > CACHE_FRESH_MS) return null;
  return obj;
}

function writePersisted(sessionId, result) {
  writeJSONAtomic(persistedPath(sessionId), {
    ttl_seconds: result.ttl_seconds,
    source: result.source,
    idle_gap_observed_secs: result.idle_gap_observed_secs || 0,
    at: Date.now(),
  });
}

// projectJsonlDir — mirrors Claude Code's project-dir encoding: lowercase
// path char-by-char replacement of `:`, `\`, `/` with `-`. Observed on
// Windows as `C--Users-devuser-Dropbox-Documents-Projects-tkr`.
function encodeProjectPath(projectDir) {
  return String(projectDir).replace(/[:\\/]/g, "-");
}

function findJsonlPath(sessionId, opts) {
  if (opts && opts.jsonlPath) return opts.jsonlPath;
  const sid = sessionId && String(sessionId).trim() ? String(sessionId) : null;
  if (!sid) return null;
  const projectDir =
    (opts && opts.projectDir) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const home = os.homedir();
  const projDirName = encodeProjectPath(projectDir);
  return path.join(home, ".claude", "projects", projDirName, `${sid}.jsonl`);
}

// readJsonlTail reads up to TAIL_BYTES from the end of `filePath` and
// returns the array of parsed JSON objects (one per non-empty line, in
// file order). Bad lines are silently skipped. Returns [] on any error.
function readJsonlTail(filePath, opts) {
  const tailBytes = (opts && opts.tailBytes) || TAIL_BYTES;
  let fd;
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return [];
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    fd = null;
    let text = buf.toString("utf8");
    // Discard partial line at start when we didn't begin at byte 0.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const lines = text.split("\n");
    const out = [];
    let scanned = 0;
    for (const ln of lines) {
      if (!ln) continue;
      if (scanned++ > MAX_LINES_SCAN) break;
      try {
        out.push(JSON.parse(ln));
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    if (fd !== null && fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    return [];
  }
}

// analyzeMessages — examines parsed JSONL message rows in chronological
// order. Returns the highest-confidence detection finding, or null when
// neither direct nor inferred evidence is present.
//
// Direct beats inferred. Within direct: 1h evidence beats 5m evidence
// when both are observed (Max-tier sessions occasionally interleave).
function analyzeMessages(messages) {
  let direct1h = false;
  let direct5m = false;
  let lastUsageAt = null;
  let inferredGap = 0;

  for (const msg of messages) {
    const usage =
      msg && msg.message && msg.message.usage ? msg.message.usage : null;
    if (!usage) continue;

    const cc = usage.cache_creation;
    if (cc && typeof cc === "object") {
      if (Number(cc.ephemeral_1h_input_tokens) > 0) direct1h = true;
      else if (Number(cc.ephemeral_5m_input_tokens) > 0) direct5m = true;
    }

    // Inference path: track cache_read across idle gaps. We use message
    // timestamps; if absent, skip — inference requires monotonic stamps.
    const ts = msg.timestamp ? Date.parse(msg.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (
        lastUsageAt !== null &&
        Number(usage.cache_read_input_tokens) > 0
      ) {
        const gapSec = Math.floor((ts - lastUsageAt) / 1000);
        if (gapSec >= IDLE_GAP_FOR_1H_SECS && gapSec > inferredGap) {
          inferredGap = gapSec;
        }
      }
      lastUsageAt = ts;
    }
  }

  if (direct1h) return { ttl_seconds: EXTENDED_TTL, source: "direct", idle_gap_observed_secs: 0 };
  if (direct5m) return { ttl_seconds: DEFAULT_TTL, source: "direct", idle_gap_observed_secs: 0 };
  if (inferredGap > 0) return { ttl_seconds: EXTENDED_TTL, source: "inferred", idle_gap_observed_secs: inferredGap };
  return null;
}

// detectTTL — public entry point. `opts` (test-only) supports:
//   projectDir: override CLAUDE_PROJECT_DIR
//   jsonlPath:  bypass project-dir resolution
//   configPath: override user config.toml path
//   tailBytes:  override TAIL_BYTES for tests
//   noCache:    skip read of persisted cache
//   noPersist:  skip write of persisted cache
function detectTTL(sessionId, opts) {
  opts = opts || {};

  if (disabled()) {
    return { ttl_seconds: DEFAULT_TTL, source: "default", idle_gap_observed_secs: 0 };
  }

  // 1. Config override (env or TOML)
  const cfg = resolveConfigOverride(opts);
  if (cfg !== null) {
    return { ttl_seconds: cfg, source: "config", idle_gap_observed_secs: 0 };
  }

  // 2. Cached prior inference (24h fresh)
  if (!opts.noCache) {
    const cached = readPersisted(sessionId);
    if (cached) {
      return {
        ttl_seconds: cached.ttl_seconds,
        source: cached.source,
        idle_gap_observed_secs: cached.idle_gap_observed_secs || 0,
      };
    }
  }

  // 3+4. Read transcript and classify.
  const jsonlPath = findJsonlPath(sessionId, opts);
  if (jsonlPath) {
    const messages = readJsonlTail(jsonlPath, opts);
    const found = analyzeMessages(messages);
    if (found) {
      if (!opts.noPersist) writePersisted(sessionId, found);
      return found;
    }
  }

  // 5. Default
  return { ttl_seconds: DEFAULT_TTL, source: "default", idle_gap_observed_secs: 0 };
}

module.exports = {
  DEFAULT_TTL,
  EXTENDED_TTL,
  IDLE_GAP_FOR_1H_SECS,
  TAIL_BYTES,
  CACHE_FRESH_MS,
  detectTTL,
  // Test-surface exports
  analyzeMessages,
  readJsonlTail,
  readConfigTTL,
  resolveConfigOverride,
  persistedPath,
  readPersisted,
  writePersisted,
  encodeProjectPath,
  findJsonlPath,
  userConfigPath,
};
