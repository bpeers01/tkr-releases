---
name: usage
description: Inspect TKR cap-burn leaderboard, sessions, and turn-level cost via natural language.
triggers:
  - /usage
  - what is burning my cap
  - why was today expensive
  - what should I fix
---

# usage

Use this skill when the user asks "what's burning my cap", "why was today
expensive", "what should I fix", or similar subscription-efficiency questions.

Run `tkr usage burn --json` (or scoped variants below) and synthesize.

## Commands (always use --json)

- `tkr usage burn --json` — top 20 burn drivers, last 7d
- `tkr usage burn --lane tkr --json` — only TKR-fixable (🔧)
- `tkr usage burn --lane behavior --json` — only habit-fix (👤)
- `tkr usage burn --lane both --json` — both lanes (🔀)
- `tkr usage burn drivers --category file|command|model|skill|pattern|tool --json`
- `tkr usage burn tools --by type|target|turn-density|result-bloat --json`
- `tkr usage burn session <id_or_name> --json` — drill into one session
- `tkr usage burn turn <session> <n> --json [--explain]` — single-turn detail
- `tkr usage burn explain <row_id>` — underlying turns/events for a row
- `tkr usage burn export --format md|json [--include-names]`
- `tkr usage --cap-units --sessions --json` — session list cap-weighted

## Fix-lane tags

- 🔧 TKR-fixable (filter gap, cd-chain bypass, skill ROI, MCP bloat)
- 👤 Behavior-fixable (wrong model, no /clear, re-reading files)
- 🔀 Both (TKR nudges, user acts)

## Response format

Lead with the top-1 burn driver as a single sentence + lane tag + fix:

> "Your biggest burn is `Bash: gh run view --log` (6% weekly cap, 🔧 no TKR
> filter — INV candidate). Fix: add filter for gh run view output."

Drill-down only when user asks follow-up. Do not dump full JSON unless asked.

## ROI guardrail

Skill load cost must be < expected query value. Measure via
`tkr gain --utility --feature usage_skill`. Kill if net-negative.
