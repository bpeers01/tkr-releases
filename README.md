# tkr — Token Reducer

tkr is a Claude Code efficiency platform: compresses tool output, replaces grep/glob/read cycles with BM25 + tree-sitter search, routes overflow work to Codex or Gemini under pressure, and trims response verbosity — all aggregated into a unified savings ledger and live cap-burn console.

Recovers Pro/Max/Team subscription cap headroom, keeps you on Opus longer, and surfaces burn before it bites. Works with Claude Code, Gemini CLI, Cursor IDE, and Codex CLI. Ships 9 dedicated command handlers + 95 embedded TOML filters + 16 plugin skills out of the box.

## Who this is for

Built for **Claude Code users on the Pro, Max, or Team subscription** who hit the 5-hour or weekly Opus cap during active development sessions.

If you run Claude Code for real coding work — multiple sessions per day, long contexts, agentic tasks — you burn cap headroom faster than the plan's light-usage estimate predicts. tkr attacks the biggest sources of waste at source.

**Good fit:**
- Long agentic tasks where tool outputs flood the context window
- You hit the Opus weekly cap and get downgraded mid-task
- You want more Opus time per week without upgrading your plan

**Not for you if:** you pay per token on the API and already track dollar costs via a usage dashboard. The framing here is headroom, not dollars — though `tkr gain --economics` shows the API-rate equivalent if you want the conversion.

## Install

### Full Plugin (recommended for Claude Code users)

The complete token-efficiency suite — binary, hooks, skills, search, delegation, brevity:

```bash
# macOS, Linux, or Windows (Git Bash)
curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex
```

The installer auto-detects Claude Code and installs plugin mode by default. Add `-- --cli` to install the CLI binary only.

### Activate hook integration

After install, wire the hook into your IDE of choice:

```bash
tkr init -g          # Claude Code (programmatic hook — auto command rewriting)
tkr init -g --gemini # Gemini CLI  (programmatic hook — global only)
tkr init -g --cursor # Cursor IDE  (programmatic hook — global only, preToolUse)
tkr init --codex     # Codex CLI   (project rules — AGENTS.md awareness)
tkr init --agents    # Claude Code subagents (.claude/agents/*.md frontmatter)
```

Claude Code, Gemini CLI, and Cursor rewrite commands automatically — no manual `tkr` prefixing needed. Codex CLI uses an AGENTS.md project rule since it does not currently expose command-rewriting hooks.

<details>
<summary><strong>Other install methods</strong></summary>

#### Pin a specific version

```bash
# macOS / Linux / Git Bash
TKR_VERSION=v3.4.4 curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex -Version v3.4.4
```

#### Manual download

