# Troubleshooting

## First, run `tkr doctor`

The doctor command prints a verification table covering the binary,
graph store, git hooks, PATH, plugin/MCP registration, config
placement, tracking DB health, trust store, delegate config,
search-index freshness, and hook collisions (DOCTOR-001 folded the
scattered audit verbs into sections; each still has a deeper
standalone command). Most install problems show up here as a clear
WARN or FAIL row with the fix in the detail column. Examples:

- "binary version: binary=X, plugin.json=Y" — reinstall; you have a
  mismatched binary
- "tkr on PATH: tkr not found on $PATH" — hooks will silently no-op;
  fix PATH
- "git hooks: missing: post-checkout, …" — run
  `tkr graph install-hooks`
- "graph store: no .tkr/graph/graph.db" — you're not in a project;
  cd into one and run `tkr graph build`
- "tracking db: quick_check failed" — see
  `tkr maintenance status|vacuum`
- "search index: stale" — run `tkr search --refresh`
- "hook collisions: non-tkr PreToolUse/Bash hook(s)" — another tool
  rewrites Bash on the same event; one rewriter's changes will lose

Doctor from outside a project shows several WARN rows by design — it
is checking your binary install, not per-project state. Check the
detail column for the specific fix.

---

## Windows

### `bash.exe.stackdump` appears in the working directory

**Cause**: MSYS2 bash receives SIGPIPE when Claude Code closes its read pipe before
the `tkr-rewrite.sh` hook finishes writing. Git Bash (MSYS2) converts the signal into
a crash dump written to the process's current working directory.

**Fix**: The default Claude Code hook is `tkr-rewrite.js` (Node.js), which avoids this
entirely. The `.sh` script is kept only for manual/debug use. If you see this dump:

1. Confirm your `~/.claude/settings.json` hook points to `tkr-rewrite.js`, not
   `tkr-rewrite.sh`. Re-run `tkr init -g` to reset.
2. The dump file is safe to delete. Add `*.stackdump` to your `.gitignore` to prevent
   accidental commits (tkr's own `.gitignore` already includes this).

---

### `tkr.exe` is locked during install — installer fails with "Access denied"

**Cause**: `tkr.exe` is held open by a running process (a Claude Code session, a
terminal with tkr in PATH, or a previous install that didn't finish).

**Fix**: Close all terminals and Claude Code windows, then re-run the installer. The
installer (v2.0.5+) detects the lock and exits with a clear error rather than silently
leaving the stale binary.

If you cannot close the process, manually rename the old binary before copying:

```powershell
Rename-Item "$env:LOCALAPPDATA\tkr\bin\tkr.exe" "tkr.exe.old"
# then re-run the installer
```

---

### `tkr --version` reports wrong version after install

**Cause**: The old `tkr.exe` is still cached in the current terminal's PATH resolution
or a shell alias shadows the new binary.

**Fix**: Restart your terminal. The installer (v2.0.5+) verifies the installed version
immediately after copy and warns if there is a mismatch.

To check manually:

```powershell
where.exe tkr          # should point to %LOCALAPPDATA%\tkr\bin\tkr.exe
tkr --version
```

If `where.exe` shows a stale path, remove it from your user PATH or prepend the correct
install dir (`$env:LOCALAPPDATA\tkr\bin`).

---

### The tkr hook does not run — Bash commands are not rewritten

**Cause**: Node.js is not installed, or `node` is not on PATH in Claude Code's
environment.

**Fix**: Install Node.js (LTS) from https://nodejs.org. After installing, restart
Claude Code so the new PATH is inherited.

To verify:

```powershell
node --version    # should print v18+ or v20+
```

If Node.js is installed but the hook still doesn't fire, check
`~/.claude/settings.json` for a `PreToolUse` entry pointing to `tkr-rewrite.js`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "node C:/path/to/tkr-rewrite.js" }
    ]
  }
}
```

Re-run `tkr init -g` to regenerate the correct entry.

---

### `tkr` not found in PATH after install

**Fix**: The installer adds `%LOCALAPPDATA%\tkr\bin` to your **user** PATH but the
current terminal session was open before the change. Open a new terminal.

To apply without restarting, run in PowerShell:

```powershell
$env:PATH = "$env:LOCALAPPDATA\tkr\bin;$env:PATH"
```

---

## macOS / Linux

### `tkr: command not found` after install

**Fix**: `~/.local/bin` may not be on your PATH. Add it to your shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then `source ~/.bashrc` (or `~/.zshrc`) and verify with `tkr --version`.

### Hook not running after `tkr init -g`

**Fix**: The hook is registered in `~/.claude/settings.json`. Verify the entry exists:

```sh
cat ~/.claude/settings.json | grep tkr-rewrite
```

If missing, re-run `tkr init -g`. If Claude Code was running during `init`, restart it.

---

## All platforms

### `tkr <cmd>` exits 1 for a missing binary where a shell reports 127

Intentional. When the wrapped binary doesn't exist (e.g. `tkr terraform
plan` without terraform installed), tkr reports the launch failure on
stderr and exits 1 — its standard user-error code — rather than
emulating the shell-specific 127/126 convention. Scripts that branch on
"command not found" should match the stderr message, not the exit code.
