# tkr — Token Reducer

tkr is a CLI proxy that reduces token consumption when AI agents read command output. It filters, compresses, and compacts output before it reaches the agent's context window — median ~73% reduction on filtered commands with substantial output (e.g. `git log`, `aws`, `kubectl`); small outputs shrink little.

## How it works

When you run `tkr <command>`, tkr:
1. Executes the command
2. Matches the command against TOML filter definitions
3. Applies a 9-stage filter pipeline (strip ANSI, replace, match output, strip/keep lines, truncate, head/tail, max lines, on empty, success truncation)
4. Prints the filtered output

For high-value commands (git, ls, cat, grep, test runners), tkr has dedicated Go filters that provide intelligent compaction beyond what TOML filters can do.

## Commands

- `tkr git status` — Grouped porcelain output (staged/modified/untracked)
- `tkr git log` — Compact log with truncated headers
- `tkr git diff` — Compact diff with hunk truncation
- `tkr ls` — Extension-grouped listing with size summary
- `tkr read <file>` — Line-numbered output with windowing
- `tkr read <file> --lines N-M` — Show only lines N through M (1-based inclusive); combines with `--level`
- `tkr grep <pattern>` — Matches grouped by file
- `tkr find [args]` — Results grouped by directory
- `tkr test <command>` — Error-focused test output
- `tkr gh pr|issue|run|api` — Compact GitHub CLI output; `gh api` JSON responses summarized and `gh run view --log` extracts errors from the middle of truncated logs
- `tkr docker ps|images` — Compact container and image listings
- `tkr curl <url>` — JSON responses summarized (null fields stripped, arrays capped at 20); non-JSON passes through

## Discovery & Analytics

- `tkr gain [--daily|--raw|--json|--economics|--project]` — Token savings report; `--economics` adds cost/ROI from session JSONL
- `tkr discover [--unfiltered|--filter-missed|--info|--json]` — Scan Claude Code sessions for filter opportunities; `--unfiltered` (base command has no filter → add one), `--filter-missed` (filter exists but regex missed these args → tune it); `--gaps` retained as alias of `--unfiltered`
- `tkr usage [--histogram|--model-mix]` — Per-session cost + model-mix views via ccusage × session-events × transcripts join
- `tkr usage show <session_id>` — Single-session drill-down (cost, turns, tools, top models)
- `tkr memory audit [--fix|--stale N]` — Classify ~/.claude memory files DEAD/OVERSIZED/STALE/GOOD; `--fix` deletes dead + updates index. Staleness is per-provenance (frontmatter `provenance:` — user-corrected 180d / user-stated 120d / observed 45d / inferred 7d; absent or unrecognized = 21d); `--stale N` forces one flat threshold for every entry
- `tkr candidates` — Rank tracked commands by token waste to identify filter priorities
- `tkr learn <command>` — Capture CLI corrections for future sessions
- `tkr trust [--update|--revoke|--list]` — Manage project filter trust (required before `.tkr/filters.toml` loads)
- `tkr verify` — Run inline TOML filter tests
- `tkr <any command>` — TOML filter lookup, passthrough if no match

## Hook integration

tkr integrates with Claude Code via hooks:

- **PreToolUse (`tkr-rewrite.js`)** — rewrites Bash commands to use tkr automatically
- **PreToolUse (`agent-search-inject.js`)** — injects tkr search guidance into Explore sub-agent prompts
- **PostToolUse (`post-tool-call.js`)** — compresses tool output; nudges toward tkr search after 3+ consecutive Read/Glob/Grep calls (includes auto-search results)
- **SessionStart (`tkr hook session-start`)** — injects search-first guidance and brevity mode
- **UserPromptSubmit (`user-prompt-submit.js`)** — brevity reinforcement

Run `tkr init` to install hooks.

### Subagent (Task tool) coverage

Plugin-level PreToolUse hooks do not fire inside Claude Code subagent
(Task tool) contexts by design — only hooks declared in each subagent
`.md` file's YAML frontmatter run during that agent's lifetime. Plugin
subagents cannot register frontmatter hooks (security restriction).

For user-owned subagents in `.claude/agents/*.md`, run
`tkr init --agents` (project scope) or `tkr init -g --agents` (global
at `~/.claude/agents/`). It injects the tkr PreToolUse Bash hook into
each file's frontmatter, is idempotent, and will not clobber
pre-existing `hooks:` blocks.

`tkr discover` separates subagent-sourced commands into a
`subagent_could_use_tkr` bucket so adoption-rate numbers aren't
inflated by the architectural bypass.
