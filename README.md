# tkr — Token Reducer

[![Latest release](https://img.shields.io/github/v/release/bpeers01/tkr-releases?label=release&sort=semver)](https://github.com/bpeers01/tkr-releases/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your Claude Code subscription has a weekly cap. tkr makes that cap go further.**

It works on four fronts at once: compresses bloated tool output before Claude reads it, collapses grep+read chains into one search, routes overflow work to cheap models when Opus is under pressure, and trims response verbosity. Same workflow, more Opus per week — no plan upgrade required.

Built for Claude Code on **Pro, Max, or Team**. API users get the same wins paid in dollars instead of cap headroom (`tkr gain --economics`). Works on macOS, Linux, and Windows. Single static binary, zero runtime dependencies.

> **What's new in v5.1.0** — `tkr report` ships as a full subcommand: generate a self-contained HTML snapshot of your Claude Code efficiency before vs. after tkr, version-by-version progression, or one comprehensive view. Cache TTL is now a first-class signal on the statusline. Plus a hardening sweep across hooks, MCP, delegation, and signals. [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)

## Is this for you?

Yes, if any of these sound familiar:

- You hit the **Opus weekly cap** mid-task and get bumped to Sonnet (or blocked)
- Long agentic sessions where **tool output floods the context window**
- You're paying per token via the **Claude API** and want everything bolted into one efficiency layer
- You want Claude to reach for `tkr_search` / `tkr_graph` instead of running grep+read chains

You'll get the most out of tkr on the **Pro / Max / Team subscription** doing real day-job development — multiple sessions, long contexts, agentic tasks. That's where the weekly Opus cap bites hardest and where saved tokens turn directly into more Opus time.

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
TKR_VERSION=v5.1.0 curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex -Version v5.1.0
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

Four independent levers, working together. You get the combined effect.

| Lever | What it does | Cap headroom recovered |
|---------|-------------|------------------------|
| **Compression** | Hooks rewrite commands so output passes through dedicated handlers or TOML filters before Claude reads it | 60–90% per filtered command |
| **Search** | `tkr search` replaces grep/glob/read cycles with a single BM25 + tree-sitter query | 5–10× fewer context reads |
| **Delegation** | A native agentic loop routes overflow work to cheap OpenRouter models when `tkr signals` flags burn risk | Preserves Opus quota for complex work |
| **Brevity** | `/brevity` tightens model prose (lite / full / ultra) | 20–40% output reduction |

Above all four sits a live pressure classifier — `tkr signals` — that fuses rate-limit consumption, cache-miss rate, idle time, and context size into a single routing decision, surfaced on the statusline. `tkr usage burn` runs 16 burn detectors against your session history to pinpoint waste. `tkr report` produces a self-contained HTML snapshot you can share or save. `tkr gain` aggregates savings across all four channels into one number.

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
tkr search "query" --read         # include full file content at matched line ranges
tkr search --callers FuncName     # who calls this symbol?
tkr search --callees FuncName     # what does this symbol call?
```

Available to Claude Code via the `tkr_search`, `tkr_read`, and `tkr_graph` MCP tools. The graph backend (SQLite + FTS5 over symbol names, qualified names, signatures, and docstrings) also exposes `op=implementors` (v5) for interface → satisfying-type lookups, `op=impact` for "what breaks if I change file Y?", and per-edge resolver provenance for debuggable confidence scores. Run `tkr graph install-hooks` once to keep the index fresh across branch swaps.

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

### Keepalive (1h-TTL accounts)

If you're on a 1h-TTL plan (Max 20×), tkr installs an `asyncRewake` watcher hook that refreshes the prompt-cache TTL during idle periods. The watcher polls in the background every 60 seconds and fires once per idle window at ~55 minutes — no synthetic mid-conversation turns, no `ScheduleWakeup` contract in the system prompt, no model-visible chatter. The next prompt after a long break hits a warm cache instead of paying ~$0.40+ in re-read tokens.

```bash
tkr keepalive check                # eligibility — confirms account is 1h-TTL
tkr keepalive watcher-state        # current session: idle seconds, threshold, fires-in
tkr keepalive prune-state          # remove orphan ~/.tkr/keepalive/<sid>/ dirs
```

The statusline shows watcher state as `keepalive:watching | armed | fired@HH:MM | stale | off`. Disable entirely with `TKR_KEEPALIVE_DISABLE=1`; tune the threshold via `TKR_KEEPALIVE_IDLE_MIN=N`.

---

### Progressive Disclosure

Diagnose and tune how Claude Code loads context per project — root `CLAUDE.md`, nested zone `CLAUDE.md`, path-scoped rules in `.claude/rules/`. tkr ships templates plus a transcript-driven analyzer that ranks the highest-leverage docs to write first.

```bash
tkr pd-tree                              # static view: what's eager / lazy / missing
tkr pd-audit                             # scored snapshot of disclosure health
tkr pd-replay --aggregate                # rank zone gaps and uncovered failures by real activity
tkr pd-replay --aggregate --scaffold --apply
                                         # write top-N zone CLAUDE.md from templates/zones/
tkr pd-replay --scaffold-corrections --apply
                                         # seed .claude/rules/cli-corrections.md (universal patterns)
tkr pd-replay --learn-corrections --apply
                                         # append project-specific failure patterns from transcripts
```

`pd-replay` reads your existing `~/.claude/projects/*` transcripts — no new instrumentation needed. Output ranks zones by `ops × sessions` so the recommended `CLAUDE.md` writes are the ones that pay back fastest. The shipped `cli-corrections.md` starter covers Windows-path / git / python / aws / gh failures observed as universal across multiple projects.

---

### Reports (new in v5.1.0)

Generate a self-contained HTML snapshot of your Claude Code efficiency. Three modes; `tkr report` with no arguments picks the best one for the data you have.

```bash
tkr report                       # auto-select — comprehensive if both datasets exist
tkr report install-impact        # before vs. after tkr was installed
tkr report version-progression   # efficiency per tkr version you've run
tkr report comprehensive         # everything in one document
tkr report --open                # write the file and open it in your browser
tkr report --preview             # print a text summary to stdout, no file
```

Reports are redacted by default (project names and paths stable-hashed) so you can share one without leaking your codebase. Pass `--no-redact` (with paired confirm flag) if you want raw labels for your own use. Output lands under `<UserConfigDir>/tkr/reports/`.

What it actually shows: cap-units saved per channel, top burn drivers, before/after side-by-side, version-over-version trend lines, and which detectors flagged what. The v5.1.0 release came with eight ADRs explaining the data model and redaction guarantees — see `docs/decisions/`.

---

## Track Your Savings

```bash
tkr gain                  # unified summary across all four channels
tkr gain --daily          # daily breakdown
tkr gain --economics      # API-rate equivalent
tkr usage                 # per-session cost + model mix
tkr usage burn            # 16 burn detectors against session history
tkr signals               # live pressure classification (stay / offer / delegate)
tkr signals --current     # compact one-line state for model-pull
                          # v5.1.0+ appends ttl=Ns/<source> (config|direct|inferred|default)
                          # when the prompt-cache TTL has been detected — ADR-0009
tkr status                # alias for `tkr signals --current`
tkr doctor                # 8-row install/health matrix; exit 0/2 (CI-friendly)
```

## Plugin Skills

When installed as a plugin, tkr registers 21 on-demand skills invocable with `/` inside Claude Code:

| Skill | What it does |
|-------|-------------|
| `/search` | Hybrid BM25 search across project code, docs, and diagrams |
| `/pd-audit` | Score progressive-disclosure setup — zone gaps, rule waste, eager-import cost |
| `/delegate` | Route a task to cheap models via the native agentic loop |
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
| `/memory-compact` | Score auto-memory files for compaction (stale, redundant, verbose, shipped-marker heuristics) and walk through trim/rewrite |
| `/semantic-on` | Enable semantic tool-output compression |
| `/openrouter-on` | Enable OpenRouter routing (alternative to CLI) |
| `/openrouter-off` | Disable OpenRouter routing and restore subscription |
| `/handoff` | Structured handoff writer (drops to `.tkr/handoffs/<id>-YYYYMMDD-HHMM.md`); includes `/handoff prune` verb for cleaning stale files |
| `/hotspot` | Identify high-leverage refactor targets via transcript-pattern analysis |
| `/continue` | Load prior-session carry-over: scans `.tkr/handoffs/*.md` (1 file auto-loads, N prompts), else JSONL fallback. Pairs with `/handoff`. `/resume-coach` kept as 30d alias. |
| `/explore` | Read-only repo exploration via Task subagent — keeps the main agent's context clean while a child agent maps a subsystem |

## Verify Installation

```bash
tkr --version             # expected: tkr v5.4.0 (or latest)
tkr doctor                # 8-row health check — PASS/WARN/FAIL; exit 0 or 2
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

- Hook / PATH setup
- MCP server not appearing in `claude mcp list`
- `tkr.exe` locked during upgrade on Windows (installer auto-handles with rename-before-copy)
- Version mismatch after upgrade
- Statusline shows the wrong pressure / mode

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/bpeers01/tkr-releases/issues/new/choose).

This is the public binary distribution repo. Source code is maintained privately; this repo hosts release binaries, install scripts, and the issue tracker.

## License

MIT
