---
name: continue
description: Load carry-over from prior session via .continue-here.md or JSONL fallback.
triggers:
  - /continue
  - /handoff-resume
  - /load-handoff
  - /resume-coach
  - "resume from handoff"
  - "load continue-here"
  - "carry over from last session"
  - "summarize prior session"
user-invocable: true
---

# continue — load prior-session carry-over

Pairs with `/handoff`. `/handoff` writes a structured handoff file
under `.tkr/handoffs/` at end of session; `/continue` reads it at the
start of the next one. When no usable file exists, falls back to a
JSONL-derived compact summary.

Three tiers on the read side. This skill is tier 1 (handoff file, ~1.6k,
curated) and tier 3 (JSONL skeleton, ~5k, `--jsonl`). Tier 2 is
**`/rehydrate`** — the prior session's actual thread replayed from its
transcript, 12–27k, verbatim conversation with tool output dropped. Use
it when the handoff's summary is not enough and you need what was
actually tried: commands, reversals, subagent findings. The two compose —
handoff for the plan, thread for the detail.

Trigger names: `/continue` is primary; `/handoff-resume` and
`/load-handoff` are fallbacks in case `/continue` collides with a
Claude Code built-in. `/resume-coach` kept as 30-day alias for the
prior skill name.

## Skill arguments

- `/continue` — discover automatically (see decision tree below)
- `/continue <path>` — explicit handoff file, e.g.
  `/continue .tkr/handoffs/v5160-shipped-121-closed-20260804-0357.md`.
  Recognized as a path (not a prefix) when the argument contains `/`
  or ends in `.md`. Resolve relative to repo root; if it doesn't
  already start with `.tkr/handoffs/`, join it under that dir before
  checking existence. Skip discovery/glob/age-gating entirely — go
  straight to FILE PATH. If the resolved file doesn't exist, say so
  and stop; do not silently fall back to JSONL or prefix-match.
- `/continue <prefix>` — glob `.tkr/handoffs/<prefix>*.md`; 1 match
  loads, 0 falls to JSONL, many lists with preview
- `/continue --jsonl` — force JSONL fallback (skip on-disk handoffs)

## Decision tree

```
<tkr-carryover> block already in this session's context?
└── yes → STOP. Say which file is already loaded and stop. HAND-005
          auto-injected it at SessionStart; re-reading spends the
          tokens the /clear was taken to reclaim. Continue only if
          the user asks for a different file.

explicit path arg (contains "/" or ends ".md")?
└── yes → FILE PATH on that file (skip freshness gating, see above)

.tkr/handoffs/*.md present?
├── 1 file fresh (<24h)  → FILE PATH (auto-load, ~1-2K tok)
├── 1 file stale (24h-3d)→ FILE PATH + stale warning
├── 1 file >3d           → ignore; JSONL fallback
├── N > 1 files          → list with mtime + Next Action preview; prompt
└── 0 files              → JSONL fallback
```

## FILE PATH (default)

1. Read the resolved handoff file from `.tkr/handoffs/` (picked per
   decision tree) with native `Read` (small file, no map mode needed).
2. Summarize back to the user in 3-5 lines: position, top 1-2 next
   actions, any blockers. Don't dump the whole file. **Do NOT
   diagnose current session state** (ctx size, cache, pressure,
   `[tkr:]` advisories). A fresh `/clear`+`/continue` session is at
   baseline by definition; the system-prompt load is not "hot." Live
   state speaks for itself via injections — don't echo or interpret
   them in the handoff summary.
3. If mtime > 24h, lead the summary with: "Handoff is `<N>` days old —
   confirm still relevant before acting on its Next Action."
4. Recommend `/clear` only if invoked mid-session with hot context. If
   user just started fresh (or just did `/clear`), skip the recommendation.
5. Emit telemetry: `{layer:"L0R", event:"taken", outcome:{action:
   "file_read", file_age_h:<n>, savings_estimate_cu:~5000}}` via
   `hooks/lib/playbook-emit`.

## JSONL FALLBACK

Triggers when `.continue-here.md` is absent OR older than 3 days.

1. **Refresh cache** — `tkr continue scan-prior --json` ensures
   `~/.tkr/last-session-cw.json` is fresh (5min TTL).
2. **Build skeleton** — `tkr continue build --sid <current-sid>`
   writes `~/.tkr/resume-coach-<sid>.md` with `away_summary` and
   empty Truths/Artifacts/Open Threads/Next Action sections.
3. **Fill skeleton** — read the prior JSONL path from cache. Skim for:
   - Locked decisions / invariants → `## Truths`
   - Files / branches / commits / PRs → `## Artifacts`
   - Half-finished work → `## Open Threads`
   - Single highest-leverage next action → `## Next Action`
   Cap at 5K tokens total.
4. **Confirm gate (first 10 invocations of fallback path)** — preview
   and ask before declaring final. Track in
   `~/.tkr/continue-confirm-count.json`.
5. **Recommend `/clear`** — "Carry-over written to
   `~/.tkr/resume-coach-<sid>.md`. Run `/clear` next, then paste — that
   resets prefix cache cheaply while preserving the truths above."
6. **Emit** — `{layer:"L0R", event:"taken", outcome:{action:
   "jsonl_summary", savings_estimate_cu:..., latency_turns:0}}`.

## Output contract (JSONL fallback only)

```markdown
# Resume-Coach — Carry-over from <prior-session-id>
_Generated <timestamp>. Prior cum_cw = <N> tok across <M> assistant turns._

## Last away_summary
<verbatim from prior session>

## Truths
- <locked decisions, invariants>

## Artifacts
- <files touched, branches, commits, PRs>

## Open Threads
- <decisions deferred, blockers>  (or `- none`)

## Next Action
- <single most-leverage action>
```

The FILE PATH has no output contract — just summarize `.continue-here.md`
naturally; the user wrote that file already.

## When the hook fires

SessionStart (any source: startup, resume, compact, **clear**) emits
the advisory when:

- a handoff exists and mtime < 24h → "fresh handoff" nudge
- a handoff exists and mtime 24h-3d → "stale handoff" nudge
- No file, but prior session `cum_cw > 200K` with `away_summary` → JSONL nudge

Outside those bands the hook stays silent — user can still invoke
`/continue` manually any time (the skill is `user-invocable: true`).

**One case emits content, not a nudge (HAND-005).** When source is
`clear` AND exactly one handoff is <10min old AND it is <24KB, the hook
inlines the body in a `<tkr-carryover>` block and this skill has already
done its job before being invoked — see the first branch of the decision
tree. Any other combination falls back to the nudges above, so the
advisory is still the common case. Kill switch:
`TKR_AUTO_CONTINUE_DISABLED=1`.

## Backing CLI (JSONL path only)

`cmd/tkr/cmd_continue.go` exposes three verbs for the fallback:
- `tkr continue scan-prior` — refresh `~/.tkr/last-session-cw.json`
- `tkr continue show-cache` — debug print
- `tkr continue build` — emit skeleton to fill

`tkr resume-coach <verb>` accepted as 30d back-compat alias (target
removal: 2026-06-17). Internal Go symbols still carry `ResumeCoach`
names — internal-only, no rename planned.

## Status

**Active** — replaces `resume-coach` skill (proposal 2026-05-10 §L0R)
with file-first behavior. Rename + file-first logic shipped 2026-05-17.
