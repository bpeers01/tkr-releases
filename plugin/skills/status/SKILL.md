---
name: status
description: Dashboard showing session pressure, token savings, delegation history, and active modes.
triggers:
  - /status
  - show tkr status
  - token dashboard
---

# status

Unified dashboard for all tkr plugin capabilities. Shows current state and session metrics.

## Sections

### Pressure State
- Weekly rate limit usage (%)
- Session rate limit usage (%)
- Context window usage (%)
- Overall pressure classification (Healthy / Elevated / High / Critical)
- Trend direction (rising / stable / falling)

### Token Savings (This Session)
- Compression: tool output tokens saved
- Search: estimated tokens saved vs exploration
- Delegation: tokens offloaded to cheaper engines
- Total session savings

### Active Modes
- Brevity: off / lite / full / ultra
- Delegation: observe / advisory / assisted / managed / overflow
- Compression: enabled / disabled
- Search index: built / stale / missing
- Keepalive: on / off — eligibility from `tkr keepalive check`
  (1h-TTL accounts only; auto-armed by `tkr claude`, manual via
  `/tkr:keepalive`). When `on`, the SessionStart nudge has the
  model schedule a synthetic refresh at ~55m idle so the prefix
  cache survives the 1h cliff. Report the last fire time + count
  this session from `~/.tkr/playbook-events.jsonl`
  (`keepalive_armed`, `keepalive_fired`, `keepalive_suppressed`).
- Subagent activity: N active / M total this session
  (top types when present, e.g. Explore, Plan, codex-rescue).
  Live count: `tkr signals --json | jq .active_subagents`
  (reconciled spawn ledger vs completed subagent JSONLs, last
  5 min, current session only). Session totals + type breakdown:
  `tkr gain --cache-savings --json | jq .subagent_spawns` —
  emits `{total, by_type}` from `~/.tkr/task-spawns.jsonl`
  filtered by current `TKR_SESSION_ID`. Omit the line when both
  active and total are 0. Display-only signal per ADR
  `docs/proposals/2026-05-20-inv-023-subagent-awareness-diagnose.md`
  — classifier does NOT route on it.

### Recent Delegations
- Last N delegated tasks with status (pass / fail / skipped)
- Contract IDs for audit

### Repo Snapshot (per-turn cost)
- `git status: <N>/2000 chars (<pct>%)` — Claude Code captures `git status --short` at session start and re-injects the truncated snapshot every API call (cap = 2000 chars, source: `src/context.ts:20`). A bloated working tree silently inflates every turn.
- Warn at >1600 chars (80% of cap). Past 2000, the snapshot is mid-line truncated and a "(truncated...)" pointer replaces detail — Claude must shell out to `git status` to see the rest.
- Capture: `git --no-optional-locks status --short | wc -c` (matches Claude Code's invocation)
- Fix: commit or stash drift; verify `.gitignore` covers build artifacts (`dist/`, `coverage/`, etc.)

## Related Cache-Health Skills

`/status` reports live pressure + savings. For cache-specific analysis:

- **`/cache-audit`** — retrospective: parses `~/.claude/projects/**/*.jsonl`,
  reports hit rate by week + idle-gap bucket, worst misses, per-model cost.
- **`/cache-footprint`** — measures tkr's own hook-injection overhead
  (session-start + per-prompt + per-tool-call) against monthly volume.

Statusline also renders live cache signals: `idle:Xm`, `CLIFF`/`COOL`
badges (past TTL), `BIG`/`HUGE` badges (≥250k/500k context), `miss:~$X.XX`
(projected rebuild cost), and `hit:X%` (rolling 10-turn window).

## Status

**Implemented.** Telemetry package at `internal/telemetry/` tracks all four savings streams. History persisted in `.tkr/telemetry-history.jsonl`.
