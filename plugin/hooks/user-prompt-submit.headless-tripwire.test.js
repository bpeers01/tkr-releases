#!/usr/bin/env node
// Headless tripwire for shaped @-mentions (#658): spawns a REAL nested
// `claude -p` session with a shaped mention (@fixture.js:map) and
// asserts the persisted session transcript carries NO native full-file
// attachment for that file. That is the acceptance criterion the issue
// asked for — proof that `@path:mode` declines the harness's literal
// @-file picker (which would double-load the whole file) rather than
// merely asserting tkr's own hook logic in isolation (already covered
// by the 17 unit tests in user-prompt-submit.shaped-mentions.test.js).
//
// Ground truth for the transcript shapes below was captured empirically
// (2026-08-28) via two manual probes in this repo before writing this
// test — not guessed:
//   - `@fixture.js:map ...`  -> transcript has NO `{"type":"attachment",
//     "attachment":{"type":"file",...}}` line anywhere, and the fixture's
//     body text never appears in the transcript at all.
//   - `@fixture.js ...` (bare, no mode) -> transcript DOES carry exactly
//     that attachment line, with `attachment.content.file.content`
//     holding the full file body verbatim. This is the positive control
//     below — it proves the detection method actually distinguishes the
//     two cases instead of vacuously passing.
//
// SKIPPED BY DEFAULT. This spawns a real `claude` binary and makes a
// live API call — cost and non-determinism no other test in this suite
// carries, and `node --test hooks/**/*.test.js` runs unconditionally at
// pre-push/CI (AGENTS.md), so it must not run there. Opt in explicitly:
//   TKR_RUN_HEADLESS_TRIPWIRE=1 node --test hooks/user-prompt-submit.headless-tripwire.test.js
//
// Known hang (TODO.md, 2026-08-28 finding, confirmed again while writing
// this test): `claude -p` invoked from inside a running session writes
// its transcript completely and then does not exit on its own — the
// parent process lingers. This is why the code below never waits on the
// child's exit; it polls the transcript file directly (which lands
// completely within ~10-15s in practice) and then force-kills the
// process tree unconditionally in a `finally`, using `taskkill /T`
// (Windows) called via `execFileSync` — NOT through a shell, so the
// MSYS path-mangling trap documented in AGENTS.md for `taskkill` run
// from Git Bash does not apply here.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { locateBinary } = require("./lib/skill-scrape");

const ENABLED = process.env.TKR_RUN_HEADLESS_TRIPWIRE === "1";
const SKIP_REASON =
  "opt-in only (spawns a real claude -p subprocess + live API call; " +
  "see the file banner) — set TKR_RUN_HEADLESS_TRIPWIRE=1 to run";

const REPO_ROOT = path.join(__dirname, "..");
const SPAWN_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

function sleepSync(ms) {
  const ia = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(ia, 0, 0, ms);
}

// Claude Code's project-transcript directory naming: the absolute cwd
// with every `:` and `\` replaced by `-`. Verified against two live
// transcript paths written during this session's probes (e.g.
// `C:\Users\...\tkr\test-tmp\headless-probe` ->
// `C--Users-...-tkr-test-tmp-headless-probe`).
function projectSlug(absPath) {
  return absPath.replace(/:/g, "-").replace(/\\/g, "-");
}

function transcriptDirFor(cwd) {
  return path.join(os.homedir(), ".claude", "projects", projectSlug(cwd));
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // Already exited, or nothing to kill — best effort, never throw.
  }
}

// Polls `dir` for a *.jsonl file (mtime >= sinceMs) that contains a
// completed assistant turn. Returns the file path, or null on timeout.
function waitForCompletedTranscript(dir, sinceMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(dir)) {
      const hits = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(dir, f))
        .filter((p) => {
          try {
            return fs.statSync(p).mtimeMs >= sinceMs;
          } catch {
            return false;
          }
        });
      for (const p of hits) {
        try {
          if (fs.readFileSync(p, "utf8").includes('"type":"assistant"')) {
            return p;
          }
        } catch {
          // still being written; try again next tick
        }
      }
    }
    sleepSync(POLL_INTERVAL_MS);
  }
  return null;
}

function parseTranscript(transcriptPath) {
  return fs
    .readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fileAttachmentLines(records) {
  return records.filter(
    (r) => r.type === "attachment" && r.attachment && r.attachment.type === "file"
  );
}

// Runs one headless probe: writes a uniquely-marked fixture, submits
// `@fixture.js<mentionSuffix> ...` via a live `claude -p`, waits for the
// transcript to land, force-kills the process, and returns the parsed
// transcript for the caller to assert on. Always cleans up the scratch
// dir, even on failure.
function runProbe(mentionSuffix) {
  const claudeBin = locateBinary(process.env);
  assert.ok(claudeBin, "locateBinary(process.env) found no claude binary — cannot run the live probe");

  const marker = "TKR_TRIPWIRE_" + crypto.randomBytes(6).toString("hex");
  const scratchDir = fs.mkdtempSync(
    path.join(REPO_ROOT, "test-tmp", "headless-tripwire-")
  );
  const fixturePath = path.join(scratchDir, "fixture.js");
  fs.writeFileSync(
    fixturePath,
    `// ${marker}\nfunction greet(name) {\n  return "hello " + name;\n}\nmodule.exports = { greet };\n`
  );

  const sinceMs = Date.now();
  const prompt = `@fixture.js${mentionSuffix} say ok and nothing else`;
  const child = spawn(claudeBin, ["-p", prompt, "--output-format=json"], {
    cwd: scratchDir,
    windowsHide: true,
    stdio: "ignore",
  });

  try {
    const transcriptPath = waitForCompletedTranscript(
      transcriptDirFor(scratchDir),
      sinceMs,
      SPAWN_TIMEOUT_MS
    );
    assert.ok(
      transcriptPath,
      `no completed transcript appeared under ${transcriptDirFor(scratchDir)} within ${SPAWN_TIMEOUT_MS}ms`
    );
    const records = parseTranscript(transcriptPath);
    const raw = fs.readFileSync(transcriptPath, "utf8");
    return { records, raw, marker };
  } finally {
    killTree(child.pid);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

test(
  "headless tripwire: @path:map produces no native file attachment",
  { skip: ENABLED ? false : SKIP_REASON },
  () => {
    const { records, raw, marker } = runProbe(":map");
    const attachments = fileAttachmentLines(records);
    assert.strictEqual(
      attachments.length,
      0,
      "expected zero native file attachments for @path:map, got: " +
        JSON.stringify(attachments.map((a) => a.attachment.filename))
    );
    assert.ok(
      !raw.includes(marker),
      "fixture body (marker token) must never appear in the transcript for @path:map"
    );
  }
);

test(
  "headless tripwire positive control: bare @path DOES attach the full file (detection sanity check)",
  { skip: ENABLED ? false : SKIP_REASON },
  () => {
    const { records, raw, marker } = runProbe("");
    const attachments = fileAttachmentLines(records);
    assert.strictEqual(
      attachments.length,
      1,
      "expected exactly one native file attachment for bare @path — if this fails, the " +
        "harness's attach behavior changed and the negative test above may be vacuous"
    );
    assert.ok(
      raw.includes(marker),
      "fixture body (marker token) is expected to appear in the transcript for bare @path"
    );
  }
);
