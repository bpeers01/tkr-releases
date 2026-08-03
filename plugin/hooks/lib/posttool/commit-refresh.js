// Commit-refresh: when the user runs git commit / merge / cherry-pick /
// rebase / reset via Bash, fire `tkr search --refresh` and
// `tkr graph build --quiet` detached so the next session-internal
// search/graph call sees fresh data — without waiting for the next
// SessionStart fire.
//
// Complements the git-side hooks installed by `tkr graph install-hooks`
// (post-checkout, post-merge, post-rewrite). Those handle branch swaps
// and rebase commits; git itself has no PostToolUse equivalent for
// `git commit` inside an active Claude session. The PostToolUse hook
// covers that gap.
//
// Singleton-locked downstream:
//   - doRefreshIndex acquires a 5-min proclock at ~/.tkr/locks/
//   - autoGraphBuild uses an mtime check; over-firing is a cheap no-op
// Over-firing is therefore safe; the worst case is a no-op cost <50ms.
//
// Kill switches (any one suppresses the spawn):
//   TKR_HOOKS_DISABLED=1                 — global hook kill (honored
//                                          upstream in post-tool-call.js)
//   TKR_POST_COMMIT_REFRESH_DISABLED=1   — feature-specific kill
//   TKR_SESSION_REFRESH_DISABLED=1       — shared with SessionStart
//                                          search-refresh, kills both
//
// The regex intentionally matches the git verb only — not `git
// commit --help`, not piped output mentioning "commit". TOOL_INPUT
// is a shell-command string; the verb appears as a whitespace-bounded
// token after `git`.

const { spawnBounded } = require("../spawn-bounded");

// Match `git <verb>` where verb mutates committed history.
// `reset` is included because `git reset` can rewrite the working tree
// in ways that change what `git diff HEAD` reports — the index becomes
// stale relative to the search content.
//
// `\bgit\s+(commit|merge|...)\b` so we don't match `mygit commit` or
// `git committed-changes` (synthetic, but cheap to be precise).
const GIT_MUTATING_RE =
  /\bgit\s+(commit|merge|cherry-pick|rebase|reset)\b/;

function shouldFire(event) {
  if (process.env.TKR_POST_COMMIT_REFRESH_DISABLED === "1") return false;
  if (process.env.TKR_SESSION_REFRESH_DISABLED === "1") return false;
  if (!event || event.tool_name !== "Bash") return false;
  const command = event.tool_input && event.tool_input.command;
  if (typeof command !== "string" || command.length === 0) return false;
  return GIT_MUTATING_RE.test(command);
}

// Spawn one detached `tkr` invocation; swallow all errors. The Go
// binary owns the singleton lock and short-circuits when the index
// is already fresh, so this is safe to over-fire.
function spawnDetached(args, timeoutMs) {
  try {
    const child = spawnBounded(
      "tkr",
      args,
      { detached: true, stdio: "ignore", windowsHide: true },
      timeoutMs,
    );
    if (!child) return;
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — never fail the hook
  }
}

// Public entry. Returns true when a refresh was scheduled (testable
// observable signal); the spawned commands themselves are fire-and-
// forget so we don't surface their status.
function maybeSpawnCommitRefresh(event) {
  if (!shouldFire(event)) return false;
  // 10s budget on each — both commands acquire their own lock and exit
  // immediately on contention or fresh-index short-circuit. The budget
  // is a hard cap, not an expectation.
  spawnDetached(["search", "--refresh"], 10_000);
  spawnDetached(["graph", "build", "--quiet"], 10_000);
  return true;
}

module.exports = {
  maybeSpawnCommitRefresh,
  // Exported for tests.
  shouldFire,
  GIT_MUTATING_RE,
};
