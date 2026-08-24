// Tests for hooks/lib/sessionstart/goal-nudge.js — #381 item 18 pinned-goal
// SessionStart bullet.
//
// Run: node --test hooks/lib/sessionstart/goal-nudge.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadGoalBullet, readGoalText, truncate, MAX_GOAL_CHARS } = require("./goal-nudge");

function withProjectDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-goal-nudge-"));
  try {
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeGoal(projectPath, obj) {
  const dir = path.join(projectPath, ".tkr");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "goal.json"), JSON.stringify(obj));
}

test("loadGoalBullet returns empty string when no goal file exists", () => {
  withProjectDir((tmp) => {
    assert.strictEqual(loadGoalBullet(tmp), "");
  });
});

test("loadGoalBullet returns empty string on malformed goal file", () => {
  withProjectDir((tmp) => {
    fs.mkdirSync(path.join(tmp, ".tkr"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".tkr", "goal.json"), "not json");
    assert.strictEqual(loadGoalBullet(tmp), "");
  });
});

test("loadGoalBullet returns empty string when text is blank", () => {
  withProjectDir((tmp) => {
    writeGoal(tmp, { text: "   ", set_at: 1 });
    assert.strictEqual(loadGoalBullet(tmp), "");
  });
});

test("loadGoalBullet surfaces a set goal as one bullet", () => {
  withProjectDir((tmp) => {
    writeGoal(tmp, { text: "ship item 18", set_at: 1755600000 });
    const bullet = loadGoalBullet(tmp);
    assert.ok(bullet.includes("ship item 18"), bullet);
    assert.ok(bullet.startsWith("\n\n**Pinned goal:**"), bullet);
  });
});

test("readGoalText trims whitespace", () => {
  withProjectDir((tmp) => {
    writeGoal(tmp, { text: "  spaced goal  ", set_at: 1 });
    assert.strictEqual(readGoalText(tmp), "spaced goal");
  });
});

test("truncate caps long text with an ellipsis", () => {
  const long = "x".repeat(MAX_GOAL_CHARS + 50);
  const out = truncate(long, MAX_GOAL_CHARS);
  assert.strictEqual(out.length, MAX_GOAL_CHARS);
  assert.ok(out.endsWith("…"));
});

test("loadGoalBullet caps a long stored goal", () => {
  withProjectDir((tmp) => {
    writeGoal(tmp, { text: "y".repeat(MAX_GOAL_CHARS + 50), set_at: 1 });
    const bullet = loadGoalBullet(tmp);
    // bullet = "\n\n**Pinned goal:** " + capped text
    const prefix = "\n\n**Pinned goal:** ";
    assert.strictEqual(bullet.length - prefix.length, MAX_GOAL_CHARS);
  });
});
