// hooks/lib/project-root.js
//
// Port of internal/signals/projectroot.go (resolveProjectRoot +
// resolveWorktreeRoot) so JS hooks slug the SAME directory the Go writer
// slugs. Keep the two in sync — the Go file is the reference
// implementation; behavior changes land there first.
//
// INV-040: hooks can fire from inside an agent-isolation git worktree (a
// distinct directory on disk, same session id as the main session).
// Slugging that raw cwd produces a second statusline path for the same
// sid — the Go writer resolves to the MAIN repository root before
// slugging, so a JS reader that slugs the worktree cwd looks for a file
// nobody writes and silently sees no telemetry. Worse, the write-side JS
// consumers (session-summary unlink, sessionstart sweep) target the
// wrong path, so the Go-written file is never cleaned up.
//
// Two cases, both anchored on the nearest ancestor with a `.git` entry:
//  1. Plain subdirectory of a repo — `.git` is a directory; that
//     directory IS the project root.
//  2. Linked git worktree — `.git` is a FILE containing
//     `gitdir: <path>/.git/worktrees/<name>`; that gitdir's `commondir`
//     file points (relatively unless absolute) back to the main repo's
//     real `.git` directory; the project root is its parent.
//
// Returns the raw cwd unchanged when no `.git` is found before the walk
// reaches the user's home directory or the filesystem root — callers
// fall back to slugging cwd directly, preserving pre-fix behavior.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// resolveWorktreeRoot reads a linked-worktree `.git` pointer file and
// returns the main repository's root directory, or "" when gitPath
// doesn't parse as a worktree pointer. Mirrors resolveWorktreeRoot in
// projectroot.go: the commondir file is read rather than assumed to be
// "../.." since git does not guarantee the exact nesting.
function resolveWorktreeRoot(gitPath) {
  let data;
  try {
    data = fs.readFileSync(gitPath, "utf8");
  } catch {
    return "";
  }
  const line = data.trim();
  const prefix = "gitdir:";
  if (!line.startsWith(prefix)) return "";
  let worktreeGitDir = line.slice(prefix.length).trim();
  if (worktreeGitDir === "") return "";
  if (!path.isAbsolute(worktreeGitDir)) {
    worktreeGitDir = path.join(path.dirname(gitPath), worktreeGitDir);
  }

  let commonRaw;
  try {
    commonRaw = fs.readFileSync(path.join(worktreeGitDir, "commondir"), "utf8");
  } catch {
    return "";
  }
  const commonRel = commonRaw.trim();
  if (commonRel === "") return "";
  let commonDir = commonRel;
  if (!path.isAbsolute(commonDir)) {
    commonDir = path.join(worktreeGitDir, commonRel);
  }
  return path.dirname(path.normalize(commonDir));
}

// resolveProjectRoot walks upward from cwd looking for the enclosing git
// repository and returns the MAIN repository's root directory. Returns
// cwd unchanged when the walk reaches the home directory or filesystem
// root without finding `.git` (not a git repo) — same fallback contract
// as the Go implementation.
function resolveProjectRoot(cwd) {
  let abs;
  try {
    abs = path.resolve(String(cwd));
  } catch {
    return String(cwd);
  }
  let homeDir = "";
  try {
    homeDir = os.homedir() || "";
  } catch {
    // best-effort; walk to filesystem root
  }

  let dir = abs;
  for (;;) {
    if (homeDir !== "" && dir === homeDir) return String(cwd);

    const gitPath = path.join(dir, ".git");
    let info = null;
    try {
      info = fs.lstatSync(gitPath);
    } catch {
      // no .git here; keep walking
    }
    if (info) {
      if (info.isDirectory()) return dir;
      const mainRoot = resolveWorktreeRoot(gitPath);
      if (mainRoot !== "") return mainRoot;
      // `.git` exists but isn't a directory and doesn't parse as a
      // worktree pointer (unexpected layout) — treat this directory as
      // the root rather than erroring; best-effort.
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return String(cwd); // filesystem root, no .git
    dir = parent;
  }
}

// Per-process memo: hooks are short-lived but several call
// getTelemetryPath more than once per invocation, and the walk stats the
// filesystem — resolution for a given cwd cannot change within one hook
// fire. Keyed by raw cwd string.
const memo = new Map();

function projectRootFor(cwd) {
  const key = String(cwd);
  if (memo.has(key)) return memo.get(key);
  const root = resolveProjectRoot(key);
  memo.set(key, root);
  return root;
}

module.exports = {
  resolveProjectRoot,
  resolveWorktreeRoot,
  projectRootFor,
};
