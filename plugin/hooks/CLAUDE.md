# hooks/ — Claude Code hook handlers

Zone-scoped guidance for tkr hook scripts (PreToolUse, PostToolUse,
SessionStart, PreCompact, Stop, SubagentStop, UserPromptSubmit,
InstructionsLoaded).

## Files

| Hook file | Event | Purpose |
|-----------|-------|---------|
| `tkr-rewrite.js` | PreToolUse(Bash) | Rewrite raw bash → `tkr <cmd>` for filtering |
| `agent-search-inject.js` | PreToolUse(Agent) | Auto-inject `tkr search` into Agent prompts; opt-in autoroute (COMPETE-002): downgrade Explore spawns to haiku on classifier `delegate_via` verdict; work routing (native-work-routing §13): record planned-vs-actual on every spawn, and at `mode = "assisted"` fill a compatible Agent call from the current work plan |
| `post-tool-call.js` | PostToolUse | Compress Bash output via TOML filter pipeline |
| `cli-corrections-injector.js` | PostToolUse(Bash) | Inject cli-corrections on Bash failure (PD-7) |
| `session-start.js` | SessionStart | Brevity reinforcement + tkr awareness banner |
| `pre-compact.js` | PreCompact | Snapshot session + nudge `/clear` over `/compact` |
| `memory-health.js` | Stop | Memory file rotation, dedup, staleness check |
| `user-prompt-submit.js` | UserPromptSubmit | Reinforce brevity mode on every prompt |
| `instructions-loaded.js` | InstructionsLoaded | Telemetry to `~/.tkr/instructions-load.jsonl` |
| `cache-bust-warn.js` | PreToolUse(Edit\|Write) | Warn before editing prefix-cache-critical files (PlaybookV2 L5) |
| `long-runner-warn.js` | PreToolUse(Bash) | Warn on watch/serve/follow commands that outlive the cache TTL (L4) |
| `skill-invoked.js` | PreToolUse(Skill) | Skill-invocation telemetry → `instructions-load.jsonl`. Schema v2 resolves `invocation_source` to `manual`/`auto` from the per-turn slash marker instead of always writing `unknown` |
| `subagent-outcome.js` | SubagentStop | Bounded outcome row per observed subagent stop → `subagent-outcomes.jsonl`. Records `completion:"stopped"`, never "completed" — the payload carries no status. Schema v2 also parses the worker's fenced `tkr-handoff` trailer into optional `declared_*` fields: a claim channel, not a verification one — `verification` stays `"not_observed"` on every row. Does not join; `tkr route stats` does that at read time |
| `session-summary.js` | Stop | End-of-session value report + statusline payload cleanup |
| `team-push.js` | SessionEnd | Debounced team telemetry push (opt-in; `TKR_TEAM_DISABLE=1`) |
| `keepalive/*.sh` | UserPromptSubmit / Stop / SessionEnd | Keepalive v2: activity signal, async-rewake watcher, cleanup |
| `statusline.{sh,ps1}` | (statusLine) | Pressure indicators in prompt box |

## Hook contract

