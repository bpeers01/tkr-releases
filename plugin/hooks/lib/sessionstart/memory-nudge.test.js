// #381 item 19: `tkr memory audit --fix` only ever deletes DEAD files
// (internal/cmd/memory.go applyMemFix) — OVERSIZED and STALE need a human
// to look and are never touched by --fix. Before this fix, loadMemoryNudge
// always suggested "--fix" regardless of which categories fired, which
// promised a fix for stale/oversized findings that silently never happened.
// These tests pin the corrected action text per category mix.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function freshEnv() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-memnudge-state-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-memnudge-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-memnudge-proj-"));
  return { state, home, proj };
}

function cleanup(paths) {
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

function withEnv(state, home, fn) {
  const prevState = process.env.TKR_STATE_DIR;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.TKR_STATE_DIR = state;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    if (prevState === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prevState;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

function memDirFor(home, proj) {
  const { pathToClaudeSlug } = require("./memory-nudge");
  const slug = pathToClaudeSlug(proj);
  const memDir = path.join(home, ".claude", "projects", slug, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  return { slug, memDir };
}

function writeDeadEntry(memDir) {
  fs.writeFileSync(
    path.join(memDir, "dead-entry.md"),
    ["---", "type: project", "---", "RESOLVED", ""].join("\n"),
  );
}

function writeStaleEntry(memDir) {
  const p = path.join(memDir, "stale-entry.md");
  fs.writeFileSync(
    p,
    [
      "---",
      "type: project",
      "---",
      "Distribution pipeline ships via the two-repo model.",
      "",
    ].join("\n"),
  );
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(p, old, old);
}

test("loadMemoryNudge: dead-only suggests plain --fix", () => {
  const { state, home, proj } = freshEnv();
  try {
    const { memDir } = memDirFor(home, proj);
    writeDeadEntry(memDir);
    const msg = withEnv(state, home, () => {
      delete require.cache[require.resolve("./memory-nudge")];
      return require("./memory-nudge").loadMemoryNudge(proj);
    });
    assert.match(msg, /\bdead\b/);
    assert.match(msg, /tkr memory audit --fix/);
    assert.doesNotMatch(
      msg,
      /removes dead only/,
      "dead-only should not carry the mixed-category caveat",
    );
  } finally {
    cleanup([state, home, proj]);
  }
});

test("loadMemoryNudge: stale-only does NOT suggest --fix (it fixes nothing here)", () => {
  const { state, home, proj } = freshEnv();
  try {
    const { memDir, slug } = memDirFor(home, proj);
    writeStaleEntry(memDir);
    const msg = withEnv(state, home, () => {
      delete require.cache[require.resolve("./memory-nudge")];
      return require("./memory-nudge").loadMemoryNudge(proj);
    });
    assert.match(msg, /\bstale\b/);
    assert.doesNotMatch(
      msg,
      /--fix/,
      "--fix only deletes DEAD files; suggesting it for a stale-only " +
        "finding promises an action that silently does nothing",
    );
    assert.match(
      msg,
      new RegExp(`tkr memory audit --project ${slug}`),
      "stale-only should point at the review command instead",
    );
  } finally {
    cleanup([state, home, proj]);
  }
});

test("loadMemoryNudge: mixed dead+stale qualifies --fix's scope", () => {
  const { state, home, proj } = freshEnv();
  try {
    const { memDir } = memDirFor(home, proj);
    writeDeadEntry(memDir);
    writeStaleEntry(memDir);
    const msg = withEnv(state, home, () => {
      delete require.cache[require.resolve("./memory-nudge")];
      return require("./memory-nudge").loadMemoryNudge(proj);
    });
    assert.match(msg, /\bdead\b/);
    assert.match(msg, /\bstale\b/);
    assert.match(msg, /tkr memory audit --fix/);
    assert.match(
      msg,
      /removes dead only.*manual review/,
      "mixed findings must say --fix will not touch the stale ones",
    );
  } finally {
    cleanup([state, home, proj]);
  }
});
