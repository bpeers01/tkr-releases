// hooks/lib/cache-ttl.test.js — PLAN-1 T2.
//
// Coverage: default fallback, config override (env + toml), direct read
// (ephemeral_{1h,5m}), inference promotion (cache_read across idle gap),
// persistence cache hit/miss/stale, TKR_TTL_DETECTION_DISABLED kill switch.
//
// Uses node:test (built-in) so no dev-dependency is required.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cacheTtl = require("./cache-ttl");
const {
  detectTTL,
  analyzeMessages,
  readJsonlTail,
  readConfigTTL,
  encodeProjectPath,
  persistedPath,
  writePersisted,
  readPersisted,
  DEFAULT_TTL,
  EXTENDED_TTL,
  CACHE_FRESH_MS,
} = cacheTtl;

// withTempState — creates an isolated TKR_STATE_DIR + restores env + clears
// require cache so per-test runs are independent.
function withTempState(fn) {
  const prev = {
    state: process.env.TKR_STATE_DIR,
    ttl: process.env.TKR_CACHE_TTL_SECONDS,
    kill: process.env.TKR_TTL_DETECTION_DISABLED,
    proj: process.env.CLAUDE_PROJECT_DIR,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-ttl-test-"));
  process.env.TKR_STATE_DIR = tmp;
  delete process.env.TKR_CACHE_TTL_SECONDS;
  delete process.env.TKR_TTL_DETECTION_DISABLED;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    return fn(tmp);
  } finally {
    if (prev.state === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev.state;
    if (prev.ttl === undefined) delete process.env.TKR_CACHE_TTL_SECONDS;
    else process.env.TKR_CACHE_TTL_SECONDS = prev.ttl;
    if (prev.kill === undefined) delete process.env.TKR_TTL_DETECTION_DISABLED;
    else process.env.TKR_TTL_DETECTION_DISABLED = prev.kill;
    if (prev.proj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev.proj;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Build a fake JSONL transcript at `filePath` from an array of messages.
function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// Synthesize an assistant message row matching observed Claude Code shape.
function asstMsg({ ts, ephemeral1h = 0, ephemeral5m = 0, cacheRead = 0 }) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: ephemeral1h + ephemeral5m,
        cache_creation: {
          ephemeral_5m_input_tokens: ephemeral5m,
          ephemeral_1h_input_tokens: ephemeral1h,
        },
      },
    },
  };
}

test("default: no jsonl, no config → 5m default", () => {
  withTempState(() => {
    const r = detectTTL("sid-none", { jsonlPath: "/nonexistent/path.jsonl", noCache: true });
    assert.equal(r.ttl_seconds, DEFAULT_TTL);
    assert.equal(r.source, "default");
    assert.equal(r.idle_gap_observed_secs, 0);
  });
});

test("config override via TKR_CACHE_TTL_SECONDS env", () => {
  withTempState(() => {
    process.env.TKR_CACHE_TTL_SECONDS = "3600";
    const r = detectTTL("sid-cfg", { jsonlPath: "/nonexistent.jsonl", noCache: true });
    assert.equal(r.ttl_seconds, 3600);
    assert.equal(r.source, "config");
  });
});

test("config override via config.toml [cache] ttl_seconds", () => {
  withTempState((tmp) => {
    const cfgPath = path.join(tmp, "config.toml");
    fs.writeFileSync(cfgPath, "# comment\n[other]\nkey=1\n\n[cache]\nttl_seconds = 3600\n");
    const r = detectTTL("sid-toml", {
      jsonlPath: "/nonexistent.jsonl",
      noCache: true,
      configPath: cfgPath,
    });
    assert.equal(r.ttl_seconds, 3600);
    assert.equal(r.source, "config");
  });
});

test("readConfigTTL ignores [cache] outside section", () => {
  withTempState((tmp) => {
    const cfgPath = path.join(tmp, "config.toml");
    fs.writeFileSync(cfgPath, "ttl_seconds = 3600\n[other]\nttl_seconds = 7200\n");
    assert.equal(readConfigTTL(cfgPath), null);
  });
});

test("direct read: first ephemeral_1h>0 message pins 1h", () => {
  withTempState((tmp) => {
    const jsonl = path.join(tmp, "fake.jsonl");
    writeJsonl(jsonl, [
      asstMsg({ ts: "2026-05-17T00:00:00Z", ephemeral1h: 12000, cacheRead: 0 }),
      asstMsg({ ts: "2026-05-17T00:00:10Z", ephemeral1h: 0, cacheRead: 11000 }),
    ]);
    const r = detectTTL("sid-direct1h", { jsonlPath: jsonl, noCache: true, noPersist: true });
    assert.equal(r.ttl_seconds, EXTENDED_TTL);
    assert.equal(r.source, "direct");
  });
});

test("direct read: ephemeral_5m>0 with no 1h pins 5m", () => {
  withTempState((tmp) => {
    const jsonl = path.join(tmp, "fake.jsonl");
    writeJsonl(jsonl, [
      asstMsg({ ts: "2026-05-17T00:00:00Z", ephemeral5m: 8000 }),
    ]);
    const r = detectTTL("sid-direct5m", { jsonlPath: jsonl, noCache: true, noPersist: true });
    assert.equal(r.ttl_seconds, DEFAULT_TTL);
    assert.equal(r.source, "direct");
  });
});

