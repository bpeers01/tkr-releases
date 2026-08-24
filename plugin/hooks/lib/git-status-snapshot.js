// hooks/lib/git-status-snapshot.js
//
// INV-097. A subagent that leaves the working tree in a state it never
// reported is invisible to any gate that reads a file's CONTENT to decide
// correctness — a wrong number in a baseline file is indistinguishable from
// a right one to a check that only reads the number. `git status
// --porcelain` on the worktree is what actually caught the original
// incident, not the agent's own prose. This module makes that check
// mechanical: snapshot at Agent spawn (PreToolUse), diff at SubagentStop.
//
// Snapshots are written as individual files under
// <stateDir>/agent-git-snapshots/, one per spawn, named
// `<session_id>.<timestamp>.<random>.json`. A directory of files, not a
// single per-session file, is the collision guard: parallel agents in the
// same session fire PreToolUse(Agent) concurrently, and a single shared
// file would have the second spawn's snapshot clobber the first's before
// either SubagentStop fires. popOldestSnapshot does a FIFO pop (oldest
// filename first) keyed only by session_id — Claude Code's SubagentStop
// payload carries no id that was visible at PreToolUse(Agent) time (no
// agent_id exists until the agent is actually spawned), so exact 1:1
// correlation across concurrent same-session spawns is NOT guaranteed.
// FIFO is a documented best-effort approximation, not a precise join: what
// matters for this check is catching tracked-file drift left on disk by
// SOME recent spawn in this session, not attributing it to the exact one.
//
// Fails open throughout: any missing git binary, non-repo cwd, unreadable
// state dir, or malformed snapshot file degrades to "no check possible"
// and never throws, blocks, or delays a spawn.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { stateDir } = require("./state-dir");

const SNAPSHOT_SUBDIR = "agent-git-snapshots";
const GIT_TIMEOUT_MS = 1500;

function snapshotDir() {
  return path.join(stateDir(), SNAPSHOT_SUBDIR);
}

// currentGitStatus returns the array of `git status --porcelain` lines for
// process.cwd(), or null when git is absent, the cwd is not a repo, or the
// call fails/times out for any reason. Never throws.
function currentGitStatus() {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
    });
    if (!res || res.error || res.status !== 0 || typeof res.stdout !== "string") {
      return null;
    }
    return res.stdout.split("\n").filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

// snapshotGitStatus records the current git status for this session,
// keyed so a concurrent spawn in the same session cannot overwrite it.
// Best-effort; swallows every failure.
function snapshotGitStatus(sid) {
  try {
    if (!sid) return;
    const lines = currentGitStatus();
    if (lines === null) return; // not a repo / no git — nothing to check later
    const dir = snapshotDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `${sid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ lines }));
  } catch {
    // Best-effort telemetry; must never block a spawn.
  }
}

// popOldestSnapshot removes and returns the oldest pending snapshot for
// this session ({lines: [...]}), or null when none exists or the read
// fails. FIFO by filename, which sorts chronologically because the
// timestamp is the leading numeric segment.
function popOldestSnapshot(sid) {
  try {
    if (!sid) return null;
    const dir = snapshotDir();
    const prefix = `${sid}.`;
    const entries = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort();
    if (entries.length === 0) return null;
    const target = path.join(dir, entries[0]);
    const raw = fs.readFileSync(target, "utf8");
    fs.unlinkSync(target);
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// diffTrackedMutations returns the porcelain lines present in `after` but
// not in `before`, excluding untracked entries ("?? path") — this check
// exists to catch mutation of files the repo already tracks, which is the
// class a gate reading that same file cannot itself detect. A brand-new
// untracked scratch file is not the failure mode INV-097 describes.
function diffTrackedMutations(beforeLines, afterLines) {
  const before = new Set(Array.isArray(beforeLines) ? beforeLines : []);
  const after = Array.isArray(afterLines) ? afterLines : [];
  return after.filter((line) => !line.startsWith("??") && !before.has(line));
}

module.exports = {
  snapshotDir,
  currentGitStatus,
  snapshotGitStatus,
  popOldestSnapshot,
  diffTrackedMutations,
};
