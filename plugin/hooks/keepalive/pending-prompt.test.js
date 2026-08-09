#!/usr/bin/env node
// Tests for issue #152 — the keepalive watcher firing while the session is
// BLOCKED ON A HUMAN rather than idle.
//
// The failure: a pending AskUserQuestion appends no transcript rows while the
// human decides, so idle time alone reads it as abandoned. The wake then lands
// on top of the user's answer wrapped in Claude Code's "NOT USER INPUT"
// boilerplate, and the model correctly refuses to trust real user input.
// Observed live 2026-08-06: three genuine decisions discarded, idle 3339s.
//
// Two independent fixes are covered here:
//   item 1 — suppression: an unmatched interactive tool_use forces WAIT.
//   item 3 — provenance: a handoff written after the human answered must not
//            be stamped `keepalive`. cache_channels.py reads that marker, so
//            leaving it wrong inflates keepalive-value figures by exactly the
//            fires that were mistakes.
//
// Run: node --test hooks/keepalive/pending-prompt.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HERE = __dirname;
const DECISION = path.join(HERE, "idle-decision.sh");
const ACTIVITY_PY = path.join(HERE, "transcript-activity.py");
const WRITER = path.join(
  HERE,
  "..",
  "..",
  "skills",
  "handoff",
  "scripts",
  "write-continue-here.sh",
);

const posix = (p) => p.replace(/\\/g, "/");

function findBash() {
  const probe = spawnSync("bash", ["-c", "exit 0"]);
  return probe.error ? null : "bash";
}
const BASH = findBash();

function findPython() {
  for (const c of ["python3", "python"]) {
    const probe = spawnSync(c, ["-c", "pass"]);
    if (!probe.error && probe.status === 0) return c;
  }
  return null;
}
const PY = findPython();

const iso = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, "Z");

function mkdtemp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tkr-152-${tag}-`));
}

// Build a transcript. `answered` controls whether the AskUserQuestion
// tool_use has a matching tool_result.
function writeTranscript(file, { askEpoch, answerEpoch, toolName = "AskUserQuestion" }) {
  const rows = [
    { type: "user", timestamp: iso(askEpoch - 10), message: { content: [{ type: "text", text: "go" }] } },
    {
      type: "assistant",
      timestamp: iso(askEpoch),
      message: { content: [{ type: "tool_use", id: "toolu_152", name: toolName, input: {} }] },
    },
  ];
  if (answerEpoch) {
    rows.push({
      type: "user",
      timestamp: iso(answerEpoch),
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_152", content: "answered" }] },
    });
  }
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function runPy(file, mode) {
  const r = spawnSync(PY, [ACTIVITY_PY, file, mode], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, `python exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------- item 1

test("pending mode: unmatched AskUserQuestion reports pending", { skip: !PY }, () => {
  const dir = mkdtemp("pend");
  const f = path.join(dir, "t.jsonl");
  writeTranscript(f, { askEpoch: 1786000000 });
  assert.strictEqual(runPy(f, "pending"), "1");
});

test("pending mode: answered AskUserQuestion is not pending", { skip: !PY }, () => {
  const dir = mkdtemp("pend2");
  const f = path.join(dir, "t.jsonl");
  writeTranscript(f, { askEpoch: 1786000000, answerEpoch: 1786000300 });
  assert.strictEqual(runPy(f, "pending"), "0");
});

test("pending mode: ExitPlanMode also counts as interactive", { skip: !PY }, () => {
  const dir = mkdtemp("pend3");
  const f = path.join(dir, "t.jsonl");
  writeTranscript(f, { askEpoch: 1786000000, toolName: "ExitPlanMode" });
  assert.strictEqual(runPy(f, "pending"), "1");
});

