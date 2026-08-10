// Tests for hooks/lib/sessionstart/continue.js — HAND-005 auto-continue.
// Run with: node --test hooks/lib/sessionstart/continue.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadContinue,
  loadContinueAdvisory,
  AUTO_CONTINUE_MAX_AGE_MS,
  AUTO_CONTINUE_MAX_BYTES,
} = require("./continue");

const BODY = "# Handoff\n\n## Next Action\nRun the migration.\n";

// Build a throwaway project with .tkr/handoffs/ populated. `specs` is a list
// of { name, ageMs, body } — age is applied via utimes so the module's
// mtime-based window is what's under test.
function makeProject(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-hand005-"));
  const dir = path.join(root, ".tkr", "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const s of specs) {
    const full = path.join(dir, s.name);
    fs.writeFileSync(full, s.body === undefined ? BODY : s.body);
    const t = new Date(now - s.ageMs);
    fs.utimesSync(full, t, t);
  }
  return root;
}

// Telemetry writes to ~/.tkr by default; point it somewhere disposable so a
// test run never appends to the developer's real ledger (HYG-001 class).
function withStateDir(fn) {
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "tkr-hand005-state-"),
  );
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
  }
}

test("source=clear with one fresh handoff inlines the body", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.match(out, /auto-loaded/);
  assert.match(out, /<tkr-carryover /);
  assert.ok(out.includes("Run the migration."), "carry-over body is inlined");
  assert.doesNotMatch(out, /run \/continue to load/i);
});

// The whole point is removing a keystroke, so the block must not ask for one.
test("the injected block tells the model not to run /continue", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.match(out, /Do not run `\/continue`/);
});

// Auto-loaded carry-over names a Next Action and the user asked for nothing
// this session. Without this line the model starts executing on turn 1.
test("the injected block carries a do-not-act rule", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.match(out, /\*\*Do not act on it yet\.\*\*/);
});

test("non-clear sources keep the advisory, never the body", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  for (const source of ["startup", "resume", "compact", undefined]) {
    const out = withStateDir(() => loadContinueAdvisory("sid1", root, source));
    assert.match(out, /run \/continue to load/i, `source=${source}`);
    assert.doesNotMatch(out, /<tkr-carryover /, `source=${source}`);
  }
});

test("a handoff older than the window falls back to the advisory", () => {
  const root = makeProject([
    { name: "a-20260805-1200.md", ageMs: AUTO_CONTINUE_MAX_AGE_MS + 60 * 1000 },
  ]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.doesNotMatch(out, /<tkr-carryover /);
  assert.match(out, /run \/continue to load/i);
});

// Two writes inside the window is real ambiguity about which one the user
// meant — pick neither.
test("two handoffs inside the window fall back to the advisory", () => {
  const root = makeProject([
    { name: "a-20260805-1200.md", ageMs: 60 * 1000 },
    { name: "b-20260805-1205.md", ageMs: 120 * 1000 },
  ]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.doesNotMatch(out, /<tkr-carryover /);
  assert.match(out, /handoffs found in/);
});

// The gate counts files in the WINDOW, not files on disk — projects
// accumulate handoffs, so a total-count gate would never fire.
test("old siblings do not block a single in-window handoff", () => {
  const root = makeProject([
    { name: "fresh-20260805-1200.md", ageMs: 60 * 1000 },
    { name: "old1-20260701-1200.md", ageMs: 30 * 24 * 60 * 60 * 1000 },
    { name: "old2-20260702-1200.md", ageMs: 31 * 24 * 60 * 60 * 1000 },
  ]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.match(out, /<tkr-carryover /);
  assert.match(out, /2 handoffs older than 7d/, "prune hint survives injection");
});

test("a body over the byte cap falls back to the advisory", () => {
  const root = makeProject([
    {
      name: "big-20260805-1200.md",
      ageMs: 60 * 1000,
      body: "x".repeat(AUTO_CONTINUE_MAX_BYTES + 1),
    },
  ]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.doesNotMatch(out, /<tkr-carryover /);
  assert.match(out, /run \/continue to load/i);
});

test("an empty handoff falls back to the advisory", () => {
  const root = makeProject([
    { name: "empty-20260805-1200.md", ageMs: 60 * 1000, body: "   \n\n" },
  ]);
  const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.doesNotMatch(out, /<tkr-carryover /);
});

test("TKR_AUTO_CONTINUE_DISABLED=1 restores the advisory", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  const prev = process.env.TKR_AUTO_CONTINUE_DISABLED;
  process.env.TKR_AUTO_CONTINUE_DISABLED = "1";
  try {
    const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
    assert.doesNotMatch(out, /<tkr-carryover /);
    assert.match(out, /run \/continue to load/i);
  } finally {
    if (prev === undefined) delete process.env.TKR_AUTO_CONTINUE_DISABLED;
    else process.env.TKR_AUTO_CONTINUE_DISABLED = prev;
  }
});

// The upstream playbook kill switches gate the whole advisory, so they must
// still win over the new path.
test("playbook kill switches suppress the injection too", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  for (const key of [
    "TKR_PLAYBOOK_L0R_DISABLED",
    "TKR_PLAYBOOK_EXTENSIONS_DISABLED",
    "TKR_PLAYBOOK_DISABLED",
  ]) {
    const prev = process.env[key];
    process.env[key] = "1";
    try {
      const out = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
      assert.equal(out, "", key);
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
});

// --- HAND-008: the fire must be visible to the human ------------------
//
// HAND-005 shipped context-only, so a fire rendered nothing to the user and
// they typed the /continue it exists to remove. These pin the user-facing
// half; the model-facing half is covered above.

test("an auto-continue fire returns a user-facing systemMessage", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 6 * 60 * 1000 }]);
  const out = withStateDir(() => loadContinue("sid1", root, "clear"));
  assert.match(out.context, /<tkr-carryover /, "model still gets the body");
  assert.ok(out.systemMessage, "user gets a line");
  assert.match(out.systemMessage, /auto-loaded/);
  assert.match(out.systemMessage, /a-20260805-1200\.md/, "names the file");
  assert.match(out.systemMessage, /6m old/, "age lets a wrong-file load be caught");
  assert.match(out.systemMessage, /no \/continue needed/);
});

