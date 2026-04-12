# tkr — Token Reducer

Cut LLM token costs by 60-90%. tkr is a CLI proxy that filters and compresses command outputs before they reach your AI coding assistant's context window.

Works with Claude Code, Gemini CLI, Cursor IDE, and Codex CLI. Supports 90+ commands out of the box.

## Quick Start

### CLI Only (binary + shell hook)

**macOS, Linux, or Windows (Git Bash):**

```bash
curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex
```

Then connect to your IDE:

```bash
tkr init -g          # Claude Code
tkr init -g --gemini # Gemini CLI
tkr init -g --cursor # Cursor IDE
tkr init --codex     # Codex CLI
```

### Full Plugin (Claude Code)

For the complete token-efficiency suite — hooks, skills, search, delegation, and brevity:

```bash
curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh -s -- --plugin
```

This downloads the binary and a plugin bundle with hooks, skills, delegation scripts, and adapters. If Claude Code is detected, plugin mode is used automatically.

<details>
<summary><strong>Other install methods</strong></summary>

#### Manual download

Grab the binary for your platform from the [latest release](https://github.com/bpeers01/tkr-releases/releases/latest):

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `tkr-darwin-arm64` |
| macOS (Intel) | `tkr-darwin-amd64` |
| Linux (x86_64) | `tkr-linux-amd64` |
| Windows (x86_64) | `tkr-windows-amd64.exe` |

Then make it executable and move it onto your `PATH`:

```bash
chmod +x tkr-darwin-arm64
mv tkr-darwin-arm64 ~/.local/bin/tkr
```

#### Pin a specific version

```bash
TKR_VERSION=v2.0.0 curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
```

#### Plugin bundle (manual)

Download `tkr-plugin.tar.gz` from the [latest release](https://github.com/bpeers01/tkr-releases/releases/latest) and extract to `~/.local/share/tkr/`:

```bash
mkdir -p ~/.local/share/tkr
tar xzf tkr-plugin.tar.gz -C ~/.local/share/tkr/
```

#### Verify download integrity

Each release includes `checksums.sha256` signed with [cosign](https://github.com/sigstore/cosign) keyless (sigstore OIDC). The install script verifies automatically; for manual checks:

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

With the hook installed, commands are automatically rewritten for token-optimized output:

```
git status       ->  tkr git status        (compact status)
git diff         ->  tkr git diff          (stat summary + compacted hunks)
ls               ->  tkr ls               (extension-grouped listing)
grep "pattern"   ->  tkr grep "pattern"    (matches grouped by file)
npm test         ->  tkr test npm test     (error-focused output)
```

You can also use tkr directly:

```bash
tkr git log             # truncated log with body summary
tkr read main.go        # line-numbered file view
tkr find . -name "*.go" # results grouped by directory
tkr gh pr list          # compact GitHub CLI output
tkr docker ps           # compact container listing
tkr curl https://api.example.com  # JSON response summarized
tkr <any command>       # auto-filtered or passthrough
```

## Plugin Features (Claude Code)

When installed as a plugin (`--plugin`), tkr provides four token-reduction capabilities:

| Capability | What it does |
|-----------|-------------|
| **Tool output compression** | Automatic filtering of all command output via hooks |
| **Semantic search** | BM25 search across project code, docs, and diagrams (`tkr search "query"`) |
| **Capacity-aware delegation** | Route tasks to Codex or Gemini CLI when approaching rate limits |
| **Output brevity** | Terse model prose with adjustable intensity (lite/full/ultra) |

**Available skills:** `/tkr-search`, `/tkr-delegate`, `/tkr-brevity`, `/tkr-compress`, `/tkr-status`, `/tkr-config`

## Track Your Savings

```bash
tkr gain               # overall savings summary
tkr gain --daily       # daily breakdown
tkr gain --economics   # savings in dollars
```

## Verify Installation

```bash
tkr --version          # check version
tkr verify             # run built-in filter tests
```

## Requirements

- **macOS**: 10.15+ (Intel or Apple Silicon)
- **Linux**: x86_64, glibc 2.17+
- **Windows**: 10+ ([Git Bash](https://git-scm.com/downloads) or PowerShell 5.1+)
- No runtime dependencies — tkr is a single static binary
- Plugin mode requires `tar` for bundle extraction

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/bpeers01/tkr-releases/issues/new/choose).

This is a binary distribution repo. The source code is maintained privately; this repo hosts releases, the install script, and the issue tracker.
