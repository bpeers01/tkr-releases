---
name: handoff
description: Write structured handoff file mid-conversation; offer /clear after. Includes prune verb for stale files.
triggers:
  - /handoff
  - /handoff prune
  - "handoff this session"
  - "write continue-here"
  - "wrap up the session"
  - "clean up old handoffs"
user-invocable: true
---

# handoff — Playbook v2 L2

When a long session has accumulated significant context but the next
useful turn lives in a fresh prompt, write a structured handoff to
`.continue-here.md` and recommend `/clear`. Article 04 frames this as
the 9.1% ceiling on /clear-recoverable spend.

## When to invoke

- Self-invoked by Claude when the L2 detector advisory fires:
  classification ≥ high AND turn_count ≥ 80 AND cache_read_share_pct > 60.
- User-invoked at any time via `/handoff` (no precondition).

## Output contract — required sections

```markdown
# Continue-Here — <session-id> — <YYYY-MM-DD>

## Truths
- <Hard facts the next session must believe; locked decisions — with
  the rejected alternatives, so they don't get re-litigated>

## Artifacts
- <Files touched, branches, commits, PRs, environments; live expand
  handles (`CTX:`/`DELTA:` IDs) still worth retrieving>

## Key Links
- <Paths to ADRs, plans, tickets, relevant transcripts>

## Open Threads
- <Decisions deferred, blockers, half-finished tasks>

## Next Action
- <The single most-leverage action the next session should take first>

## Next-Session Posture
- <Recommended model + effort for the Next Action, with the reason>
```

