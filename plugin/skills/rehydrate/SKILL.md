---
name: rehydrate
description: Rebuild a prior session's thread after /clear — conversation kept, tool output dropped
triggers:
  - /rehydrate
  - "rehydrate the previous session"
  - "what was I doing before the clear"
  - "load the full thread from the last session"
user-invocable: true
---

# rehydrate — replay the prior session's conversation

Tier 2 of the read-side. `/continue` reads a curated handoff file (~1.6k);
this replays the **actual thread** from the prior session's transcript
(12–27k) with tool output dropped; `/continue --jsonl` writes a ~5k
skeleton. Reach for this one when you need what was actually *tried* —
commands, reversals, subagent findings — not a summary of it.

Run it **after `/clear`**, in the new session. The prior conversation is
frozen at `~/.claude/projects/<slug>/<old-sid>.jsonl`, complete and
readable; `/clear` starts a new file rather than emptying the old one.
Nothing needs to happen before the clear.

## When to use which

| | Use |
|---|---|
| A fresh `/handoff` file exists and its Next Action is enough | `/continue` |
| You need the reasoning, the failed attempts, the exact commands | `/rehydrate` |
| Both — handoff for the plan, thread for the detail | `/continue` then `/rehydrate` |

`/rehydrate` does not replace `/handoff`. A handoff synthesizes decisions
that were never written down, which needs the live model; extraction can
only carry what the session actually said.

## Arguments

- `/rehydrate` — picker over recent sessions
- `/rehydrate <sid-prefix>` — skip the picker (e.g. `/rehydrate 46d826cc`)
- `/rehydrate --thin` — conversation only, no command breadcrumbs

## Procedure

1. **List candidates** — `tkr rehydrate list --limit 3 --json`.
   Rows carry sid, age, user turns, worktree branch, and the session
   title Claude Code stored in the transcript.

   Read the `exclusion` field before showing anything. The live session is
   held back — by `TKR_SESSION_ID` when the environment has it, otherwise
   by the newest statusline telemetry file. If `exclude_source` is empty,
   the CLI is telling you it could not identify the live session: say so
   in the picker, because rehydrating the running session injects context
   this session already has.

2. **Pick.** With an explicit prefix argument, skip to step 3. Otherwise
   ask with `AskUserQuestion`: one option per row, plus the automatic
   *Other* for typing a prefix. Label each option with the title (fall
   back to the short sid); put `sid · age · N turns · branch` in the
   description. Rank by recency only.

   **Do not filter by worktree or cwd.** Rehydration is not in-place —
   the session worth rehydrating routinely ran in the main checkout while
   the live one runs in a worktree. Branch is a disambiguating column, not
   a predicate. Titles are not unique; title + age + branch identify a row.

3. **Extract** — `tkr rehydrate extract <sid-prefix> --json` (add
   `--no-cmds` for `--thin`). It writes the document under the tkr state
   dir and reports `path` and `doc_tokens`.

4. **Size gate.** If `doc_tokens` > 40000, say so and ask before reading —
   that is a large one-shot context load. Otherwise proceed.

5. **Read the document** with native `Read`, whole file. That read *is*
   the rehydration; do not skim it with search tools.

6. **Summarize in 3–5 lines** — where the session got to, what is pending,
   any blocker. Do not re-dump the thread; it is already in context.

## What the document is

Verbatim conversation and the commands that were run, chronological and
complete. Tool output is dropped as re-derivable, with three exceptions:
synthesized subagent conclusions, the plan of record
(`TaskCreate`/`TodoWrite`), and the last 15 tool results — the pending
decision often rests on those.

Completeness is what makes it safe: the turn that abandons an approach
travels with the approach, so a superseded plan cannot be mistaken for a
live one. Later turns supersede earlier ones — read it that way.

## What it cannot recover

- **A conclusion the session never wrote down.** If five commands ran and
  no turn stated the finding, no extraction rule gets it back — the output
  was dropped as re-derivable and the conclusion was never in the
  transcript. This is the known hole; it is closed at handoff time, by
  writing the finding down, not here.
- **Diffs.** File contents are on disk. Read the code, not the thread.
- **Subagent-created files.** A sidechain is a separate transcript; files
  written inside one appear in neither `Files edited` nor `Files read only`.
- **Truncated values** are marked `…[+N chars truncated]` inline. An
  unmarked value is complete.

## Cost and cache safety

91–93% smaller than the source session's message bytes — typically 12–27k
for a session that ran to 300k+. Real reduction is larger: the denominator
excludes per-turn harness re-injections, which never reach the transcript
and which only `/clear` resets.

The document is constructed and read at **first emission**, so it is
cache-safe under `.claude/rules/cache-awareness.md` § Mutation. Nothing
already sent is rewritten. This is also why the skill runs after the clear
rather than generating anything before it.

## Output hygiene

Extracted threads carry verbatim session content and absolute paths. They
are written to the tkr state dir (`~/.tkr/rehydrate/`), never into a repo.
Do not commit one, and do not paste one into an issue or PR.
