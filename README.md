# tkr — Token Reducer

Cut LLM token costs by 60-90%. tkr is a CLI proxy that filters and compresses command outputs before they reach your AI coding assistant's context window.

Works with Claude Code, supports 60+ commands out of the box.

## Quick Start

Two steps — install the binary, then connect it to Claude Code.

### Step 1: Install

**macOS, Linux, or Windows ([Git Bash](https://git-scm.com/downloads)):**

```bash
curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
```

The installer automatically detects your OS and architecture, downloads the correct binary, and verifies its SHA256 checksum.

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
TKR_VERSION=v1.6.2 curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
```

#### Verify download integrity

Each release includes `checksums.sha256`. The install script verifies automatically; for manual checks:

```bash
sha256sum -c checksums.sha256
```

</details>

### Step 2: Connect to Claude Code

```bash
tkr init -g
```

Done. All future Claude Code sessions automatically route commands through tkr for token-optimized output. No manual prefixing needed.

## How It Works

With the hook installed, Claude Code commands are automatically rewritten:

```
git status       →  tkr git status        (compact status)
git diff         →  tkr git diff          (stat summary + compacted hunks)
ls               →  tkr ls               (extension-grouped listing)
grep "pattern"   →  tkr grep "pattern"    (matches grouped by file)
npm test         →  tkr test npm test     (error-focused output)
```

You can also use tkr directly:

```bash
tkr git log             # truncated log with body summary
tkr read main.go        # line-numbered file view
tkr find . -name "*.go" # results grouped by directory
tkr gh pr list          # compact GitHub CLI output
tkr docker ps           # compact container listing
tkr <any command>       # auto-filtered or passthrough
```

## Track Your Savings

```bash
tkr gain               # overall savings summary
tkr gain --daily       # daily breakdown
```

## Verify Installation

```bash
tkr --version          # check version
tkr verify             # run built-in filter tests (141 checks)
```

## Requirements

- **macOS**: 10.15+ (Intel or Apple Silicon)
- **Linux**: x86_64, glibc 2.17+
- **Windows**: 10+ with [Git Bash](https://git-scm.com/downloads) (included with Git for Windows)
- No runtime dependencies — tkr is a single static binary
