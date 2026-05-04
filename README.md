# tkr — Token Reducer

[![Latest release](https://img.shields.io/github/v/release/bpeers01/tkr-releases?label=release&sort=semver)](https://github.com/bpeers01/tkr-releases/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

tkr is a token-efficiency platform for Claude Code users who hit the Opus cap. It compresses tool output, replaces grep/glob/read cycles with semantic search, runs a native agentic loop against cheap models when Opus is under pressure, and trims response verbosity — all surfaced in a unified savings ledger and live cap-burn console.

## Who this is for

Built for **Claude Code users on the Pro, Max, or Team subscription** who hit the 5-hour or weekly Opus cap during active development.

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

The installer auto-detects Claude Code and installs plugin mode by default. Add `-- --cli` to install the binary only.

### Activate hook integration

```bash
tkr init -g          # Claude Code (programmatic hook — auto command rewriting)
tkr init -g --gemini # Gemini CLI
tkr init -g --cursor # Cursor IDE
tkr init --codex     # Codex CLI (project rules — AGENTS.md awareness)
tkr init --agents    # Claude Code subagents (.claude/agents/*.md frontmatter)
```

Claude Code, Gemini CLI, and Cursor rewrite commands automatically — no manual `tkr` prefixing needed after this.

<details>
<summary><strong>Other install methods</strong></summary>

#### Pin a specific version

```bash
# macOS / Linux / Git Bash
TKR_VERSION=v3.5.0 curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex -Version v3.5.0
```

#### Manual download

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `tkr-darwin-arm64` |
| macOS (Intel) | `tkr-darwin-amd64` |
| Linux (x86_64) | `tkr-linux-amd64` |
| Windows (x86_64) | `tkr-windows-amd64.exe` |

Grab the binary from the [latest release](https://github.com/bpeers01/tkr-releases/releases/latest), make it executable, and place it on your `PATH`.

#### Verify download integrity

Each release includes `checksums.sha256` signed with [cosign](https://github.com/sigstore/cosign) keyless (Sigstore OIDC). The install script verifies automatically; for manual checks:

```bash
cosign verify-blob \
  --bundle checksums.sha256.bundle \
  --certificate-identity-regexp 'https://github.com/bpeers01/tkr/\.github/workflows/release\.yml@refs/tags/v.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  checksums.sha256

sha256sum -c checksums.sha256
```

</details>

## How It Works

tkr attacks cap burn on four fronts in parallel:

| Channel | What it does | Cap headroom recovered |
|---------|-------------|------------------------|
| **Compression** | Hooks rewrite commands so output passes through dedicated handlers or TOML filters before Claude reads it | 60–90% per filtered command |
| **Search** | `tkr search` replaces grep/glob/read cycles with a single BM25 + tree-sitter query | 5–10× fewer context reads |
| **Delegation** | A native agentic loop routes overflow work to cheap OpenRouter models when `tkr signals` flags burn risk | Preserves Opus quota for complex work |
| **Brevity** | `/brevity` tightens model prose (lite/full/ultra) | 20–40% output reduction |

A live pressure classifier (`tkr signals`) fuses rate-limit + cache-miss + idle + context-size into a single routing decision, surfaced on the Claude Code statusline. `tkr usage burn` runs 16 burn detectors against session history to pinpoint waste. `tkr gain` aggregates savings across all four channels.

---

### Compression

With the hook installed, commands are automatically rewritten before execution:

```
git status       →  tkr git status        (compact status)
git diff         →  tkr git diff          (stat summary + compacted hunks)
ls               →  tkr ls                (extension-grouped listing)
grep "pattern"   →  tkr grep "pattern"    (matches grouped by file)
npm test         →  tkr test npm test     (error-focused output)
cat README.md    →  tkr cat README.md     (line-numbered, binary-safe)
env              →  tkr env               (capped at 25 lines)
```

9 dedicated handlers cover the highest-volume commands. 95 TOML filters catch everything else. If tkr doesn't recognize a command, it passes through unchanged — no risk, no surprises.

Direct use also works:

```bash
tkr git log                 # truncated log with body summary
tkr read main.go            # line-numbered file view
tkr find . -name "*.go"     # results grouped by directory
tkr gh pr list              # compact GitHub CLI output
tkr docker ps               # compact container listing
tkr curl https://api.example.com  # JSON response summarized
tkr <any command>           # auto-filtered or passthrough
```

---

### Search

One query replaces 5–10 grep/glob/read cycles. BM25 lexical search + tree-sitter structural analysis, results ranked by source trust (repo docs > code > diagrams).

```bash
tkr search "query"                # search with ranked results
tkr search "query" --human        # human-readable output
tkr search "query" --context-pack # grouped multi-source results
tkr search --callers FuncName     # who calls this symbol?
tkr search --callees FuncName     # what does this symbol call?
```

---

### Delegation — tkr's Native Agentic Loop

The most powerful front. When Opus is under pressure — near the cap, burning fast, or working on tasks that don't need Opus-tier reasoning — tkr hands that work to a cheap model running in its own contained agent loop.

**How it works:** `tkr mcp delegate` is an MCP server embedded in the tkr binary. When you call it from a Claude Code session, it spins up a fully independent agentic loop that talks directly to OpenRouter models via HTTP. Claude Code stays in normal subscriber mode — there's no API-mode cutover, no session interruption. The cheap model runs inside a scoped filesystem jail (explicit read/write paths, no shell metacharacters), iterates until it produces a deliverable, then hands the result back as a clean markdown report + fenced JSON block.

**Setup:** add your OpenRouter API key, then the MCP server registers automatically at install time:

```bash
export OPENROUTER_API_KEY=sk-or-...
claude mcp list    # verify "tkr" is present
```

**Invoke from a Claude Code session:**

```
delegate(
  task        = "Write unit tests for internal/foo/bar.go",
  read_paths  = ["./internal/foo"],
  write_paths = ["./internal/foo"],
  tier        = "3",
  extra_system = "Tests use stdlib testing only — no testify. Table-driven preferred."
)
```

**Complexity tiers** — `tier` picks the right model automatically:

| Tier | Labels | Default model | $/M in/out | Use when |
|------|--------|---------------|-----------|---------|
| 1 | `trivial`, `triage` | `google/gemma-4-31b-it` | $0.13/$0.38 | Single-file lookup, doc snippet, one-shot edit |
| 2 | `simple`, `cheap` | `google/gemma-4-31b-it` | $0.13/$0.38 | One-file changes |
| 3 | `standard`, `coder` | `qwen/qwen3-coder-next` | $0.14/$0.80 | Multi-file package work, test writing |
| 4 | `complex`, `long` | `moonshotai/kimi-k2.5` | $0.44/$2.00 | Cross-package refactors, UI changes |
| 5 | `hardest`, `agentic` | `z-ai/glm-5.1` | $1.05/$3.50 | Terminal-orchestration, error recovery |

Good fits: unit test writing, boilerplate generation, grep-and-patch sweeps, structured analysis.
Bad fits: architecture decisions, multi-module refactors, tasks requiring Opus-tier reasoning.

Rule of thumb: if you can describe the success contract in two sentences and the deliverable as fenced JSON, delegate it. If not, keep it in Opus.

Every call returns run telemetry alongside the deliverable:

```json
{
  "call_id": "call-1777407100909012000",
  "cost_usd": 0.00042,
  "tokens_in": 1240,
  "tokens_out": 312,
  "cached_tokens": 880,
  "wall_ms": 2451
}
```

Inspect traces from the CLI or via the `delegate_status` MCP tool inside a Claude Code session.

---

### OpenRouter Routing

Beyond the delegation loop, `tkr openrouter on/off` routes Claude Code's own inference to OpenRouter-hosted models. Useful when a cheaper model is sufficient for the whole session.

```bash
tkr openrouter on gemma      # google/gemma-4-31b-it across all tiers
tkr openrouter on qwen       # qwen/qwen3-coder-next
tkr openrouter on kimi       # moonshotai/kimi-k2.5
tkr openrouter on deepseek   # deepseek/deepseek-r1-0528
tkr openrouter on vendor/model  # any raw OpenRouter slug
tkr openrouter off           # restore subscription routing
```

---

### Brevity

Three intensity levels, invoked via Claude Code skill:

```
/brevity lite    # tighten prose, remove filler (20% reduction)
/brevity full    # short sentences, dense code, minimal comments (30% reduction)
/brevity ultra   # maximum compression — use when context is critical (40% reduction)
```

Active mode is injected at session start and enforced on every prompt.

---

## Track Your Savings

```bash
tkr gain                  # unified summary across all four channels
tkr gain --daily          # daily breakdown
tkr gain --economics      # API-rate equivalent
tkr usage                 # per-session cost + model mix
tkr usage burn            # 16 burn detectors against session history
tkr signals               # live pressure classification (stay / offer / delegate)
```

## Plugin Skills

When installed as a plugin, tkr registers 16 on-demand skills invocable with `/` inside Claude Code:

| Skill | What it does |
|-------|-------------|
| `/search` | Hybrid BM25 search across project code, docs, and diagrams |
| `/delegate` | Route a task to cheap models via the native agentic loop |
| `/delegate-result-handling` | Post-delegation result validation and inline integration |
| `/brevity` | Set output verbosity (lite / full / ultra) |
| `/compress` | Compress a specific tool output inline |
| `/status` | Plugin health, token savings summary, hook status |
| `/config` | Configure tkr settings |
| `/usage` | Per-session cost + model-mix view |
| `/ctx-audit` | Classify what's occupying the current context window |
| `/consumption-report` | Weekly/5h cap-burn report with top offenders |
| `/consumption-audit` | Drill into which commands drove the burn |
| `/cache-audit` | Audit cache usage and identify miss patterns |
| `/cache-footprint` | Measure tkr's own cache load |
| `/semantic-on` | Enable semantic tool-output compression |
| `/openrouter-on` | Enable OpenRouter routing (alternative to CLI) |
| `/openrouter-off` | Disable OpenRouter routing and restore subscription |

## Verify Installation

```bash
tkr --version             # expected: tkr v3.5.0 (or latest)
tkr verify                # run built-in filter tests (292 should pass)
```

Plugin status: `/status` skill inside Claude Code.

## Requirements

- **macOS**: 10.15+ (Intel or Apple Silicon)
- **Linux**: x86_64, glibc 2.17+
- **Windows**: 10+ ([Git Bash](https://git-scm.com/downloads) or PowerShell 5.1+)
- No runtime dependencies — tkr is a single static binary
- Delegation requires `OPENROUTER_API_KEY`

## Troubleshooting

See [TROUBLESHOOTING.md](https://github.com/bpeers01/tkr/blob/main/docs/TROUBLESHOOTING.md) for common issues:

- `bash.exe.stackdump` on Windows (fixed in v3.0.0 via SIGPIPE trap)
- `tkr.exe` locked during upgrade (v3.0.0 installer catches this with rename-before-copy)
- Version mismatch after upgrade
- Hook / PATH setup
- MCP server not appearing in `claude mcp list`

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/bpeers01/tkr-releases/issues/new/choose).

This is the public binary distribution repo. Source code is maintained privately; this repo hosts release binaries, install scripts, and the issue tracker.

## License

MIT