- **Stdin** — JSON payload from Claude Code; schema per event type
  (https://code.claude.com/docs/en/hooks)
- **Stdout** — JSON response. `{}` proceeds. PreToolUse/PreCompact may
  return `{"decision":"block","reason":"..."}`. PostToolUse may return
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`
  to inject context.
- **Stderr** — debug only; never relied on for control flow.
- **Exit code** — non-zero treated as failure; hook silently skipped.
  Don't use exit codes for decisions.

## Stability rules

- Return in <100ms on hot path; offload heavy work to detached
  subprocesses or cached files.
- Tolerate malformed/missing stdin — JSON-parse failure → write `{}`.
- Tolerate missing state dirs — `fs.mkdirSync(..., { recursive: true })`.
- Never write to stdout except the JSON response. Other output appears
  as a hook error to the user.
- Best-effort telemetry — wrap appendFileSync in try/catch with no-op
  catch.
- **Master kill switches must be honored at module top.**
  `TKR_HOOKS_DISABLED=1` and any feature-specific `TKR_*_DISABLED` flag
  must short-circuit BEFORE stdin handlers, timers, or exit-time logs
  are registered. A check buried inside `stdin.on('end')` still pays
  the full stdin-read timeout and the exit-time telemetry append on
  every invocation — defeating the kill switch's purpose.
- **`memory-health.js` is a parallel port of the Go classifier, not a
  caller of it.** `classify()`, the dead/forward keyword sets, the size
  threshold, and the per-provenance stale table are duplicated from
  `internal/cmd/memory.go` with no shared constant — the hook cannot
  shell out to `tkr` inside a 500ms Stop budget. Any change to one side
  must be made to the other in the same commit. The two test files
  (`hooks/memory-health.test.js`, `internal/cmd/memory_test.go`) assert
  the same cases so a one-sided edit fails on the side that was not
  edited; that is the only thing standing between these files and silent
  divergence. New per-file work in the classifier must stay I/O-free —
  the budget already pays a read and a stat per file.
- **Hot-path JSONL writers must rotate before append.** Any file
  appended on every hook fire (e.g. `hook-timings.jsonl`,
  `decisions.jsonl`) calls `rotateIfLarge(target)` from
  `hooks/lib/rotate-jsonl.js` before `appendFileSync`. Reader-side code
  (`search-refresh.js` etc.) already expects rotated files; if you
  add a new high-rate writer without rotation it will grow to hundreds
  of MB on heavy users. Pure-observability writes (timing logs, perf
  counters) should ALSO be gated behind an env flag like
  `TKR_HOOK_TIMINGS=1` — off by default, on for debugging.

## State files

Convention: `~/.tkr/<feature>.{json,jsonl}` (honor `TKR_STATE_DIR` env):
- `instructions-load.jsonl` — InstructionsLoaded telemetry (PD-1) and
  `skill-invoked` rows (schema v2). `invocation_source` is now resolved
  rather than hedged: `manual` when the turn's prompt opened with
  `/<skill>`, `auto` otherwise, and `unknown` only when no skill name was
  supplied and the question could not be asked. Manual-vs-auto is the
  whole distinction between "the skill triggered" and "the user typed the
  command", so a ledger that says `unknown` everywhere cannot measure
  triggering at all.
- `slash-marker-<sid>.json` — one-turn record that the user's prompt was
  a slash command, written by `user-prompt-submit.js` (the only hook that
  sees the raw prompt) and read by `skill-invoked.js` (which fires later
  and holds a skill name but no prompt). Written ONLY on slash-command
  turns, so ordinary prompts pay one regex and no I/O. Scoped by
  `prompt_id` with a 60s TTL as the backstop, so a marker cannot make a
  later turn's auto trigger look manual. Honors
  `TKR_SKILL_AUDIT_DISABLED=1`. The alternative — deriving manual-vs-auto
  at read time from the session transcript — was rejected because the
  transcript rotates and the ledger is meant to outlive it.
- `decisions.jsonl` — shared audit ledger, discriminated by `event`:
  delegation rows, `route-classified` (Go), `autoroute`, and
  `work-directive` (one row per coordinator directive that actually went
  out — the follow-rate denominator; a plan that stayed silent leaves no
  row). Writers must use `ts`, not `at`: every reader keys on `ts`, so a
  row with `at` has no timestamp as far as any window is concerned.
- `task-spawns.jsonl` — one row per Agent/Task dispatch (schema v3).
  Carries `prompt_id` + `tool_use_id` (lifecycle join anchors, always
  written, empty when Claude Code supplied none) and, when a plan was
  current, planned-vs-requested-vs-emitted routing fields. Never
  "actual" — a later hook or a global subagent-model override can still
  change what runs.
- `subagent-outcomes.jsonl` — one row per observed SubagentStop (schema
  v2). The closing half of the spawn→outcome join. Deliberately excludes
  `last_assistant_message` and `transcript_path`: neither is needed to
  answer whether a plan produced a worker that ran, and a local ledger is
  a poor place to accumulate transcript text. v2 *reads*
  `last_assistant_message` to parse the worker's fenced `tkr-handoff`
  trailer and records none of it — only `declared_outcome`
  (`answered`/`partial`/`unanswered`), `declared_gaps` and
  `declared_assumptions`, all optional and all omitted when the worker
  emitted no block, so such a row is byte-identical to a v1 row apart
  from `schema_version`. Those three are the worker's own claim and are
  never folded into `verification`, which still reads `"not_observed"` on
  every row this version writes; separate fields make summing a
  self-report into a verification count impossible rather than merely
  discouraged. Parser stays cheap on the hot path: last 4096 bytes only,
  digits-only counts clamped to 99, a block without `outcome` rejected,
  last block wins. Full contract, including the join precedence and what
  tkr cannot observe: `docs/routing-outcomes.md`.
- `trajectory.json` — cap projection cache
- `anomaly.json` — burn anomaly cache
- `hook-timings.jsonl` — hook elapsed_ms per call
- `shape-advisor-<sid>.json` — session-shape advisor (L7) dedup + CU baseline
- `route-nudge-<sid>.json` — sustained-mismatch streaks + once-per-session
  dedup for the route/shape injections (ADR-0010 verdict-channel addendum;
  the per-turn verdict itself lives on the statusline `RT:` badge)
- `route-current-<sid>.json` — the session's CURRENT route verdict, and the
  authoritative transport from `tkr route classify` to UserPromptSubmit.
  Written atomically by the Go binary (one owner, once per prompt, never
  without a session id); read via `hooks/lib/route-state.js`, which
  validates schema version, session id, prompt hash, active-model family,
  and a 5-minute TTL before trusting it. The older prompt-hash cache
  (`$TMPDIR/tkr-route-<sha1>.json`) is now a fallback only — it is keyed on
  prompt text alone, so two sessions submitting identical text shared one
  verdict and the second session's model never reached the shape matrix.
  Both sides fail open: any validation failure means "no verdict", never an
  error. Schema version lives in BOTH `internal/route/state.go` and
  `hooks/lib/route-state.js` — bump together or every read silently misses.
- `work-receipt-<sid>.json` — what the UserPromptSubmit directive told
  the coordinator THIS turn (`plan_id`, `directive_emitted`), written on
  every prompt including a tombstone when nothing was emitted. Assisted
  Agent routing requires a receipt naming the plan it is about to apply.
  The Agent hook holds an Agent's prompt, not the user's, so it cannot
  check the prompt hash; without this, a plan stays applicable for its
  whole 5-minute TTL and turn A's read-only verdict could reshape turn
  B's mutating spawn.
- `work-claim-<sid>-<plan-id>` — exclusive claim proving this process,
  and only this process, may apply that plan (§13.3: one plan, one
  matching spawn). Created with `openSync(..., "wx")`, never
  check-then-write: parallel `PreToolUse(Agent)` processes would all
  observe an unclaimed plan before any wrote.
- Both are written by `hooks/lib/work-route-state.js`, deliberately NOT
  folded into `route-current-<sid>.json`: that file has exactly one
  writer (the Go binary), and a JS read-modify-write would race the next
  `tkr route classify` and silently drop a verdict. SessionStart sweeps
  both at 24h alongside mode and statusline files.
- `compact-bypass-<sid>` — pre-compact nudge bypass flag
- `rewrite-heads.json` — rewrite-eligibility heads manifest (HOOK-003).
  Written by the Go binary (refresh-on-rewrite, `tkr init`, doctor);
  read by `tkr-rewrite.js` to skip the subprocess for commands no rule
  or filter can match. `complete:false` (or missing/stale/wrong-schema)
  disables the fast-path — never edit by hand; `tkr doctor` reports it.
- `mode-<sid>.json` — per-session budget mode (PLAN-33). Resolved by
  `internal/mode.StatePath`: TKR_SESSION_ID → `mode-<sid>.json`;
  sid-less → newest `mode-*.json` by mtime, then legacy `mode.json`.
  SessionStart sweeps stale files (>24h mtime) and refreshes the
  current session's file via `tkr mode auto`.

`$TMPDIR/claude-statusline-<projectslug>-<sid>.json` — per-session
statusline payload (NOT under `~/.tkr/`; cross-process via tmp).
Scoping rules:

- **Path resolution** — `getTelemetryPath()` (JS) and `signals.TelemetryPath()`
  (Go) honor in priority order: (1) `TKR_STATUSLINE_PATH` env override —
  used verbatim, for tests; (2) `TKR_SESSION_ID` env or explicit sid arg —
  per-session path; (3) neither — legacy per-project fallback for manual
  `tkr` invocations.
- **Hook contract** — every hook entry that touches statusline MUST set
  `process.env.TKR_SESSION_ID = extractSessionID(input)` before any
  helper that reads it. Module-init `const TELEMETRY_PATH = ...` is
  forbidden — resolution must happen at call time so the runMain-set
  env reaches the resolver. Helpers call `getTelemetryPath()` inline.
- **Shell scripts** — `statusline.{sh,ps1}` extract `session_id` from
  CC's stdin JSON and export `TKR_SESSION_ID` so `tkr` subprocesses
  agree on the file.
- **Lifecycle** — `session-summary.js` (Stop hook) deletes the current
  session's file on clean exit. `session-start.js` runs
  `sweepStaleStatuslineFiles()` to prune files >24h old from crashed
  sessions that never hit Stop. Without these, `$TMPDIR` grows
  unbounded on Windows where temp is not auto-cleaned.
- **Why per-session** — earlier per-project scoping leaked the previous
  session's `turn_count` / `last_ctx_k` into the first UserPromptSubmit
  of a new session, emitting stale `[tkr: t=N ctx=NK]` on turn 1.

## Testing

`*.test.js` next to the hook. Drive with synthetic stdin via
`spawnSync(process.execPath, [HOOK], { input, env })`. Use a temp
`TKR_STATE_DIR` per test. Module-export helpers when reasonable so
unit tests don't need stdin spawn.
