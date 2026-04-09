# tkr — Token Reducer

A CLI proxy that minimizes LLM token consumption by filtering and compressing command outputs. Achieves 60-90% token savings on common development operations.

## Install

### One-liner (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
```

### Manual download

Download the binary for your platform from the [latest release](https://github.com/bpeers01/tkr-releases/releases/latest):

| Platform | Binary |
|----------|--------|
| Linux x86_64 | `tkr-linux-amd64` |
| macOS Intel | `tkr-darwin-amd64` |
| macOS Apple Silicon | `tkr-darwin-arm64` |
| Windows x86_64 | `tkr-windows-amd64.exe` |

Then make it executable and place it on your `PATH`:

```bash
chmod +x tkr-*
mv tkr-* ~/.local/bin/tkr
```

### Pin a version

```bash
TKR_VERSION=v1.5.0 curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
```

## Set up Claude Code integration

After installing:

```bash
tkr init -g
```

This installs a global Claude Code hook that automatically routes commands through tkr for token-optimized output.

## Usage

Prefix any command with `tkr`:

```bash
tkr git status        # compact git output
tkr git diff           # filtered diff
tkr ls                 # filtered directory listing
tkr grep <pattern>     # matches grouped by file
tkr test <command>     # error-focused test output
tkr <any command>      # auto-filtered or passthrough
```

Check your token savings:

```bash
tkr gain               # savings summary
tkr gain --daily       # daily breakdown
```

## Verify installation

```bash
tkr --version
tkr verify             # run built-in filter tests
```

## Checksums

Each release includes a `checksums.sha256` file. The install script verifies checksums automatically. For manual verification:

```bash
sha256sum -c checksums.sha256
```