All six sections are mandatory. Writer must reject input with any
section empty (except `Open Threads`, which can be `- none`).
`Next-Session Posture` (`next_session_posture` in the writer JSON) is
always populated — when the Next Action's shape is genuinely
ambiguous, the fallback is the default posture stated explicitly by
name ("Sonnet, Medium — Next Action's shape isn't distinctive enough
to justify escalating either axis"), not an empty section.

The body must NOT contain live session state — ctx size, turn
count, `[tkr:]` injection text, cache age, pressure verbs. Those
are snapshot-time only and become misleading the moment the next
session opens (the next /continue session reads the file at its own
baseline, not yours). Stick to Truths / Artifacts / Key Links /
Open Threads / Next Action.

## Output path

Default target: `.tkr/handoffs/<identifier>-YYYYMMDD-HHMM.md` (UTC).

Identifier resolution order (first non-empty wins):
1. `--name <slug>` flag or `TKR_HANDOFF_NAME` env
2. First 8 chars of the session UUID
3. `unknown-sid` (last-resort)

Each session writes its own file, keyed to the minute. The keepalive
watcher's single-fire gate keeps automatic writes at one per idle
window in practice, so back-to-back automatic writes to the same
filename don't happen. Manual re-invocation within the same session
and UTC minute is still possible (e.g. testing `/handoff` twice in a
row) — the writer never clobbers in that case; it disambiguates with
a numeric `-2`, `-3`, ... suffix instead. `.tkr/` is gitignored, so
files never appear in `git status`.

Override via `TKR_HANDOFF_TARGET` / `--target <path>`.

## Steps

1. **Gather** — survey the current conversation for each section.
   Be specific: cite file paths with line numbers, ADR numbers, etc.
   For decisions, capture the rejected alternatives alongside the
   choice — that's what stops the next session re-litigating. Include
   any expand handles worth keeping: `CTX:` IDs stay retrievable in
   later sessions via `tkr expand <id>`; `DELTA:` snapshots are
   session-scoped, so if a delta's content matters, restate it in
   Truths instead of relying on the handle.
   While gathering Truths, watch for **convention-class facts** —
   reusable rules of thumb the project should adopt (naming, layout,
   test-running, deploy gates). After writing, surface those in the
   post-write summary as candidate CLAUDE.md edits so the user can
   promote them on their own schedule. Do NOT auto-write CLAUDE.md
   from handoff — that busts the prefix cache (CACHE-001).
2. **Dry-run mode** — if invoked with `--dry-run`, print the preview
   to stdout and exit without writing.
3. **Write** — write the section JSON to a scratch file with the
   Write tool first (never a Bash heredoc for this payload — INV-115:
   Bash-tool heredocs >=~7.7KB reliably fail with an "unexpected EOF"
   shell parse error; transport-side chunking, not model-composed
   malformed content; the file-write-then-invoke sequence sidesteps
   the threshold unconditionally regardless of payload size), then
   invoke `scripts/write-continue-here.sh < <scratch-file-path>` as a
   separate Bash call. Writer is atomic (tmp + mv) and always writes
   (no confirm gate). Per-session filenames overwrite in place.
4. **Emit** — writer records `{layer:"L2", event:"taken", outcome:
   {action:"handoff_skill_invoked", savings_estimate_cu:...,
   latency_turns:0}}` to `~/.tkr/playbook-events.jsonl`. Suppress with
   `--no-emit` or `TKR_HANDOFF_NO_EMIT=1` for tests / unattended fires
   from the watcher's keepalive_fired path that want their own event
   class.
5. **Close** — the post-write summary MUST contain, in this order:

   a. "Handoff written to `<target-path>`. Recommend `/clear` next to
      reset the prefix cache cheaply; the carry-over auto-loads on the
      other side, no `/continue` needed."

   b. **The resume line, on its own line** — copy-paste fodder for
      after the `/clear`:

      ```
      /tkr:continue .tkr/handoffs/wave23-plans-corrected-20260809-2022.md
      ```

      **Relay it, don't compose it.** The writer prints
      `resume: /tkr:continue <path>` on stdout; reproduce that path
      character-for-character. It is the only party that knows the final
      filename, including any `-2`/`-3` collision suffix it picked, and
      a guessed name sends the next session to a file that doesn't
      exist. If the writer printed no `resume:` line (custom `--target`
      outside `.tkr/handoffs/`), omit the line rather than inventing
      one — `/tkr:continue` cannot resolve those paths anyway.

      Required every time the writer emits it, even when auto-inject is
      expected to fire: HAND-005 covers only `/clear`-sourced sessions
      with one handoff <10min old and <24KB, and this is the fallback
      for every other case. When the body *was* auto-injected,
      `/tkr:continue` sees the `<tkr-carryover>` block and stops without
      re-reading, so pasting the line costs nothing.

   c. **The posture line** — recommended model + effort for the Next
      Action, one sentence with the reason (see below). Always emit
      it; when the shape isn't distinctive, the line is the default
      posture stated explicitly by name ("Sonnet, Medium — nothing
      about the Next Action calls for escalating"), never silence.

   b and c are the two load-bearing lines of the whole summary — "how
   do I pick this up" and "should I change model/effort right after
   /clear" — and they render back-to-back, immediately after each
   other with nothing in between (no explanatory prose, no blank
   commentary line beyond the one paragraph break):

   ```
   /tkr:continue .tkr/handoffs/wave23-plans-corrected-20260809-2022.md
   Posture: Sonnet, Medium — nothing about the Next Action calls for escalating.
   ```

   HAND-005: SessionStart injects the body directly when the session
   started from `/clear` and this is the only handoff written in the
   last 10 minutes — which is exactly the state a `/clear` taken on
   this recommendation lands in. Outside that window the SessionStart
   advisory names the file and asks for `/continue` as before, so the
   claim degrades to a nudge rather than a lie. Do not promise more:
   `/clear` itself cannot be automated from any hook.

## Next-session posture (HAND-006)

`/handoff` → `/clear` → resume is the one moment where changing model or
effort is free: nothing worth keeping is cached yet. Mid-session those
changes bust the prefix (CACHE-001), and by the time `/continue` reads
the file the next session has already started on whatever was set — so
the *summary* line is the mechanism and the file section is a fallback
for handoffs picked up days later.

Derive the recommendation from the **shape of the Next Action**, not
from how this session felt:

- Classifier, routing, architecture, or measurement-design work →
  suggest e.g. "Opus, High" (or Fable where that's the house model).
- Filter/TOML batches, mechanical sweeps, doc edits → "Sonnet, Medium";
  say so explicitly, since the useful recommendation is often "don't
  escalate."
- Split the two axes with the AGENTS.md heuristic: escalate the **model**
  when the work needs knowledge the session lacked; escalate **effort**
  when it needs more tries, deeper search, or verification that got
  skipped.

Always name both the model and the effort level explicitly (Sonnet /
Opus / Fable × Low / Medium / High / XHigh / Max) — never "default
effort" or "escalate effort" as a stand-in for the actual tier. State
the reason in the same sentence ("Next Action is classifier morphology
→ Opus, High; word-boundary semantics need judgment, not throughput").
This is a policy heuristic with no outcome data behind it — the same
`calibration=assumed` standing as `tkr route advise` (ADR-0032 §4).
Never emit a bare "use Opus, High" with no reason, and never default to
escalation when the shape is ambiguous — the posture line still ships
every time, it just names the default tier explicitly ("Sonnet,
Medium") plus the reason nothing pushed off it,
instead of going silent.

## Read side — which resume verb

This skill is the write side. Three readers consume what it writes, and
the summary in step 5 should name the first one only; the others are for
when it turns out thin.

| Situation | Verb |
|---|---|
| Normal resume — the Next Action is enough | `/continue` (~1.6k, curated) |
| Handoff is stale, or you need what was actually *tried* — commands, reversals, subagent findings | `/rehydrate` (12–27k, prior thread verbatim, tool output dropped) |
| No usable handoff at all | `/continue --jsonl` (~5k skeleton) |

`/rehydrate` does not replace this skill and is not something to write
for: a handoff synthesizes decisions that were never written down, which
needs the live model; extraction can only carry what the session actually
said. It also needs nothing done before the `/clear` — the prior
transcript is frozen and complete on disk either way. The two compose:
handoff for the plan, thread for the detail.

## Behavior

The skill always writes. No interactive confirmation. This makes it
safe for unattended invocation (e.g., from the keepalive watcher's
synthetic-turn handoff). Users who want to inspect before persisting
should use `--dry-run`.

Each session writes its own file under `.tkr/handoffs/`. The keepalive
single-fire gate ensures at most one *automatic* write per idle window
in practice; a same-minute manual re-invocation disambiguates with a
`-2`, `-3`, ... suffix rather than overwriting (see Backing writer
below). The `.tkr/` directory is gitignored, so files never appear in
`git status`.

## Backing writer

`skills/handoff/scripts/write-continue-here.sh` performs the atomic
write + ledger emit. It accepts JSON on stdin describing the five
sections plus the optional `next_session_posture` string, and supports
`--dry-run`. It never clobbers an existing file
at the resolved target: on collision it appends a numeric `-2`, `-3`,
... suffix before writing, so no prior handoff (automatic or manual)
is ever silently destroyed.

### Session-id resolution (HAND-001)

The writer resolves the sid itself — `--session-id` flag, then
`TKR_SESSION_ID`, then `CLAUDE_CODE_SESSION_ID`. **Do not pass
`--session-id` from this skill**; a manual `/handoff` runs as a Bash
tool call, whose env carries `CLAUDE_CODE_SESSION_ID` but not
`TKR_SESSION_ID`, and the writer already reads it. The flag exists for
the keepalive watcher, which resolves its own sid from the CC stdin
payload via `hooks/keepalive/resolve-sid.sh` (stdin here is the section
JSON, so that resolver cannot run in-process).

### Provenance (HAND-002)

The writer decides provenance itself — **do not pass `--source` from
this skill**. Mechanical rule: if
`$TKR_STATE_DIR/keepalive/<sid>/fired-at` exists at write time, the
handoff is `keepalive` (a fire happened and no genuine user prompt has
arrived since — the activity touch in `user-prompt-submit.js`
(`hooks/lib/keepalive-activity.js`) deletes the marker on every real
prompt); otherwise `manual`; sid unresolved → `unknown`. The
`--source keepalive|manual` flag exists as an explicit override for
tests and future direct-invocation callers only. A model-passed flag
would make the measurement depend on the model remembering to pass it
— the HAND-003 defect class.

Provenance is recorded twice: `handoff_source` (+
`handoff_source_method`: `flag` | `state_gate` | `no_sid`) on the
ledger row, and a `<!-- tkr-handoff-source: ... -->` HTML comment on
line 2 of the file. `cache_channels.py` reads the marker instead of
inferring provenance from the filename shape; files without a marker
are legacy and keep the old filename rule.

Every emitted ledger row carries `session_id_source`
(`flag` | `tkr_env` | `cc_env` | `unresolved`). Only the first three
join to a transcript; `unresolved` keeps the legacy `"default"`
sentinel for reader back-compat and joins to nothing. A row with **no**
`session_id_source` field predates HAND-001 — its join status is
unknown, not "default". Any analysis that groups handoffs by session
must filter on the source field, not on the sid value.

Passing `--name <slug>` keeps the sid out of the *filename* but not the
file: the `# Continue-Here — <sid> — <date>` header is the join key for
topic-slugged handoffs.

## `/handoff prune` verb

Clean stale `.tkr/handoffs/*.md` files. Only the V2 layout is
managed — pre-migration `.continue-here.md` / `.continue-here.md.*.bak`
files from the old (deleted) V1 design are untouched legacy artifacts;
delete them manually if still present.

Invocations:
- `/handoff prune` — interactive: list `>7d` files (with mtime + Next
  Action preview), prompt per-file.
- `/handoff prune --all` — delete all `>7d` files without prompting.
- `/handoff prune --dry-run` — list only, no deletion.
- `/handoff prune --older-than <days>` — override 7d threshold.

Backed by `scripts/prune.sh`. JSON output for the interactive path
lets the model render previews and confirm per-file before deleting
selected ones via `prune.sh --delete <path>...`.

## Status

**Active.** Pure skill. No backing Go subcommand required. The writer
shell script handles atomicity + ledger emit so the skill body stays
focused on judgment and content quality.
