// Tests for hooks/lib/sessionstart/effort-log.js — persistSessionEffort
// (ADR-0010 addendum: per-session active-effort state file consumed by
// user-prompt-submit's detectActiveEffort fallback).
//
// Run: node --test hooks/lib/sessionstart/effort-log.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { persistSessionEffort } = require("./effort-log");

function withStateDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-effort-log-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = tmp;
  try {
    fn(tmp);
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("persists hook-input effort to effort-<sid>.json", () => {
  withStateDir((tmp) => {
    persistSessionEffort("sid-a", { effort: { level: "high" } }, {});
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, "effort-sid-a.json"), "utf8"));
    assert.strictEqual(parsed.effort, "high");
  });
});

test("falls back to env detection when input carries no effort", () => {
  withStateDir((tmp) => {
    persistSessionEffort("sid-b", {}, { CLAUDE_CODE_EFFORT_LEVEL: "low" });
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, "effort-sid-b.json"), "utf8"));
    assert.strictEqual(parsed.effort, "low");
    assert.strictEqual(parsed.source, "CLAUDE_CODE_EFFORT_LEVEL");
  });
});

test("records hook_input.effort.level as the source when input wins", () => {
  withStateDir((tmp) => {
    persistSessionEffort("sid-e", { effort: { level: "high" } }, {});
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, "effort-sid-e.json"), "utf8"));
    assert.strictEqual(parsed.source, "hook_input.effort.level");
    assert.ok(parsed.ts, "ts must be stamped");
  });
});

test("input effort beats env effort", () => {
  withStateDir((tmp) => {
    persistSessionEffort("sid-c", { effort: { level: "xhigh" } }, { CLAUDE_EFFORT: "low" });
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, "effort-sid-c.json"), "utf8"));
    assert.strictEqual(parsed.effort, "xhigh");
  });
});

test("clearWhenAbsent removes a stale file when nothing is detectable", () => {
  withStateDir((tmp) => {
    const fp = path.join(tmp, "effort-sid-d.json");
    fs.writeFileSync(fp, '{"effort":"max"}');
    persistSessionEffort("sid-d", {}, {}, { clearWhenAbsent: true });
    assert.strictEqual(fs.existsSync(fp), false, "stale snapshot removed");
  });
});

// Session-lifecycle hooks are never handed effort, so for them "nothing
// detectable" is ignorance, not evidence. Erasing on it would let every
// UserPromptSubmit delete what the preceding PostToolUse observed —
// which is the failure mode that left `tkr top`'s EFFORT column blank.
test("default leaves an existing snapshot alone when nothing is detectable", () => {
  withStateDir((tmp) => {
    const fp = path.join(tmp, "effort-sid-f.json");
    fs.writeFileSync(fp, '{"effort":"max"}');
    persistSessionEffort("sid-f", {}, {});
    assert.strictEqual(
      JSON.parse(fs.readFileSync(fp, "utf8")).effort,
      "max",
      "a blind caller must not erase an observed value",
    );
  });
});

test("no-op on empty sid", () => {
  withStateDir((tmp) => {
    persistSessionEffort("", { effort: { level: "high" } }, {});
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
  });
});
