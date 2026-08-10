# tkr — Token Reducer

[![Latest release](https://img.shields.io/github/v/release/bpeers01/tkr-releases?label=release&sort=semver)](https://github.com/bpeers01/tkr-releases/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your Claude Code subscription has a weekly cap. tkr makes that cap go further.**

It works on four fronts at once: compresses bloated tool output before Claude reads it, collapses grep+read chains into one search, routes overflow work to cheap models when Opus is under pressure, and trims response verbosity. Same workflow, more Opus per week — no plan upgrade required.

Built for Claude Code on **Pro, Max, or Team**. API users get the same wins paid in dollars instead of cap headroom (`tkr gain --economics`). Binaries ship every release for macOS, Linux, and Windows; automated release-validation smoke testing currently covers Linux and Windows only (see Requirements). Single static binary, zero runtime dependencies.

> **What's new in v5.20.0** — The status line's usage meters now show
> *pace*, not just percentage. Your spend draws in a neutral colour
> against how far the window has actually elapsed: a green band means
> you're ahead of the clock, a bright band means you're burning faster
> than it, and no band means you're exactly on pace. The line is also
> simpler — six fixed sections plus a single alert — and a new
> `TKR_STATUSLINE_STYLE` setting picks between full bars, a compact
> layout for narrow terminals, and background-filled meters.
> Several fixes make tkr's command wrappers more trustworthy. Searches
> run through tkr's grep could report "no matches" for files it never
> actually looked at — too large, unreadable, or past an internal limit;
> it now hands those searches to your system grep, or says plainly that
> it couldn't finish instead of quietly claiming an empty result, and
> notes any files it skipped when it does find matches. `gh pr checks`
> works again with current GitHub CLI versions (it exited with an error
> that looked like a broken gh install). `git commit` run through tkr is
> no longer cut off partway through a slow pre-commit hook — a failure
> that left the commit lost while the change stayed staged. The
> keepalive kill switch (`TKR_KEEPALIVE_DISABLE=1`) now genuinely turns
> keepalive off, and leftover keepalive state from crashed sessions is
> cleaned up automatically. Handoffs now end with a ready-to-paste
> resume command for your next session, and the automatic carry-over
> after clearing a session tells you it happened — previously it worked
> silently and you couldn't tell it had fired. Claude itself reads
> slightly updated guidance the first time you launch it after
> upgrading.
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)
>
> **v5.19.0** — tkr stops treating a high percentage as an
> emergency when you still have plenty of runway. Being 85% through your
> weekly budget means something very different with eleven hours left in
> the window than with six days left, and tkr now reads the ratio rather
> than the number — so it stops nagging you to wrap up and hand off while
> you still have room to work. The statusline draws it: the usage meter
> shows your spend against how far the window has actually gone, so being
> ahead or behind is visible without doing the arithmetic.
> **Claude itself will behave a little differently the first
> time you launch it after upgrading**, because the guidance it reads was
> updated to match; set `TKR_PACE_ADJUST_DISABLED=1` if you want the old
> percentage-only behaviour.
> Three real bugs are fixed. tkr's own background commands could, in the
> wrong conditions, stage deletions in a different Git repository than the
> one it meant to look at — if you ever saw a pile of unexpected staged
> deletions appear, that was this, and `git reset` (never `git reset
> --hard`) recovers it. If you installed tkr manually rather than as a
> plugin, output compression was silently doing nothing at all: a required
> file was missing, the hook died on startup, and both the installer and
> `tkr doctor` still reported success. And the idle-session keepalive could
> wake a session while a question was waiting on your screen, throwing away
> the answer you were about to give.
> `tkr doctor` now actually runs each hook instead of just checking it is
> registered — the check that would have caught the compression bug
> immediately. Also new: tkr asks before loading a skill whose bundled
> reference files would dump more than 25,000 tokens into context,
> `tkr top` sorts sessions that need you to the top and reports real idle
> times, and clearing a session right after writing a handoff now loads
> that handoff for you instead of telling you to run `/continue`. New
> `/rehydrate` goes a step further: after a `/clear` it rebuilds the
> previous session's actual conversation from its transcript — every
> message and command, with the bulky tool output dropped — so you can
> pick up what you were *doing* rather than reading a summary of it.
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)
>
> **v5.18.0** — tkr's per-session hooks stop spawning
> processes. The statusline and the cache-keepalive watcher used to run as
> shell scripts that launched a handful of helper programs on every
> render and every tick; both are now built into the tkr binary and launch
> nothing. On Windows with many Claude Code sessions open at once, that
> pile-up made even a bare process start take 4–6 seconds and could push
> tkr's prompt hook past its time limit, silently dropping the turn's
> context — that's fixed. The statusline itself looks identical.
> **Existing installs don't switch over on their own**: the statusline
> command lives in your own `~/.claude/settings.json`, so re-run the
> installer after upgrading (the old scripts still ship and keep working
> until you do). Also fixed: black console windows no longer flash across
> the desktop on Windows when tkr refreshes its search index or graph in
> the background. `tkr doctor` now tells you *which* tkr plugin folder
> Claude Code is actually loading, so an upgrade that landed in the wrong
> one gets caught instead of looking successful. And phrasing like "don't
> edit anything" is no longer misread as an edit request when tkr
> suggests a worker.
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)
>
> **v5.17.0** — Work routing now advises instead of acting.
> Ask `tkr route advise "<task>"` which bounded worker fits a piece of
> work and you get the profile grid, the session's posture, and a shape
> hint; the same answer is offered as a one-line, overridable suggestion
> as you work. A spawn-time check refuses only the worker calls that are
> wrong by construction — an edit task handed to a read-only worker, or a
> model bigger than the profile you named — and it fails open, so a
> missing or slow check never blocks work. **The default changes from
> `off` to `advisory`**, so upgrading turns these suggestions on; set
> `[routing.work] mode = "off"` to keep the old behavior, or
> `TKR_WORK_ROUTE_DISABLED=1` to disable routing entirely. Savings figures
> are now priced at what carrying a token actually costs across a session,
> which is a more honest — and different — number, so don't compare
> savings across this upgrade. `/continue` also accepts an explicit
> handoff file path.
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)
>
> **v5.16.0** — `tkr top` gets more honest and more
> useful: `EFFORT` now shows the session's actual configured effort (a
> mid-session `/effort` change shows up on the next prompt) while the
> route recommendation moves to its own `REC_EFF` column, `CU%` is
> renamed `CU_SHARE` to match what it always measured, and a new
> `CU/MIN` column surfaces which session is burning capacity right now.
> Prompt-time hooks got much cheaper on Windows: a bash helper that cost
> ~9 process spawns per prompt is folded into the existing Node hook —
> under heavy multi-session load those spawns could blow the hook time
> budget and silently drop a turn's tkr context. And `tkr top` no longer
> rescans history on every 2-second refresh (~15x faster with many
> sessions).
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)
>
> **v5.15.0** — tkr can now be installed straight from the
> Claude Code plugin marketplace: `/plugin marketplace add
> bpeers01/tkr-releases`, then `/plugin install tkr` — the binary
> downloads and verifies itself on first use, no separate curl step
> required. `tkr grep` results are now annotated with the enclosing
> function or class, so a match can answer the question without a
> follow-up file read, and flags it doesn't recognize fall through to
> your system's own grep instead of refusing. Plus a cluster of
> reliability fixes: `tkr top` no longer shows a blank MODEL column or
> scrolls the screen instead of redrawing in place on Windows, and the
> 1h-TTL keepalive watcher had several silent-failure modes fixed —
> including a handoff-writing path that had gone dark since mid-July
> while the cache-refresh path kept working.
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)
>
> **v5.14.0** — Native work routing arrives as an
> **experimental, default-off** feature: tkr can recommend that a
> bounded task run on a cheaper packaged Claude worker instead of the
> main session, gated behind explicit opt-in modes (off by default;
> the most permissive mode remains unimplemented and refused). A new
> `tkr route eval` harness compares routing on vs. off on a bounded
> task corpus; its first live run confirmed the core plumbing against
> a real Claude Code binary (worker spawn/stop delivery is not yet
> live-confirmed) and made **no savings or effectiveness claim** —
> routing remains under evaluation.
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)
>
> **v5.13.1** — Grep correctness patch: `grep "a\|b"`-style
> BRE patterns no longer silently return zero matches through the rewrite
> layer (they fall through to native grep), `tkr grep` skips
> `.claude/worktrees/` shadow copies, and the embedded `tkr claude`
> prompt picks up sharper search/file-writing guidance.
>
> **v5.13.0** — Model-awareness release. The `tkr claude`
> effort matrix now spans six model columns — Fable 5 and Sonnet 5 join
> Opus 4.8/4.7, Sonnet 4.6 and Haiku 4.5 — with per-model calibration so
> the effort recommendation fits the model you're on. The route
> classifier learns a DowngradeModel recommendation when Opus is burning
> cap on trivial edits. `tkr top` now shows the PROJECT folder each
> session is open in plus a `tkr` flag for sessions launched via
> `tkr claude`, `tkr gain --fan-out` attributes subagent cost, and
> `tkr audit opus48-migration` checks migration consistency. Plus burn-
> leaderboard, keepalive-report, and graph-hash fixes.
> [Full notes →](https://github.com/bpeers01/tkr-releases/releases/latest)

## Is this for you?

Yes, if any of these sound familiar:

- You hit the **Opus weekly cap** mid-task and get bumped to Sonnet (or blocked)
- Long agentic sessions where **tool output floods the context window**
- You're paying per token via the **Claude API** and want everything bolted into one efficiency layer
- You want Claude to reach for `tkr_search` / `tkr_graph` instead of running grep+read chains

You'll get the most out of tkr on the **Pro / Max / Team subscription** doing real day-job development — multiple sessions, long contexts, agentic tasks. That's where the weekly Opus cap bites hardest and where saved tokens turn directly into more Opus time.

**Not for you if:** you rarely approach the weekly cap (tkr's wins scale with tool-output volume — light sessions see little change); your burn is dominated by model prose rather than tool output (output tokens are ~2% of cap burn, and tkr doesn't claim them); or you need every byte of tool output verbatim by default (filters are lossy by design — `TKR_LOSSLESS=1` (TOML-pipeline commands only) and `CTX:tee` artifacts are the escape hatches, but then tkr isn't saving you much).

## Install

### Claude Code Marketplace (simplest)

```
/plugin marketplace add bpeers01/tkr-releases
/plugin install tkr
```

No separate binary download — the plugin's launcher fetches and
verifies the matching platform binary the first time it runs. This
installs the **core** tier (hooks, compression, search, brevity). The
advanced tier (delegation, OpenRouter toggles, audit skills) isn't on
the marketplace yet — use the curl/PowerShell installer below with
`-- --plugin-advanced` for that.

### Full Plugin (curl / PowerShell)

The core token-efficiency suite — binary, hooks, compression, search, brevity:

```bash
# macOS, Linux, or Windows (Git Bash)
curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex
```

The installer auto-detects Claude Code and installs the **core** plugin tier by default. Add `-- --cli` to install the binary only, or `-- --plugin-advanced` (`-PluginAdvanced` on PowerShell) for the advanced tier: delegation, OpenRouter toggles, and the audit skills. `tkr status` shows the active tier.

### Activate hook integration

```bash
tkr init -g          # Claude Code (programmatic hook — auto command rewriting)
tkr init -g --gemini # Gemini CLI
tkr init -g --cursor # Cursor IDE
tkr init --codex     # Codex CLI (project rules — AGENTS.md awareness)
tkr init --agents    # Claude Code subagents (.claude/agents/*.md frontmatter)
tkr init --awareness-doc # also write TKR.md + @-import it into CLAUDE.md
```

> `tkr init` no longer writes the `TKR.md` awareness doc by default — the
> `tkr claude` system prompt already carries the playbook. Add
> `--awareness-doc` (alias `--tkr-md`) if you run plain `claude` and want it.

Claude Code, Gemini CLI, and Cursor rewrite commands automatically — no manual `tkr` prefixing needed after this.

<details>
<summary><strong>Other install methods</strong></summary>

#### Pin a specific version

```bash
# macOS / Linux / Git Bash
TKR_VERSION=v5.20.0 curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex -Version v5.20.0
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

### Launch through `tkr claude` (recommended)

`tkr claude` starts Claude Code with tkr's replacement system prompt: byte-stable across machines so prompt caching shares the prefix, leaner than the stock prompt it replaces, and carrying the tkr tool playbook (search-first, structural reads, delegation guidance) so no per-project `CLAUDE.md` plumbing is needed.

```bash
tkr claude                      # launch Claude Code with the tkr prompt
tkr claude --tkr-show-prompt    # print the materialized prompt path and exit
tkr claude --tkr-append         # layer on top of the stock prompt instead of replacing it
tkr claude --tkr-auto-deny      # also deny MCP servers with zero 30-day use
```

Sessions launched this way are flagged `tkr` in `tkr top` and auto-arm the keepalive watcher on 1h-TTL accounts.

## How It Works

Four independent levers, working together. You get the combined effect.

| Lever | What it does | Cap headroom recovered |
|---------|-------------|------------------------|
| **Compression** | Hooks rewrite commands so output passes through dedicated handlers or TOML filters before Claude reads it | median 73% on high-output commands (≥500 raw tok); near 0% on small outputs |
| **Search** | `tkr search` replaces grep/glob/read cycles with a single BM25 + tree-sitter query | 5–10× fewer context reads |
| **Delegation** | A native agentic loop routes overflow work to cheap OpenRouter models when `tkr signals` flags burn risk | Preserves Opus quota for complex work |
| **Brevity** | `/brevity` tightens model prose (lite / full / ultra) | Denser answers, faster reads — a UX lever (output is ~2% of cap burn), not a savings channel |

Above all four sits a live pressure classifier — `tkr signals` — that fuses rate-limit consumption, cache-miss rate, idle time, and context size into a single routing decision, surfaced on the statusline. `tkr usage burn` runs 16 burn detectors against your session history to pinpoint waste. `tkr report` produces a self-contained HTML snapshot you can share or save. `tkr gain` aggregates savings across the compression, search, and delegation channels into one number.

---

### Compression

With the hook installed, commands are automatically rewritten before execution:

```
git status       →  tkr git status        (compact status)
git diff         →  tkr git diff          (stat summary + compacted hunks)
ls               →  tkr ls                (extension-grouped listing)
grep "pattern"   →  tkr grep "pattern"    (matches grouped by file)
npm test         →  tkr test npm test     (error-focused output)
node --test      →  tkr node-test node --test  (TAP-parsed: failures + counts)
vitest run       →  tkr vitest vitest run  (banner/timing stripped, failures kept)
cat README.md    →  tkr cat README.md     (line-numbered, binary-safe)
env              →  tkr env               (capped at 25 lines)
```

12 dedicated handlers cover the highest-volume commands. 111 TOML filters
catch everything else. If tkr doesn't recognize a command, it passes
through unchanged — no risk, no surprises. `npx` / `pnpm exec` / `bunx` /
`uv run` wrappers are unwrapped and the inner command re-dispatched
(v5.9.0). Prefer hints over rewrites? Set `[hooks] mode = "suggest"` to
keep commands untouched and get a one-line tip instead, or list commands
in `exclude_commands` to opt them out entirely.

**Structured test parsing (v5.9.0):** `pytest` output keeps the
`FAILURES`/`ERRORS` blocks with `E`-line assert detail and strips
captured-output noise, headers, and progress dots. `node --test` runs
through a TAP reporter (`tkr node-test`) keeping failure diagnostics
and counts only. `vitest run` (v5.10.0, `tkr vitest`) compresses
banner/timing noise and keeps failure blocks — 78-92% savings on
passing runs. When a failing command's filter drops >30% of raw
bytes, the raw output is stored losslessly as a `[CTX:tee:<hash8>]`
artifact — `tkr expand CTX:tee:<hash8>` recovers it exactly.

**JSON-array columnization (v5.8.0):** JSON-array Bash output ≥2KB is
automatically reshaped into a compact columnar table and a
`[CTX:json-array:<hash8>]` marker is appended. The raw original bytes
are stored losslessly; compression only fires when the full output
(body + marker) is strictly smaller than the raw payload — no
information is ever lost. Arrays with mixed object shapes are bucketed
(`[CTX:json-array-bucketed:<hash8>]`). Retrieve the original with
`tkr expand CTX:<class>:<hash8>` or `tkr artifact show <id>`. Disable
with `TKR_JSON_COLUMNIZE=0`. Big `aws`/`gh`/`kubectl`-style JSON dumps
now reach the model as compact column tables backed by a retrievable
raw original.

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

MCP `tkr_search` also accepts `within=<CTX:...id>` — BM25 search scoped
to the rows of a single stored columnized artifact, so you can drill
into a compressed JSON dump without re-fetching the raw payload.
`within=` is MCP-only; there is no `--within` CLI flag.

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
tkr openrouter on minimax    # minimax/minimax-m2.5
tkr openrouter on deepseek   # deepseek/deepseek-v3.2
tkr openrouter on glm        # z-ai/glm-5.1
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

The statusline shows watcher state as `keepalive:watching | armed | fired@HH:MM | stale | off`. Tune the threshold via `TKR_KEEPALIVE_IDLE_MIN=N`. `TKR_KEEPALIVE_DISABLE=1` disables keepalive — the watcher (checked at start and re-checked every tick) and the interactive-answer activity signal; `TKR_HOOKS_DISABLED=1` turns the whole hook surface off.

---

### Progressive Disclosure

Diagnose and tune how Claude Code loads context per project — root `CLAUDE.md`, nested zone `CLAUDE.md`, path-scoped rules in `.claude/rules/`. tkr ships templates plus a transcript-driven analyzer that ranks the highest-leverage docs to write first.

```bash
tkr pd-tree                              # static view: what's eager / lazy / missing
# /pd-audit (Claude Code skill, not a CLI command) — scored snapshot of disclosure health
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

### Reports

Generate a self-contained HTML snapshot of your Claude Code efficiency. Three modes; `tkr report` with no arguments picks the best one for the data you have.

```bash
tkr report auto                  # auto-select — comprehensive if both datasets exist
tkr report install-impact        # before vs. after tkr was installed
tkr report version-progression   # efficiency per tkr version you've run
tkr report comprehensive         # everything in one document
tkr report install-impact --open     # write the file and open it in your browser (flags are per-mode)
tkr report install-impact --preview  # print a text summary to stdout, no file
```

Reports are redacted by default (project names and paths stable-hashed) so you can share one without leaking your codebase. Pass `--no-redact` (with paired confirm flag) if you want raw labels for your own use. Output lands under `<UserConfigDir>/tkr/reports/`.

What it actually shows: cap-units saved per channel, top burn drivers, before/after side-by-side, version-over-version trend lines, and which detectors flagged what. The report data model and redaction guarantees are documented in the release notes.

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
                          # when the prompt-cache TTL has been detected
tkr status                # alias for `tkr signals --current`
tkr top                   # live monitor of all Claude Code sessions (--wide for cost columns)
tkr doctor                # install/health matrix (PASS/WARN/FAIL); exit 0/2 (CI-friendly)
```

## What tkr Itself Costs

A token reducer has to earn back more than it spends. tkr's overhead,
by channel:

- **Hooks** run outside the model and cost context only for what they
  return — compression *replaces* tool output, the statusline costs
  zero, and advisory lines are delta-gated: the pressure state line
  appears only when a threshold band changes, and effort-routing
  verdicts stay on the statusline, entering context at most once per
  sustained mismatch per session.
- **Skill descriptions** cost ~25 tokens each in the session
  inventory; manual-only skills cost nothing until you invoke them.
- **The `tkr claude` system prompt** is smaller than the stock prompt
  it replaces and byte-stable across sessions, so prompt caching
  keeps it cheap.

Measure your own install any time: `/cache-footprint` reports tkr's
hook-injection overhead in tokens, and `/ctx-audit` scores your whole
startup payload.

## Plugin Skills

When installed as a plugin, tkr registers 9 core on-demand skills invocable with `/` inside Claude Code:

| Skill | What it does |
|-------|-------------|
| `/search` | Hybrid BM25 search across project code, docs, and diagrams |
| `/brevity` | Set output verbosity (lite / full / ultra) |
| `/compress` | Compress a specific tool output inline |
| `/status` | Plugin health, token savings summary, hook status |
| `/config` | Configure tkr settings |
| `/usage` | Per-session cost + model-mix view |
| `/handoff` | Structured handoff writer (drops to `.tkr/handoffs/<id>-YYYYMMDD-HHMM.md`); includes `/handoff prune` verb for cleaning stale files |
| `/continue` | Load prior-session carry-over: scans `.tkr/handoffs/*.md` (1 file auto-loads, N prompts), else JSONL fallback. Pairs with `/handoff`. `/resume-coach` kept as 30d alias. |
| `/rehydrate` | Rebuild a prior session's thread from its transcript after `/clear` — verbatim conversation + commands, tool output dropped (91–93% smaller). Tier 2 of the read side, between `/continue` and a full resume. |

### Advanced skills (opt-in)

13 more skills ship in the **advanced** install tier — install with `install.sh --plugin-advanced` (or `install.ps1 -PluginAdvanced`) to register them. The default `--plugin` install is the core tier and does not include them (nor the deprecated shell delegation cascade — the `delegate` MCP tool is the supported delegation path). `tkr status` shows which tier is active:

| Skill | What it does |
|-------|-------------|
| `/delegate` | Route a task to cheap models via the agentic loop or shell cascade |
| `/openrouter-on` / `/openrouter-off` | Toggle OpenRouter routing / restore subscription |
| `/semantic-on` | Enable semantic tool-output compression |
| `/ctx-audit` | Classify what's occupying the current context window |
| `/consumption-report` | Weekly/5h cap-burn report with top offenders |
| `/consumption-audit` | Drill into which commands drove the burn |
| `/cache-audit` | Audit cache usage and identify miss patterns |
| `/cache-footprint` | Measure tkr's own cache load |
| `/pd-audit` | Score progressive-disclosure setup — zone gaps, rule waste, eager-import cost |
| `/memory-compact` | Score auto-memory files for compaction (stale / redundant / verbose / shipped) and walk through trim/rewrite |
| `/hotspot` | Identify high-leverage refactor targets via transcript-pattern analysis |
| `/explore` | Read-only repo exploration via Task subagent — keeps the main agent's context clean while a child agent maps a subsystem |

## Verify Installation

```bash
tkr --version             # expected: tkr v5.20.0 (or newer)
tkr doctor                # health check — PASS/WARN/FAIL rows; exit 0 or 2
tkr verify                # run built-in filter tests (341 should pass)
```

Plugin status: `/status` skill inside Claude Code.

## Requirements

- **macOS**: 10.15+ (Intel or Apple Silicon) — binaries are built,
  checksummed, and cosign-signed every release; the automated
  release-validation smoke suite (INTEG-001) does not yet run on
  macOS, unlike Windows and Linux, so treat macOS as less
  release-tested until that gap closes
- **Linux**: x86_64, glibc 2.17+
- **Windows**: 10+ ([Git Bash](https://git-scm.com/downloads) or PowerShell 5.1+)
- No runtime dependencies — tkr is a single static binary
- Delegation requires `OPENROUTER_API_KEY`

## Troubleshooting

See [TROUBLESHOOTING.md](https://github.com/bpeers01/tkr-releases/blob/main/TROUBLESHOOTING.md) for common issues:

- Hook / PATH setup
- MCP server not appearing in `claude mcp list`
- `tkr.exe` locked during upgrade on Windows (installer auto-handles with rename-before-copy)
- Version mismatch after upgrade
- Statusline shows the wrong pressure / mode

## Security

Please do not report vulnerabilities through public issues. Use GitHub private vulnerability reporting: <https://github.com/bpeers01/tkr-releases/security/advisories/new>. See [SECURITY.md](SECURITY.md) for scope and response expectations.

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/bpeers01/tkr-releases/issues/new/choose). For suspected security issues, use the private reporting channel above instead.

This is the public binary distribution repo. Source code is maintained privately; this repo hosts release binaries, install scripts, and the issue tracker.

## License

MIT — see [LICENSE](LICENSE). The tkr name and logo are trademarks of the maintainer and are not covered by the MIT license; forks should use a different name.
