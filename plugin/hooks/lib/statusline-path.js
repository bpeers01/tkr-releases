// hooks/lib/statusline-path.js
//
// Per-session namespacing for the shared statusline JSON. Mirrors the Go
// signals.TelemetryPath / signals.SlugifyCwd helpers so JS hooks, the
// statusline shell scripts, and the Go writer all agree on a single
// per-session file: $TMPDIR/claude-statusline-<slug>-<sid>.json.
//
// Why per-session, not per-project:
//   v0 (legacy): $TMPDIR/claude-statusline.json — cross-window stomp.
//   v1: $TMPDIR/claude-statusline-<slug>.json — fixed cross-project but the
//       first UserPromptSubmit of a new session read the previous session's
//       turn_count / last_ctx_k, producing stale `[tkr: t=N ctx=NK]` injection.
//   v2 (current): $TMPDIR/claude-statusline-<slug>-<sid>.json — fully scoped.
//
// Path resolution priority:
//   1. TKR_STATUSLINE_PATH — full path used verbatim (test override)
//   2. sid argument or TKR_SESSION_ID env → per-session path
//   3. neither → newest matching per-session file in tmpdir (read-side)
//
// The legacy per-project fallback (claude-statusline-<slug>.json without
// sid) was removed: nothing writes to it under per-session scoping, so
// any reads against that path served stale data from older tkr versions.
// See 2026-05-25 "stale 70% pressure" fix.
//
// Slug rules: replace `:`, `\`, `/` with `-`. Matches the form Claude Code
// uses for `~/.claude/projects/<slug>/` directory names.
//
// INV-040 parity: the cwd is resolved to the enclosing MAIN repository
// root (hooks/lib/project-root.js, port of internal/signals/projectroot.go)
// before slugging — the Go writer does the same, so a hook firing from an
// agent-isolation git worktree reads/sweeps/deletes the SAME file the Go
// writer writes instead of a worktree-slugged path nobody writes.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { projectRootFor } = require("./project-root");

function slugifyCwd(cwd) {
  return String(cwd).replace(/[:\\/]/g, "-");
}

// newestPerSessionPath scans tmpdir for files named
// claude-statusline-<slug>-*.json and returns the most-recently-modified
// one, or "" when none exist. Best-effort: readdir errors return "".
function newestPerSessionPath(tmpdir, slug) {
  const prefix = "claude-statusline-" + slug + "-";
  let entries;
  try {
    entries = fs.readdirSync(tmpdir);
  } catch {
    return "";
  }
  let newest = "";
  let newestMtime = 0;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const full = path.join(tmpdir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.mtimeMs > newestMtime) {
      newestMtime = st.mtimeMs;
      newest = full;
    }
  }
  return newest;
}

// getTelemetryPath returns the per-session statusline JSON path.
// sid may be passed explicitly or resolved from TKR_SESSION_ID env.
// When sid is empty, returns the newest matching per-session file so
// manual `tkr` invocations (no hook stdin) get a sensible snapshot.
// Returns the unscoped path when no per-session file exists — reads
// against that path will fail with ENOENT, which callers already handle.
function getTelemetryPath(
  cwd = process.cwd(),
  sid = process.env.TKR_SESSION_ID || "",
  tmpdir = process.env.TMPDIR || os.tmpdir()
) {
  const override = process.env.TKR_STATUSLINE_PATH;
  if (override) return override;
  const slug = slugifyCwd(projectRootFor(cwd));
  if (sid) {
    return path.join(tmpdir, "claude-statusline-" + slug + "-" + sid + ".json");
  }
  const newest = newestPerSessionPath(tmpdir, slug);
  if (newest) return newest;
  return path.join(tmpdir, "claude-statusline-" + slug + ".json");
}

// getTelemetryGlobPrefix returns the prefix used to glob per-session files
// for sweep — `claude-statusline-<slug>-`. The full pattern is
// `<prefix>*.json`. Used by the SessionStart sweep to drop stale files.
function getTelemetryGlobPrefix(cwd = process.cwd()) {
  return "claude-statusline-" + slugifyCwd(projectRootFor(cwd)) + "-";
}

// getTelemetryDir returns the tmpdir hosting statusline files. Companion to
// getTelemetryGlobPrefix so callers don't have to re-derive it.
function getTelemetryDir(tmpdir = process.env.TMPDIR || os.tmpdir()) {
  return tmpdir;
}

module.exports = {
  slugifyCwd,
  getTelemetryPath,
  getTelemetryGlobPrefix,
  getTelemetryDir,
  newestPerSessionPath, // exported for hooks/bench/statuslinepath-bench.js (HOOK-003d)
};