Grab the binary for your platform from the [latest release](https://github.com/bpeers01/tkr-releases/releases/latest):

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `tkr-darwin-arm64` |
| macOS (Intel) | `tkr-darwin-amd64` |
| Linux (x86_64) | `tkr-linux-amd64` |
| Windows (x86_64) | `tkr-windows-amd64.exe` |

Then make it executable and place on your `PATH`:

```bash
chmod +x tkr-darwin-arm64
mv tkr-darwin-arm64 ~/.local/bin/tkr
```

#### Plugin bundle (manual)

Download `tkr-plugin.tar.gz` from the [latest release](https://github.com/bpeers01/tkr-releases/releases/latest) and extract to `~/.local/share/tkr/`:

```bash
mkdir -p ~/.local/share/tkr
tar xzf tkr-plugin.tar.gz -C ~/.local/share/tkr/
```

#### Verify download integrity

Each release includes `checksums.sha256` signed with [cosign](https://github.com/sigstore/cosign) keyless (Sigstore OIDC). The install script verifies automatically; for manual checks:

```bash
# Verify cosign signature (recommended)
cosign verify-blob \
  --bundle checksums.sha256.bundle \
  --certificate-identity-regexp 'https://github.com/bpeers01/tkr/\.github/workflows/release\.yml@refs/tags/v.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  checksums.sha256

# Verify checksums
sha256sum -c checksums.sha256
```

</details>

## How It Works

tkr attacks cap burn on four fronts in parallel:

| Channel | What it does | Cap headroom recovered |
|---------|-------------|------------------------|
| **Compression** | Hooks rewrite commands so output passes through dedicated handlers or TOML filters before Claude reads it | 60–90% per filtered command |
| **Search** | `tkr search` replaces grep/glob/read cycles with a single BM25 + tree-sitter query | 5–10× fewer context reads |
| **Delegation** | Pressure-aware cascade routes overflow work to Codex/Gemini when `tkr signals` flags burn risk | Preserves Opus quota for complex work |
| **Brevity** | `/brevity` skill tightens model prose (lite/full/ultra) | 20–40% output reduction |

A live pressure classifier (`tkr signals`) fuses rate-limit + cache-miss + idle + context-size into a single routing decision, surfaced on the Claude Code statusline. `tkr usage burn` runs 16 burn detectors against session history to pinpoint waste; `tkr gain` aggregates savings across all four channels.

**Plugin skills** (invoke with `/`): `/search`, `/delegate`, `/brevity`, `/compress`, `/status`, `/config`, `/usage`, `/ctx-audit`, `/consumption-report`, `/consumption-audit`, `/cache-audit`, `/cache-footprint`, `/semantic-on`, `/openrouter-on`, `/openrouter-off`, `/delegate-result-handling`.

### Compression in action

With the hook installed, commands are automatically rewritten before execution:

```
git status       ->  tkr git status        (compact status)
git diff         ->  tkr git diff          (stat summary + compacted hunks)
ls               ->  tkr ls                (extension-grouped listing)
grep "pattern"   ->  tkr grep "pattern"    (matches grouped by file)
npm test         ->  tkr test npm test     (error-focused output)
cat README.md    ->  tkr cat README.md     (line-numbered, binary-safe)
env              ->  tkr env               (capped at 25 lines)
```

Direct use also works:

```bash
tkr git log                 # truncated log with body summary
tkr read main.go            # line-numbered file view
tkr head -20 Makefile       # first 20 lines
tkr tail -20 app.log        # last 20 lines
tkr find . -name "*.go"     # results grouped by directory
tkr gh pr list              # compact GitHub CLI output
tkr docker ps               # compact container listing
tkr curl https://api.example.com  # JSON response summarized
tkr <any command>           # auto-filtered or passthrough
```

## Track Your Savings

```bash
tkr gain                  # unified summary across all four channels
tkr gain --daily          # daily breakdown
tkr gain --economics      # API-rate equivalent
tkr usage                 # per-session cost + model mix
tkr signals               # live pressure classification (stay / offer / delegate)
```

## Verify Installation

```bash
tkr --version             # expected: tkr v3.4.4 (or latest)
tkr verify                # run built-in filter tests (292 should pass)
```

Plugin status is surfaced via the `/status` skill inside Claude Code.

## Requirements

- **macOS**: 10.15+ (Intel or Apple Silicon)
- **Linux**: x86_64, glibc 2.17+
- **Windows**: 10+ ([Git Bash](https://git-scm.com/downloads) or PowerShell 5.1+)
- No runtime dependencies — tkr is a single static binary
- Plugin mode requires `tar` for bundle extraction

## Troubleshooting

See [TROUBLESHOOTING.md](https://github.com/bpeers01/tkr/blob/main/docs/TROUBLESHOOTING.md) in the source repo for common issues:

- `bash.exe.stackdump` on Windows (fixed in v3.0.0 via SIGPIPE trap)
- `tkr.exe` locked during upgrade (v3.0.0 installer catches this with rename-before-copy)
- Version mismatch after upgrade
- Hook / PATH setup

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/bpeers01/tkr-releases/issues/new/choose).

This is the public binary distribution repo. Source code is maintained privately at `bpeers01/tkr`; this repo hosts release binaries, the install scripts, and the issue tracker.

## License

MIT