test("direct read: 1h evidence wins over later 5m evidence", () => {
  withTempState((tmp) => {
    const jsonl = path.join(tmp, "fake.jsonl");
    writeJsonl(jsonl, [
      asstMsg({ ts: "2026-05-17T00:00:00Z", ephemeral5m: 8000 }),
      asstMsg({ ts: "2026-05-17T00:01:00Z", ephemeral1h: 12000 }),
    ]);
    const r = detectTTL("sid-mixed", { jsonlPath: jsonl, noCache: true, noPersist: true });
    assert.equal(r.ttl_seconds, EXTENDED_TTL);
    assert.equal(r.source, "direct");
  });
});

test("inference: cache_read across ≥360s idle gap promotes to 1h", () => {
  withTempState((tmp) => {
    const jsonl = path.join(tmp, "fake.jsonl");
    writeJsonl(jsonl, [
      // No ephemeral_* breakdown (simulates pre-rollout transcript).
      {
        type: "assistant",
        timestamp: "2026-05-17T00:00:00Z",
        message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 } },
      },
      {
        type: "assistant",
        timestamp: "2026-05-17T00:08:00Z", // 480s later
        message: { usage: { cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } },
      },
    ]);
    const r = detectTTL("sid-infer", { jsonlPath: jsonl, noCache: true, noPersist: true });
    assert.equal(r.ttl_seconds, EXTENDED_TTL);
    assert.equal(r.source, "inferred");
    assert.equal(r.idle_gap_observed_secs, 480);
  });
});

test("inference: cache_read within 5m gap → no promotion", () => {
  withTempState((tmp) => {
    const jsonl = path.join(tmp, "fake.jsonl");
    writeJsonl(jsonl, [
      {
        type: "assistant",
        timestamp: "2026-05-17T00:00:00Z",
        message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 } },
      },
      {
        type: "assistant",
        timestamp: "2026-05-17T00:01:30Z", // 90s later
        message: { usage: { cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } },
      },
    ]);
    const r = detectTTL("sid-infer-short", {
      jsonlPath: jsonl,
      noCache: true,
      noPersist: true,
    });
    assert.equal(r.source, "default");
    assert.equal(r.ttl_seconds, DEFAULT_TTL);
  });
});

test("persistence: fresh cache hit returns without re-reading JSONL", () => {
  withTempState(() => {
    writePersisted("sid-persist", {
      ttl_seconds: 3600,
      source: "direct",
      idle_gap_observed_secs: 0,
    });
    const r = detectTTL("sid-persist", { jsonlPath: "/nonexistent.jsonl" });
    assert.equal(r.ttl_seconds, 3600);
    assert.equal(r.source, "direct");
  });
});

test("persistence: stale cache (>24h) is ignored", () => {
  withTempState((tmp) => {
    const p = persistedPath("sid-stale");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        ttl_seconds: 3600,
        source: "direct",
        idle_gap_observed_secs: 0,
        at: Date.now() - CACHE_FRESH_MS - 1000,
      }),
    );
    const cached = readPersisted("sid-stale");
    assert.equal(cached, null);
  });
});

test("persistence: missing file → null", () => {
  withTempState(() => {
    assert.equal(readPersisted("sid-missing"), null);
  });
});

test("TKR_TTL_DETECTION_DISABLED=1 returns default + no persistence", () => {
  withTempState((tmp) => {
    process.env.TKR_TTL_DETECTION_DISABLED = "1";
    // Even with a 1h-direct JSONL in place, kill switch wins.
    const jsonl = path.join(tmp, "fake.jsonl");
    writeJsonl(jsonl, [
      asstMsg({ ts: "2026-05-17T00:00:00Z", ephemeral1h: 12000 }),
    ]);
    const r = detectTTL("sid-killed", { jsonlPath: jsonl });
    assert.equal(r.ttl_seconds, DEFAULT_TTL);
    assert.equal(r.source, "default");
    assert.equal(r.idle_gap_observed_secs, 0);
    // No persistence written.
    assert.equal(fs.existsSync(persistedPath("sid-killed")), false);
  });
});

test("encodeProjectPath matches observed Windows naming", () => {
  // Project dir from gitStatus: C:\Users\devuser\Dropbox\Documents\Projects\tkr
  const got = encodeProjectPath("C:\\Users\\devuser\\Dropbox\\Documents\\Projects\\tkr");
  assert.equal(got, "C--Users-devuser-Dropbox-Documents-Projects-tkr");
});

test("readJsonlTail: handles partial leading line + bad lines", () => {
  withTempState((tmp) => {
    const f = path.join(tmp, "x.jsonl");
    const good = JSON.stringify({ a: 1 });
    const bad = "{this is not json";
    fs.writeFileSync(f, "{leading-partial\n" + bad + "\n" + good + "\n");
    // Force start mid-file by clamping tail bytes.
    const rows = readJsonlTail(f, { tailBytes: 20 });
    assert.ok(rows.some((r) => r.a === 1));
  });
});

test("analyzeMessages: no usage rows → null", () => {
  assert.equal(analyzeMessages([{ type: "user" }, { type: "summary" }]), null);
});