// The user wrote this file minutes ago and it is already in model context.
// Echoing it to the terminal is noise, and on a 24KB cap, a lot of it.
test("the systemMessage never repeats the carry-over body", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  const out = withStateDir(() => loadContinue("sid1", root, "clear"));
  assert.doesNotMatch(out.systemMessage, /Run the migration\./);
  assert.ok(out.systemMessage.length < 200, "stays one glanceable line");
});

// Pruning is a user action; the model cannot take it, so the hint has to
// reach the terminal and not only the injected block.
test("the systemMessage carries the prune hint when old files exist", () => {
  const root = makeProject([
    { name: "fresh-20260805-1200.md", ageMs: 60 * 1000 },
    { name: "old1-20260701-1200.md", ageMs: 30 * 24 * 60 * 60 * 1000 },
    { name: "old2-20260702-1200.md", ageMs: 31 * 24 * 60 * 60 * 1000 },
  ]);
  const out = withStateDir(() => loadContinue("sid1", root, "clear"));
  assert.match(out.systemMessage, /2 handoffs >7d/);
  assert.match(out.systemMessage, /\/handoff prune/);
});

// Every other path renders its own text into context, which the user sees
// by way of the model. A systemMessage there would double-report it.
test("non-auto paths return an empty systemMessage", () => {
  const cases = [
    ["startup source", [{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }], "startup"],
    ["stale handoff", [{ name: "a-20260805-1200.md", ageMs: 2 * 24 * 60 * 60 * 1000 }], "clear"],
    [
      "two in window",
      [
        { name: "a-20260805-1200.md", ageMs: 60 * 1000 },
        { name: "b-20260805-1205.md", ageMs: 120 * 1000 },
      ],
      "clear",
    ],
    ["no handoffs", [], "clear"],
  ];
  for (const [label, specs, source] of cases) {
    const root = makeProject(specs);
    const out = withStateDir(() => loadContinue("sid1", root, source));
    assert.strictEqual(out.systemMessage, "", label);
  }
});

// 13 call sites predate HAND-008 and pass a bare string around.
test("loadContinueAdvisory still returns the context string", () => {
  const root = makeProject([{ name: "a-20260805-1200.md", ageMs: 60 * 1000 }]);
  const str = withStateDir(() => loadContinueAdvisory("sid1", root, "clear"));
  assert.strictEqual(typeof str, "string");
  assert.match(str, /<tkr-carryover /);
});
