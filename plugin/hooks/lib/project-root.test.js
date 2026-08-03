// Tests for hooks/lib/project-root.js — INV-040 parity with the Go
// resolver. Mirrors internal/signals/projectroot_test.go: fixtures are
// built with the real git binary (skip when unavailable), and the
// linked-worktree case is the core regression — a hook firing from an
// agent-isolation worktree must resolve to the MAIN repository root so
// it agrees with the Go writer's slug.
//
// Run: node --test hooks/lib/project-root.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PR = require("./project-root");
const SP = require("./statusline-path");

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runGit(dir, args) {
  execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "pipe",
  });
}

// initGitFixture creates a repo at dir with one commit so
// `git worktree add` (which requires a commit) succeeds.
function initGitFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init"]);
}

// canonTempDir resolves symlinks (macOS /var → /private/var; CI 8.3
// short names) — git canonicalizes worktree gitdir pointers to long-form
// paths, so expected paths must be built in the same form.
function canonTempDir(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fs.realpathSync(tmp);
  } catch {
    return tmp;
  }
}

test("resolveProjectRoot: plain subdirectory resolves to repo root", (t) => {
  if (!gitAvailable()) return t.skip("git not on PATH");
  const tmp = canonTempDir("tkr-pr-plain-");
  try {
    const repoRoot = path.join(tmp, "repo");
    initGitFixture(repoRoot);
    const sub = path.join(repoRoot, "cmd", "tkr");
    fs.mkdirSync(sub, { recursive: true });

    assert.strictEqual(PR.resolveProjectRoot(sub), repoRoot);
    // The repo root itself resolves to itself.
    assert.strictEqual(PR.resolveProjectRoot(repoRoot), repoRoot);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveProjectRoot: linked worktree resolves to MAIN repo root (INV-040)", (t) => {
  if (!gitAvailable()) return t.skip("git not on PATH");
  const tmp = canonTempDir("tkr-pr-wt-");
  try {
    const repoRoot = path.join(tmp, "main-repo");
    initGitFixture(repoRoot);
    const worktreeDir = path.join(tmp, "agent-worktree");
    runGit(repoRoot, ["worktree", "add", worktreeDir, "-b", "agent-branch-" + Date.now()]);

    assert.strictEqual(PR.resolveProjectRoot(worktreeDir), repoRoot);

    // A subdirectory nested inside the worktree resolves the same way.
    const sub = path.join(worktreeDir, "cmd", "tkr");
    fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(PR.resolveProjectRoot(sub), repoRoot);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveProjectRoot: non-git directory returns cwd unchanged", () => {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const home = canonTempDir("tkr-pr-home-");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const tmp = canonTempDir("tkr-pr-nogit-");
    try {
      assert.strictEqual(PR.resolveProjectRoot(tmp), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveWorktreeRoot: non-pointer .git file returns empty", () => {
  const tmp = canonTempDir("tkr-pr-badptr-");
  try {
    const gitFile = path.join(tmp, ".git");
    fs.writeFileSync(gitFile, "not a gitdir pointer\n");
    assert.strictEqual(PR.resolveWorktreeRoot(gitFile), "");
    // resolveProjectRoot treats the unparseable layout as the root
    // (best-effort, matches Go).
    assert.strictEqual(PR.resolveProjectRoot(tmp), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("getTelemetryPath: worktree cwd produces the SAME path as main-root cwd (INV-040)", (t) => {
  if (!gitAvailable()) return t.skip("git not on PATH");
  const tmp = canonTempDir("tkr-sp-wt-");
  try {
    const repoRoot = path.join(tmp, "main-repo");
    initGitFixture(repoRoot);
    const worktreeDir = path.join(tmp, "agent-worktree");
    runGit(repoRoot, ["worktree", "add", worktreeDir, "-b", "agent-branch-" + Date.now()]);

    const sid = "sid-inv040-" + Date.now();
    const fromRoot = SP.getTelemetryPath(repoRoot, sid, tmp);
    const fromWorktree = SP.getTelemetryPath(worktreeDir, sid, tmp);
    assert.strictEqual(
      fromWorktree,
      fromRoot,
      "worktree cwd and main-root cwd must agree on one file — INV-040 fragmentation"
    );
    assert.strictEqual(
      path.basename(fromWorktree),
      "claude-statusline-" + SP.slugifyCwd(repoRoot) + "-" + sid + ".json"
    );

    // The sweep prefix must agree too, or SessionStart sweeps the wrong
    // family and Go-written files leak in $TMPDIR forever.
    assert.strictEqual(
      SP.getTelemetryGlobPrefix(worktreeDir),
      SP.getTelemetryGlobPrefix(repoRoot)
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("getTelemetryPath: non-git cwd slug unchanged (pre-fix behavior)", () => {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const home = canonTempDir("tkr-sp-home-");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const cwd = canonTempDir("tkr-sp-nongit-");
    try {
      const sid = "sid-nongit-" + Date.now();
      const got = SP.getTelemetryPath(cwd, sid, "/tmp");
      assert.strictEqual(
        got,
        path.join("/tmp", "claude-statusline-" + SP.slugifyCwd(cwd) + "-" + sid + ".json")
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("projectRootFor: memoizes per cwd", (t) => {
  if (!gitAvailable()) return t.skip("git not on PATH");
  const tmp = canonTempDir("tkr-pr-memo-");
  try {
    const repoRoot = path.join(tmp, "repo");
    initGitFixture(repoRoot);
    const first = PR.projectRootFor(repoRoot);
    // Remove the repo; the memo must still answer identically (the walk
    // must not re-run within one process).
    fs.rmSync(path.join(repoRoot, ".git"), { recursive: true, force: true });
    const second = PR.projectRootFor(repoRoot);
    assert.strictEqual(second, first);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
