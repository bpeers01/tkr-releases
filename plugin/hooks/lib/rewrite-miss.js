"use strict";

// Rewrite-miss telemetry — the denominator tkr has never had.
//
// Every adoption number today counts what DID go through tkr. Nothing
// counts what did not, so "tkr filtered 40 commands this session" has no
// companion figure and cannot be read as good or bad.
//
// ── What counts as a miss, and what deliberately does not ────────────
//
// Not every passthrough is interesting. `cd`, `echo`, and `true` pass
// through because no filter could ever apply to them, and recording
// those would produce a number dominated by commands tkr was never meant
// to touch — plus a JSONL append on essentially every Bash call.
//
// A MISS is narrower and much rarer: the command's head token IS in
// rewrite-heads.json — meaning tkr has a rule, a filter, or a wrapper
// lookup for that tool — and the binary still returned passthrough. That
// is "tkr knows about `git`, and could not do anything with THIS git
// invocation", which is the only passthrough anyone can act on. It names
// a real gap in the rules, and the head token says which tool to look at.
//
// Because the HOOK-003 fast path skips the subprocess entirely for heads
// that are not in the manifest, "we spawned the binary at all" is already
// the head-matched test. A miss is therefore exactly: spawned, exit 1.
//
// ── Why this cannot live in Go ───────────────────────────────────────
//
// internal/rewrite computes the same passthrough classification, and a
// counter there would look like the obvious home for it. It is not: the
// fast path means the most common passthroughs never reach the binary at
// all, so a Go-side counter would be measuring a filtered sample while
// appearing to measure everything. The hook is the only vantage point
// that sees both outcomes.
//
// ── What is recorded ─────────────────────────────────────────────────
//
// The head token only — `git`, `npm`, `docker`. Never the command, never
// its arguments: those carry paths, hostnames, and occasionally secrets,
// and the head alone answers the question this exists to answer. The
// token is clamped and rejected outright if it does not look like a bare
// command name, so a parsing surprise cannot smuggle a full command line
// into an append-only file.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("./state-dir");

const ADOPTION_FILE = "search-adoption.jsonl";
const ROTATE_BYTES = 2 * 1024 * 1024;

// MAX_HEAD is generous for a command name and far too small for a
// command line. Anything longer is a bug in the caller, not a long
// binary name.
const MAX_HEAD = 64;

// A bare command name: letters, digits, and the handful of punctuation
// real binaries use. No spaces, no slashes, no quotes, no shell
// metacharacters — all of which would indicate an argument came along.
const HEAD_RE = /^[A-Za-z0-9._+-]{1,64}$/;

function missDisabled() {
  return process.env.TKR_REWRITE_MISS_DISABLED === "1";
}

// normalizeHead returns a safe head token, or "" when the input does not
// look like one. Refusing is always correct here: an unrecorded miss
// costs a row, a mis-recorded one puts user command text on disk.
function normalizeHead(cmd) {
  if (typeof cmd !== "string") return "";
  const first = cmd.trim().split(/\s+/)[0] || "";
  if (first.length === 0 || first.length > MAX_HEAD) return "";
  // Strip a leading path so `/usr/bin/git` and `git` are one bucket —
  // they are the same tool and the same gap in the rules.
  //
  // Known limitation: a Windows path containing spaces
  // (`C:\Program Files\nodejs\node.exe`) splits at the space and buckets
  // as `Program`. Quoting does not help — the basename slice below drops
  // everything before the last backslash, quote included. That is a
  // wrong bucket LABEL and nothing worse: the result is still a single
  // path segment that had to clear HEAD_RE, so no argument text can
  // reach the row by this route. Not worth a shell-aware tokenizer on
  // the Bash hot path to fix a mislabeled row in a counts table.
  const base = first.slice(first.lastIndexOf("/") + 1);
  const win = base.slice(base.lastIndexOf("\\") + 1);
  return HEAD_RE.test(win) ? win : "";
}

// recordRewriteMiss appends one row. Best-effort in every direction:
// telemetry must never block, slow, or fail a Bash call.
function recordRewriteMiss(cmd, sid) {
  if (missDisabled()) return;
  try {
    const head = normalizeHead(cmd);
    if (!head) return;
    const { rotateIfLarge } = require("./rotate-jsonl");
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, ADOPTION_FILE);
    rotateIfLarge(p, ROTATE_BYTES);
    const row = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      kind: "rewrite_miss",
      head,
      sid: sid || process.env.TKR_SESSION_ID || undefined,
    };
    fs.appendFileSync(p, JSON.stringify(row) + "\n");
  } catch {
    // telemetry never blocks the hook
  }
}

module.exports = { recordRewriteMiss, normalizeHead, missDisabled, MAX_HEAD };
