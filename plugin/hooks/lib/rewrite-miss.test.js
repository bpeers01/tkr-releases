#!/usr/bin/env node
// Rewrite-miss telemetry.
//
// The risk this file guards is not "does a row get written" — it is that
// a telemetry writer sitting on the Bash hot path could write user
// command text to disk, or fail a Bash call. Most of what follows is
// about those two things.
//
// Run: node --test hooks/lib/rewrite-miss.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { recordRewriteMiss, normalizeHead, MAX_HEAD } = require("./rewrite-miss.js");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-rewrite-miss-"));
  return {
    dir,
    ledger: path.join(dir, "search-adoption.jsonl"),
    rows() {
      const p = path.join(dir, "search-adoption.jsonl");
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    },
    raw() {
      const p = path.join(dir, "search-adoption.jsonl");
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    },
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function withStateDir(dir, fn) {
  const prevDir = process.env.TKR_STATE_DIR;
  const prevOff = process.env.TKR_REWRITE_MISS_DISABLED;
  process.env.TKR_STATE_DIR = dir;
  delete process.env.TKR_REWRITE_MISS_DISABLED;
  try {
    fn();
  } finally {
    if (prevDir === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevDir;
    if (prevOff === undefined) delete process.env.TKR_REWRITE_MISS_DISABLED;
    else process.env.TKR_REWRITE_MISS_DISABLED = prevOff;
  }
}

// ── The head token, and nothing else ────────────────────────────────────────

test("normalizeHead keeps a bare command name", () => {
  assert.strictEqual(normalizeHead("git status --short"), "git");
  assert.strictEqual(normalizeHead("npm"), "npm");
  assert.strictEqual(normalizeHead("  docker  ps  "), "docker");
});

test("normalizeHead collapses an absolute path to the tool name", () => {
  // /usr/bin/git and git are the same gap in the rules, so they must not
  // land in two buckets.
  assert.strictEqual(normalizeHead("/usr/bin/git log"), "git");
  assert.strictEqual(normalizeHead("C:\\tools\\git.exe status"), "git.exe");
});

test("a Windows path with spaces buckets to a path segment, never to arguments", () => {
  // Documented limitation, asserted so it stays a known shape rather than
  // drifting. Both the quoted and unquoted forms yield "Program": the
  // basename slice strips everything before the last backslash, quote
  // included, so quoting does not change the outcome here.
  //
  // The property that actually matters survives either way — the result
  // is one path segment that cleared HEAD_RE, so a wrong bucket LABEL is
  // the worst case and argument text can never be it.
  assert.strictEqual(normalizeHead('"C:\\Program Files\\nodejs\\node.exe" x'), "Program");
  assert.strictEqual(normalizeHead("C:\\Program Files\\nodejs\\node.exe x"), "Program");
});

test("normalizeHead refuses anything that is not a bare command name", () => {
  // Each of these would put user data on disk if it survived. Refusing
  // costs one unrecorded miss; accepting costs a leak.
  for (const bad of [
    "",
    "   ",
    "'quoted command'",
    '"also quoted"',
    "cmd;rm -rf /",
    "cmd|tee /etc/passwd",
    "$(whoami)",
    "`whoami`",
    "a".repeat(MAX_HEAD + 1),
    "cmd>out.txt",
  ]) {
    assert.strictEqual(normalizeHead(bad), "", `expected refusal for ${JSON.stringify(bad)}`);
  }
});

test("normalizeHead tolerates non-string input", () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.strictEqual(normalizeHead(bad), "");
  }
});

// ── Writing ─────────────────────────────────────────────────────────────────

test("recordRewriteMiss writes one row with the head only", () => {
  const fx = fixture();
  try {
    withStateDir(fx.dir, () => {
      recordRewriteMiss("git log --format=%H --author=alice@example.com", "sess-1");
    });
    const rows = fx.rows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, "rewrite_miss");
    assert.strictEqual(rows[0].head, "git");
    assert.strictEqual(rows[0].sid, "sess-1");
    assert.ok(rows[0].ts);
  } finally {
    fx.cleanup();
  }
});

test("the command line never reaches the ledger", () => {
  // The load-bearing privacy assertion. A whole-file check rather than a
  // field check: the point is that no path through the writer carries
  // argument text, however the row is shaped.
  const fx = fixture();
  try {
    // The sentinel is deliberately NOT shaped like a real provider key.
    // A fixture shaped like a real provider credential reads better but
    // trips the repo's secret scanner, which cannot tell a fixture from a
    // leak and should not have to. Do not "improve" this into something
    // that looks authentic.
    const sentinel = "tkr-test-sentinel-do-not-log";
    withStateDir(fx.dir, () => {
      recordRewriteMiss(
        `curl -H 'X-Auth: ${sentinel}' https://internal.corp/api`,
        "sess-1"
      );
    });
    const raw = fx.raw();
    assert.ok(raw.includes('"head":"curl"'));
    for (const leaked of [sentinel, "X-Auth", "internal.corp", "https://"]) {
      assert.ok(!raw.includes(leaked), `ledger leaked ${leaked}: ${raw}`);
    }
  } finally {
    fx.cleanup();
  }
});

test("an unusable head writes nothing at all", () => {
  const fx = fixture();
  try {
    withStateDir(fx.dir, () => {
      recordRewriteMiss("$(curl evil.example.com)", "sess-1");
      recordRewriteMiss("", "sess-1");
    });
    assert.deepStrictEqual(fx.rows(), []);
  } finally {
    fx.cleanup();
  }
});

test("the kill switch silences it", () => {
  const fx = fixture();
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = fx.dir;
  process.env.TKR_REWRITE_MISS_DISABLED = "1";
  try {
    recordRewriteMiss("git status", "sess-1");
    assert.deepStrictEqual(fx.rows(), []);
  } finally {
    delete process.env.TKR_REWRITE_MISS_DISABLED;
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fx.cleanup();
  }
});

test("an unwritable state dir does not throw", () => {
  // This runs on the Bash hot path. A full disk, a read-only mount, or a
  // path collision must cost a missing row and nothing else.
  const fx = fixture();
  try {
    const blocker = path.join(fx.dir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    withStateDir(path.join(blocker, "nested"), () => {
      assert.doesNotThrow(() => recordRewriteMiss("git status", "sess-1"));
    });
  } finally {
    fx.cleanup();
  }
});

test("rows share the store the search-adoption reader already parses", () => {
  // Same file, same field names, so LoadSearchAdoption counts these
  // without a second reader. A parallel store would be a second thing to
  // rotate, sweep, and keep in sync.
  const fx = fixture();
  try {
    withStateDir(fx.dir, () => recordRewriteMiss("npm run build", "sess-1"));
    const row = fx.rows()[0];
    assert.deepStrictEqual(Object.keys(row).sort(), ["head", "kind", "sid", "ts"]);
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  } finally {
    fx.cleanup();
  }
});
