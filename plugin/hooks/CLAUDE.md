# hooks/ — Claude Code hook handlers

Zone-scoped guidance for tkr hook scripts (PreToolUse, PostToolUse,
SessionStart, PreCompact, Stop, SubagentStop, UserPromptSubmit,
InstructionsLoaded).

## Files

| Hook file | Event | Purpose |
|-----------|-------|---------|
| `tkr-rewrite.js` | PreToolUse(Bash) | Rewrite raw bash → `tkr <cmd>` for filtering |
| `agent-search-inject.js` | PreToolUse(Agent) | Auto-inject `tkr search` into Agent prompts; opt-in autoroute (COMPETE-002): downgrade Explore spawns to haiku on classifier `delegate_via` verdict; work routing (native-work-routing §13): record planned-vs-actual on every spawn, and at `mode = "assisted"` fill a compatible Agent call from the current work plan; spawn-time veto (ADR-0033): for `tkr:*` types only, ask `tkr route veto-check` whether the profile's own contract forbids this spawn and block it in an enforcing mode. Fails open for every failure meaning the check COULD NOT RUN — unreachable binary, non-zero exit, unparseable JSON all read as allow — because a machine without a working tkr must not have its spawns depend on one; each names itself in the ledger's `veto_unavailable` so an open failure is measurable rather than silent (#143 finding 1). A TIMEOUT is the scoped exception: the budget is measured (`TKR_VETO_TIMEOUT_MS`, default 2500ms) so exceeding it means hung rather than busy, and it then fails CLOSED for one class only — read-only profile **and** mutation intent **and** a previously observed enforcing mode. Everything else still fails open. See `lib/veto-fallback.js`, which owns the budget so the value and the rule for what a timeout MEANS cannot drift apart. The binary is resolved via `lib/tkr-bin.js`, shared with `tkr-rewrite.js` |
| `post-tool-call.js` | PostToolUse | Compress Bash output via TOML filter pipeline; on Agent/Task events also append one agent-completion row (#134 R0.1, `lib/agent-completions.js`); on AskUserQuestion/ExitPlanMode events perform the keepalive interactive-answer touch (`lib/keepalive-activity.js` `interactiveAnswerTouch`, issue #152 item 2). The touch lives here rather than in a matched `PostToolUse(AskUserQuestion\|ExitPlanMode)` entry because this is the plugin's UNMATCHED PostToolUse entry — it already receives the event, so a matched entry would only add a second node spawn and an edit to the prefix-cache-critical `plugin.json`. Cost on every other tool call is one `Set.has()` |
| `post-tool-batch.js` | PostToolBatch | One first-batch row per prompt classifying the coordinator's first successful action (#134 R0.2). Event exists on CC ≥2.1.x (verified against the 2.1.221 binary; payload `tool_calls`); older builds never fire it and the read side must report that as "unavailable", never as inactivity |
| `cli-corrections-injector.js` | PostToolUse(Bash) | Inject cli-corrections on Bash failure (PD-7) |
| `session-start.js` | SessionStart | Brevity reinforcement + tkr awareness banner |
| `pre-compact.js` | PreCompact | Snapshot session + nudge `/clear` over `/compact` |
| `memory-health.js` | Stop | Memory file rotation, dedup, staleness check |
| `user-prompt-submit.js` | UserPromptSubmit | Reinforce brevity mode on every prompt; keepalive activity touch (`lib/keepalive-activity.js`, folded in from the former bash `activity-touch.sh` — issue #129) |
| `instructions-loaded.js` | InstructionsLoaded | Telemetry to `~/.tkr/instructions-load.jsonl` |
| `cache-bust-warn.js` | PreToolUse(Edit\|Write) | Warn before editing prefix-cache-critical files (PlaybookV2 L5) |
| `long-runner-warn.js` | PreToolUse(Bash) | Warn on watch/serve/follow commands that outlive the cache TTL (L4) |
| `skill-invoked.js` | PreToolUse(Skill) | Skill-invocation telemetry → `instructions-load.jsonl`. Schema v2 resolves `invocation_source` to `manual`/`auto` from the per-turn slash marker instead of always writing `unknown`. Schema v3 (INV-095) adds the bundled-skill payload gate: no longer pure observability. Bundled skills inject their whole reference tree as a **user-role text block, not a tool_result** (the result is ~27 chars), so no `PostToolUse` fires and no tkr filter can ever see it — the measured `claude-api` injection cost ~250K tokens against API ground truth and stays in the cached prefix for the rest of the session. Policy + measurement live in `lib/skill-bundle.js`; the hook only does I/O and emits. Threshold-based, never name-based. Default mode is **ask** (`permissionDecision:"ask"`, the human decides): the gate fires on 3.2% of Skill dispatches in the measured population (5 of 156 across 314 sessions), which is a targeted interruption rather than prompt fatigue, and `warn` offers no decision point at all — `systemMessage` renders only after the hook returns and the payload lands regardless. `TKR_SKILL_GATE=warn` de-escalates to notify-only, `=deny` blocks outright; both the ask and deny texts carry the on-disk file index so a refusal leaves the model able to read what it needed. An **absent** setting means `ask`; a **malformed** one degrades to `warn` — the weakest acting mode, never the strongest. Cost is always reported as a **range**, never a point (see `costRange()`): the tree overstates the payload while `bytes/4` understates these tokens by ~45%, and the two errors do not cancel. A **manual `/skill` is never gated** — it is the escape hatch the denial text points at. Every failure path allows |
| `subagent-outcome.js` | SubagentStop | Bounded outcome row per observed subagent stop → `subagent-outcomes.jsonl`. Records `completion:"stopped"`, never "completed" — the payload carries no status. Schema v2 also parses the worker's fenced `tkr-handoff` trailer into optional `declared_*` fields: a claim channel, not a verification one — `verification` stays `"not_observed"` on every row. Does not join; `tkr route stats` does that at read time |
| `session-summary.js` | Stop | End-of-session value report + statusline payload cleanup |
| `team-push.js` | SessionEnd | Debounced team telemetry push (opt-in; `TKR_TEAM_DISABLE=1`) |
| `keepalive/*.sh` | Stop / SessionEnd | Keepalive v2: async-rewake watcher, cleanup (activity signal moved to `user-prompt-submit.js` + `post-tool-call.js`; `resolve-project.sh` key must stay byte-identical to `lib/keepalive-activity.js`) |
| `statusline.{sh,ps1}` | (statusLine) | Pressure indicators in prompt box |

## Hook contract

- **Stdin** — JSON payload from Claude Code; schema per event type
  (https://code.claude.com/docs/en/hooks)
- **Stdout** — JSON response. `{}` proceeds. PreToolUse/PreCompact may
  return `{"decision":"block","reason":"..."}`. A blocking PreToolUse
  should carry BOTH that older top-level form and the newer
  `hookSpecificOutput.permissionDecision:"deny"` /
  `permissionDecisionReason` one, for Claude Code version compat — the
  veto path in `agent-search-inject.js` is the worked example — and no
  `updatedInput`, since a denied call is never also rewritten.
  PostToolUse may return
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`
  to inject context.
- **Stderr** — debug only; never relied on for control flow.
- **Exit code** — non-zero treated as failure; hook silently skipped.
  Don't use exit codes for decisions.
- **PostToolUse receives the ORIGINAL tool input, not a PreToolUse
  `updatedInput`.** Claude Code executes the rewritten command but hands
  PostToolUse the command the model wrote. A PostToolUse hook therefore
  **cannot** tell from its payload whether `tkr-rewrite.js` already
  routed that call through tkr. Measured 2026-08-10: 0 of 459
  compression-telemetry rows carry a `tkr` prefix, and 40 of 18,499 Bash
  calls across 744 transcripts do — those 40 being calls the model typed
  as `tkr ...` itself. This is why `post-tool-call.js:321`
  (`/^\s*tkr\s/`, written to skip output tkr had already filtered) is
  dead code with respect to its purpose. Any cross-phase signal must
  travel through a side channel keyed on `tool_use_id`, which both hooks
  carry — never through command text. Do **not** try to rescue the text
  approach by matching a `tkr` token at any segment head to catch
  `cd X && tkr git status`: that scores 26.4%→80.3% against
  `hook_rewrites.rewritten_to` and buys nothing, because that table
  stores the *executed* form and this hook never sees it. Full
  measurement: `TODO.md` INV-112 § Measured; harness at
  `scripts/inv112_spawn_population.js`.

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
- **Only a human may advance the keepalive activity marker.** That
  invariant is what makes `keepalive/<sid>/activity` an idle clock rather
  than a liveness ping, and it is why `lib/keepalive-activity.js` has
  exactly two entry points: a typed prompt (UserPromptSubmit) and the
  answer to an interactive prompt (`interactiveAnswerTouch`, admissible
  only because `AskUserQuestion`/`ExitPlanMode` cannot COMPLETE without a
  human acting). Any third caller must carry the same argument, and must
  reject subagent sidechains — they share the coordinator's `session_id`,
  so a worker's tool traffic reaches the human's marker
  (`lib/subagent-context.js`). `INTERACTIVE_TOOLS` is duplicated in
  `keepalive/transcript-activity.py`; a tool in one list and not the other
  is half-handled — suppressed while pending but never re-arming on
  answer, or the reverse. The parity test in
  `lib/keepalive-interactive-answer.test.js` reads the Python tuple
  directly, so a one-sided edit fails.
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
- `skill-bundles.json` — measured size of each skill's bundled reference
  tree, keyed by skill name (INV-095). Feeds the `skill-invoked.js` gate
  so the hot path is one small read instead of a temp-dir walk: cold
  measure of the real 65-file `claude-api` tree is ~6.5ms, warm ~0.4ms.
  Misses are cached too — plugin skills (`tkr:*`, `blueprint:*`) ship no
  bundle and must not pay a walk per dispatch — but only for
  `MISS_TTL_MS` (1h), so a CLI upgrade that adds a bundle is picked up
  the same day rather than never. A positive entry is trusted only while
  the directory it names still exists, since an upgrade relocates the
  tree under a new `<version>/<hash>`. Sizes are `bytes/4` from `stat`;
  file contents are never read. **The tree is not an upper bound on the
  payload** — it bounds only the file-body portion, and only loosely.
  Verified against the transcript for the measured `claude-api`
  injection: 32 of 65 files shipped (all of `shared/`, all of the ONE
  detected language subtree), each **whole and contiguous** inside a
  `<doc path="...">` wrapper — nothing on this path is chunked or
  truncated — while 33 files (238,495 bytes, the other seven languages)
  did not ship. Against that, the payload adds ~70K chars that are in no
  tree file at all: `SKILL.md` ships inside the CLI binary rather than
  on disk, plus trailing guidance, the wrappers, and a `## User Request`
  trailer. Net for that event: 699,096 chars injected against an
  867,776-byte tree — the skipped languages happened to exceed the
  framing, which is arithmetic, not a guarantee. The stored number is
  also low in the token dimension: the same block was charged ~253,800
  tokens, i.e. **2.754 chars/token**, so `bytes/4` under-predicts by
  ~45%. Stored size is therefore one end of a range, never a ceiling,
  and gate text quotes both ends. That same estimator is
  `internal/tracking/tracker.go:586`, used by `internal/bench/` —
  whether it under-counts there too is open, and one sample is not a
  calibration.
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
- `task-spawns.jsonl` — one row per Agent/Task dispatch (schema v5).
  Carries `prompt_id` + `tool_use_id` (lifecycle join anchors, always
  written, empty when Claude Code supplied none) and, when a plan was
  current, planned-vs-requested-vs-emitted routing fields. Never
  "actual" — a later hook or a global subagent-model override can still
  change what runs. v4 adds the spawn-time veto verdict —
  `veto_checked` / `veto_denied` / `veto_reason` / `veto_would_deny`
  (ADR-0033) — at the TOP LEVEL, not inside the `plan_id` block: a check
  runs on `subagent_type` and the kill switch alone, so it can fire, or
  not run at all, independently of whether a plan was current.
  All-or-nothing on `veto_checked`, same discipline as `plan_id`. Version
  bumps stay additive and exist to keep metrics honest, not to gate
  parsing: absence of `veto_checked` on a v4 row means no check ran (a
  non-`tkr:*` profile, or the kill switch), which is a fact; absence on a
  v3-or-earlier row means this writer predated the concept and cannot be
  read as "not checked". v5 splits that v4 "fact" in two with
  `veto_unavailable` (`timeout` | `unreachable` | `bad_response`), mutually
  exclusive with `veto_checked`: a check that was ATTEMPTED and produced no
  verdict. Fail-open behavior is unchanged — v4 simply could not tell
  "nobody asked" from "we asked and got no answer", and on Windows the
  second is the common one (a bare spawn degrades to 4-6s under
  multi-session load against the 500ms budget). Absence of BOTH keys keeps
  its v4 meaning, so nothing that reads this ledger changes in step.
  v6 (#143 finding 1, second half) adds `veto_local_deny` +
  `veto_local_reason`: the hook denied this spawn ITSELF after a timeout,
  with no policy verdict behind it. Independent of both keys above rather
  than exclusive with either — it accompanies `veto_unavailable:"timeout"`
  when neither check answered, and `veto_checked` when one answered and the
  other timed out. Never fold it into `veto_denied`: that means
  route.VetoCheck refused the spawn, this means route.VetoCheck was
  unreachable and the hook acted on a cached mode plus a keyword scan.
  Summing the two overstates what the veto adjudicated, in exactly the
  situation where it adjudicated least. Kill switch:
  `TKR_WORK_VETO_DISABLED=1`; budget: `TKR_VETO_TIMEOUT_MS`.
- `veto-mode.json` — the last work mode a veto check actually REPORTED,
  written by `agent-search-inject.js` on every answered verdict and read by
  `lib/veto-fallback.js` on the timeout path. Exists so the fail-closed
  branch can ask "does this install enforce?" without a second JS reader of
  the Go config. Absence is decisive in the safe direction: no cache, one
  older than 24h, or an unreadable one all mean "no evidence", so the first
  timeout on a fresh install never denies.
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
- `agent-completions.jsonl` — one row per observed Agent/Task PostToolUse
  (schema v1, #134 R0.1), written by `lib/agent-completions.js` from
  inside `post-tool-call.js`. Carries all three anchors
  (`session_id`, `prompt_id`, `tool_use_id`) plus `agent_id` — the
  bridge that joins a spawn row to its SubagentStop exactly. Numeric
  fields (totals, usage) are written only when the payload supplied
  them; an absent key means "this Claude Code build did not say" and
  the Go reader (pointer fields) must print "unavailable", never 0.
  The worker's final content and the Agent prompt are read for the
  `tkr-handoff` parse and never stored. Kill switch:
  `TKR_AGENT_COMPLETIONS_DISABLED=1`.
- `first-batch.jsonl` — one row per prompt (schema v1, #134 R0.2):
  the first resolved tool batch, classified as `agent_first` /
  `direct_read_search_first` / `mixed_parallel_batch` / `other` /
  `unavailable`. Tool names only, never inputs or outputs. Dedup
  marker `first-batch-<sid>.json` (swept at 24h by session-start.js).
  Kill switch: `TKR_FIRST_BATCH_DISABLED=1`.
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
- `run/<key>.{json,sock,start,cooldown}` — resident-runtime state (#209),
  in a `0700` directory. `<key>` is sha256(project root)[:16], computed
  identically by `lib/resident-client.js` and `internal/resident.Key`; if
  those two ever disagree the feature silently never engages, so the
  parity is tested rather than assumed. `.json` is the `0600` endpoint
  file (address, token, and the binary's size+mtime — the upgrade guard);
  `.sock` the Unix socket (Windows uses a loopback TCP port instead, and
  is UNVALIDATED); `.start` an mtime-only marker rate-limiting lazy
  starts to one per 5s so a crash-looping runtime cannot become an extra
  spawn per Bash call; `.cooldown` an epoch-ms deadline written after a
  request timeout so a hung runtime costs one deadline, not one per call.
  Every failure to use the runtime falls back to spawning `tkr` exactly
  as before. Off unless `TKR_RESIDENT_ENABLED=1`; `TKR_RESIDENT_DISABLED=1`
  wins over it. When reading the endpoint from Node, stat with
  `{bigint: true}` — the float `mtimeMs` carries sub-ms precision that
  Go's `UnixMilli()` truncates, and a plain `===` rejects every endpoint.
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