// The deliberate narrowness: a hung Bash call must NOT suppress keepalive.
// That is the abandoned-session case keepalive exists to catch, and a broad
// "any unmatched tool_use" match would silently disable it.
test("pending mode: an unmatched non-interactive tool_use does NOT suppress", { skip: !PY }, () => {
  const dir = mkdtemp("pend4");
  const f = path.join(dir, "t.jsonl");
  writeTranscript(f, { askEpoch: 1786000000, toolName: "Bash" });
  assert.strictEqual(runPy(f, "pending"), "0");
});

test("pending gate: 1 -> WAIT, 0 -> PROCEED, garbage -> PROCEED", { skip: !BASH }, () => {
  const call = (v) => {
    const r = spawnSync(
      BASH,
      ["-c", `. "${posix(DECISION)}"; keepalive_pending_prompt_gate "${v}"`],
      { encoding: "utf8" },
    );
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.strictEqual(call("1"), "WAIT");
  assert.strictEqual(call("0"), "PROCEED");
  // A broken detector must not wedge the watcher into never firing.
  assert.strictEqual(call(""), "PROCEED");
  assert.strictEqual(call("nonsense"), "PROCEED");
});

// ---------------------------------------------------------------- item 3

test("human-answer mode: reports the answer epoch", { skip: !PY }, () => {
  const dir = mkdtemp("ans");
  const f = path.join(dir, "t.jsonl");
  writeTranscript(f, { askEpoch: 1786000000, answerEpoch: 1786000300 });
  assert.strictEqual(runPy(f, "human-answer"), "1786000300");
});

test("human-answer mode: no answer reports 0", { skip: !PY }, () => {
  const dir = mkdtemp("ans2");
  const f = path.join(dir, "t.jsonl");
  writeTranscript(f, { askEpoch: 1786000000 });
  assert.strictEqual(runPy(f, "human-answer"), "0");
});

// End-to-end: the writer must downgrade `keepalive` to `manual` when the
// transcript shows the human answered after the fire.
function runWriter({ fireEpoch, answerEpoch }) {
  const home = mkdtemp("home");
  const state = mkdtemp("state");
  const sid = "5da28945-0000-4000-8000-000000000001";

  const projDir = path.join(home, ".claude", "projects", "C--proj");
  fs.mkdirSync(projDir, { recursive: true });
  writeTranscript(path.join(projDir, `${sid}.jsonl`), {
    askEpoch: fireEpoch - 600,
    answerEpoch,
  });

  const kaDir = path.join(state, "keepalive", sid);
  fs.mkdirSync(kaDir, { recursive: true });
  fs.writeFileSync(path.join(kaDir, "fired-at"), String(fireEpoch));

  const target = path.join(state, "out.md");
  const r = spawnSync(
    BASH,
    [posix(WRITER), "--session-id", sid, "--target", posix(target), "--no-emit"],
    {
      encoding: "utf8",
      input: JSON.stringify({
        truths: ["issue #152 provenance fixture"],
        artifacts: ["hooks/keepalive/transcript-activity.py"],
        key_links: ["https://github.com/bpeers01/tkr/issues/152"],
        open_threads: ["item 2 (answer re-arm) deferred"],
        next_action: "assert the handoff-source marker",
      }),
      env: { ...process.env, HOME: posix(home), TKR_STATE_DIR: posix(state) },
    },
  );
  assert.strictEqual(r.status, 0, `writer exited ${r.status}: ${r.stderr}`);
  return fs.readFileSync(target, "utf8");
}

test("provenance: human answered AFTER the fire -> manual", { skip: !BASH || !PY }, () => {
  const now = Math.floor(Date.now() / 1000);
  const out = runWriter({ fireEpoch: now - 300, answerEpoch: now - 60 });
  assert.match(out, /tkr-handoff-source:\s*manual/);
});

test("provenance: no answer after the fire -> stays keepalive", { skip: !BASH || !PY }, () => {
  const now = Math.floor(Date.now() / 1000);
  const out = runWriter({ fireEpoch: now - 300, answerEpoch: now - 900 });
  assert.match(out, /tkr-handoff-source:\s*keepalive/);
});
