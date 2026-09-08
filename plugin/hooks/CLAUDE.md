# hooks/ — Claude Code hook handlers

Zone-scoped guidance for tkr hook scripts (PreToolUse, PostToolUse,
SessionStart, PreCompact, Stop, SubagentStop, UserPromptSubmit,
InstructionsLoaded).

## Files

| Hook file | Event | Purpose |
|-----------|-------|---------|
| `tkr hook rewrite` (native Go verb, no JS) | PreToolUse(Bash) | Rewrite raw bash → `tkr <cmd>` for filtering. Ported from `tkr-rewrite.js` in #664 (deleted); the implementation is `internal/hooks/rewrite_hook.go`. A SEPARATE embedded copy survives at `internal/hooks/script/tkr-rewrite.js` — that one is what `tkr init` installs for standalone (non-plugin) setups and is still fully live |
| `tkr hook agent-search-inject` (native Go verb, no JS) | PreToolUse(Agent) | Auto-inject `tkr search` into Agent prompts; opt-in autoroute (COMPETE-002): downgrade Explore spawns to haiku on classifier `delegate_via` verdict; work routing (native-work-routing §13): record planned-vs-actual on every spawn, and at `mode = "assisted"` fill a compatible Agent call from the current work plan; spawn-time veto (ADR-0033): for `tkr:*` types only, ask whether the profile's own contract forbids this spawn and block it in an enforcing mode. Ported from `agent-search-inject.js` in #664 Wave B; the implementation is `internal/hooks/agentsearchinject.go` (decision), `internal/hooks/taskspawns.go` (the schema-v6 ledger writer — previously JS-only) and `internal/hooks/workroutestate.go` (plan read + claim). **The veto is now in-process** (`route.VetoCheck`), not a `tkr route veto-check` subprocess, which deletes all three transport failure modes the JS had to name: `veto_unavailable` `timeout` / `unreachable` / `bad_response` are structurally unproducible here — there is no binary to resolve, no pipe to parse and no budget to exceed. The ledger keeps all three values for the historical rows node wrote; this writer can emit only `bad_response`, and only for a panic inside `route.VetoCheck` (caught by `recover()`, which restores the crash isolation the subprocess gave for free). **Consequently the #143 finding-1 local fallback is NOT ported**: `timeoutVerdict`'s fail-closed branch is guarded entirely on `unavailable == "timeout"`, so in-process it is unreachable rather than rare, and a deny path no input can reach is worse than no deny path. `veto-mode.json` is therefore no longer written — its only reader is that branch. Everything else fails open exactly as before, because a machine without a working tkr must not have its spawns depend on one. `lib/veto-fallback.js` and `TKR_VETO_TIMEOUT_MS` stay on disk for the unported JS and for `internal/route/veto_fallback_sync_test.go`, which parses that file as the Go-side profile-registry guard. The INV-097 git-status snapshot WRITE side moved too (`hookutil.SnapshotGitStatus`), so both halves are now Go; `lib/git-status-snapshot.js` stays live for `subagent-outcome.js` and the on-disk shape stays a cross-language contract. `work-receipt-<sid>.json` was a cross-language contract too until #664 Wave B Stage 3 ported its writer (`writeDirectiveReceipt`, same file as the reader), so both halves are Go now; `TestJSWriterAndGoReaderAgreeOnWorkReceipt` still runs real node against the Go reader and is kept for the rollback window only |
| `tkr hook post-tool-call` (native Go verb, no JS) | PostToolUse | Compress Bash output via TOML filter pipeline; on Agent/Task events also append one agent-completion row (#134 R0.1); on AskUserQuestion/ExitPlanMode events perform the keepalive interactive-answer touch (issue #152 item 2). The touch lives here rather than in a matched `PostToolUse(AskUserQuestion\|ExitPlanMode)` entry because this is the plugin's UNMATCHED PostToolUse entry — it already receives the event, so a matched entry would only add a second spawn and an edit to the prefix-cache-critical `plugin.json`. Cost on every other tool call is one map lookup. Ported from `post-tool-call.js` in #664 Wave B; the implementation is `internal/hooks/posttoolcall.go` (orchestrator) plus `posttoolcall_bash.go` (filter + ingest), `posttoolcall_nudges.go` (cap/explore/ctx-breakpoint), `posttoolcall_warnings.go` (cache-bust + push nudge), `posttoolcall_sideeffects.go` (spawns + keepalive touch), `posttoolcall_telemetry.go` and `agentcompletions.go`. This is the FIRST ported hook admitted to `predispatchFreeHook` on event-rate grounds rather than on novelty: PostToolUse fires after every tool call, so the config walk, filter-registry init and tracking-DB open it skips are skipped per tool call, not per session. **Two behaviors deliberately diverge from the JS and both are ported-with-intent, not oversights.** (a) `TKR_HOOKS_DISABLED` now short-circuits BEFORE the `hook-timings.jsonl` row is armed; the JS registers `process.on("exit", logTiming)` at module top and `process.exit(0)` fires exit handlers, so a disabled JS install with `TKR_HOOK_TIMINGS=1` still appended a row — reproducing that would have ported a violation of this file's own stability rule, and the row it drops measures a hook that did nothing. (b) `isGitPush` reassembles the JS's `(?!.*--help\b)` lookahead, which RE2 cannot express, by scanning EVERY match rather than the leftmost and by bounding the `--help` scan to one line from the match END — a first-match-only port answers `git push --help && git push origin` wrong, because a JS engine backtracks past the rejected first match. The `/^\s*tkr\s/` branch IS ported: it is dead with respect to its stated purpose (see the PostToolUse note below) but reachable and load-bearing — it keeps the ~40-in-18,499 calls the model typed as `tkr ...` out of `tkr filter-stdin`, and it is what makes a bare `tkr search ...` never reach the search path. `hooks/cache-bust-detector.js` (post-write CACHE-002 counter) is a DIFFERENT hook from `cache-bust-warn.js` (pre-write L5 cost estimate, already native): they fire on opposite sides of the edit, keep separate state, and disagree about which files count — this one adds INV-026 path scoping so a plugin author editing their own source repo is not warned about a cache their session never loaded. Merging the two rule sets would give one hook the other's false-positive profile |
| `tkr hook post-tool-batch` (native Go verb, no JS) | PostToolBatch | One first-batch row per prompt classifying the coordinator's first successful action (#134 R0.2). Event exists on CC ≥2.1.x (verified against the 2.1.221 binary; payload `tool_calls`); older builds never fire it and the read side must report that as "unavailable", never as inactivity. Ported from `post-tool-batch.js` in #664 (deleted); the implementation is `internal/hooks/posttoolbatch.go` |
| `tkr hook cli-corrections` (native Go verb, no JS) | PostToolUse(Bash) | Inject cli-corrections on Bash failure (PD-7). Ported from `cli-corrections-injector.js` in #664 (deleted); the implementation is `internal/hooks/clicorrections.go` |
| `tkr hook session-start` (native Go verb, no JS) | SessionStart | Brevity reinforcement + tkr awareness banner; on `startup`/`resume` also warms the opt-in resident runtime (#287, `internal/hooks/sessionstart/residentwarm.go`) so the first eligible Bash call is served rather than paying the fallback and starting the runtime for the call after it. Non-blocking and a no-op on every install that has not set `TKR_RESIDENT_ENABLED=1`. On `startup` also builds the INV-016 memory-health nudge (`internal/hooks/sessionstart/memorynudge.go`); like the Stop-hook memory audit (#349), it goes out as `systemMessage` — not stderr — and (#357) the 24h dedup write is ordered to fire only once the message is actually assembled into that channel, so it can never record a nudge nobody saw. Ported from `session-start.js` in #664 Phase 4 (the JS orchestrator, `hooks/lib/sessionstart/` and `hooks/data/sessionstart/` were deleted with the flip); the implementation is `internal/cmd/hook_sessionstart.go` plus `internal/hooks/sessionstart/` |
| `tkr hook pre-compact` (native Go verb, no JS) | PreCompact | Snapshot session + nudge `/clear` over `/compact`. Ported from `pre-compact.js` in #664 (deleted); the implementation is `internal/hooks/precompact.go`. The JS spawned `tkr session build-snapshot <sid>`; the native verb calls `session.RunBuildSnapshot` in-process instead (a Go hook IS the tkr binary), wrapped in a `recover()` to restore the crash isolation the spawn gave for free |
| `tkr hook memory-health` (native) | Stop | Memory file rotation, dedup, staleness check. Ported from `memory-health.js` in #664; the implementation is `internal/cmd/hook_memoryhealth.go`, which lives beside the classifier it calls rather than in `internal/hooks/` with the other ports — porting it into that package would have made a THIRD copy of the classifier (see the stability rule below). The JS file is NOT deletion-pending: `lib/sessionstart/memory-nudge.js` still `require()`s it for `auditMemDir`. Warnings go out as `systemMessage` on stdout, silent stdout when clean (#349) — they were `process.stderr.write` on a hook that exits 0 until then, which per the Stderr rule below is the debug log only, so no warning this hook produced had ever been seen by a user without `--debug`. `formatMemHealthWarnings()` is pure and holds the wording; only `RunMemoryHealthHook()` writes (`formatProjectWarnings()` is its JS twin, still live for the nudge path) |
| `tkr hook user-prompt-submit` (native Go verb, no JS) | UserPromptSubmit | Reinforce brevity mode on every prompt; keepalive activity touch (issue #129); resolve shaped `@path:mode` (#658) and bare absolute-path (#752) mentions into `tkr fread` views; compose the cold-resume/pre-TTL, PlaybookV2 L1/L2/L7, state-line and 7d tier-cross advisories; run the route and shape verdict channels (ADR-0010); emit the work-route coordinator directive plus its receipt and the `work-directive` ledger row; append the `injection-events.jsonl` row and the `skill-invoked` ledger's MANUAL rows (`recordManualSkillInvocation`, #278) — see the `tkr hook skill-invoked` row below for why this hook, not that one, is where they get written. Ported from `user-prompt-submit.js` in #664 Wave B; the implementation is `internal/hooks/userpromptsubmit.go` (orchestrator + envelope) plus `userpromptsubmit_config.go` (state paths, telemetry accessor, the two `lib/injection-config.js` loaders that had no Go twin, keepalive touch), `_detectors.go`, `_route.go` (incl. the `lib/route-state.js` model-identity port), `_work.go`, `_mentions.go` and `_telemetry.go`. **This hook now creates ZERO processes per prompt.** The JS had got it down to one (INV-085 step 3, a `tkr hook prompt-submit` spawn fusing record-event with route-classify); a Go hook IS the tkr binary, so that call is in-process via `runHookPromptSubmitFrom`, and so are `tkr route classify`, `tkr session record-event` and the per-mention `tkr fread`. **That is exactly why this verb is NOT in `predispatchFreeHook`** despite being the highest-rate hook there is: the merged call reaches `runRouteClassify`, which reads `[routing.work]` from config, so admitting it would silently classify every prompt against default policy. Removing a whole process creation (35-110ms warm, 4-6s under the Windows multi-session load INV-085 was chartered against) dominates the ~25ms predispatch-free saving by an order of magnitude, worst-case first. **Two consequences of going in-process, both ported-with-intent.** (a) `lib/stage-trace.js` is NOT ported: every mark it takes brackets a process creation on the prompt hot path, so on this implementation every reading is structurally zero — an instrument that can only report zero is worse than none, the same argument #788 used for the veto transport failure modes. (b) The `classify-timeouts.jsonl` writer is NOT ported. Both of its sources (`user-prompt-submit`, `user-prompt-submit-merged`) record a `spawnSync` kill of a subprocess, and in-process there is no process to kill and no timer to expire — so a Go writer would have no reachable call site, which is the same dead-instrument mistake as (a). `runRouteClassify` prints its verdict with `fmt.Print*`, so the in-process call runs under a scoped `os.Stdout` redirect (`withStdoutSuppressed`) — without it the classifier's JSON concatenates ahead of this hook's own response envelope and Claude Code receives two documents where it expects one |
| `tkr hook instructions-loaded` (native Go verb, no JS) | InstructionsLoaded | Telemetry to `~/.tkr/instructions-load.jsonl` |
| `tkr hook cache-bust-warn` (native Go verb, no JS) | PreToolUse(Edit\|Write) | Warn before editing prefix-cache-critical files (PlaybookV2 L5). Ported from `cache-bust-warn.js` in #664 (deleted); the implementation is `internal/hooks/cachebustwarn.go` |
| `tkr hook long-runner-warn` (native Go verb, no JS) | PreToolUse(Bash) | Warn on watch/serve/follow commands that outlive the cache TTL (L4). Ported from `long-runner-warn.js` in #664/#681 (deleted); the implementation is `internal/hooks/longrunner.go` |
| `tkr hook skill-invoked` (native Go verb, no JS) | PreToolUse(Skill) | Skill-invocation telemetry → `instructions-load.jsonl`. Ported from `skill-invoked.js` in #664 (deleted); the implementation is `internal/hooks/skillinvoked.go` over the policy in `internal/skillbundle` (from `lib/skill-bundle.js`, deleted) and the marker reader in `internal/slashmarker`. **The marker is written and read by Go** as of #664 Wave B Stage 3, when `tkr hook user-prompt-submit` — the only hook that sees the raw prompt — took over the WRITER half (`slashmarker.RecordSlashCommand`). `slash-marker-<sid>.json` is therefore no longer a cross-language contract, but `internal/slashmarker` still reimplements the JS sid sanitizer rather than calling `hookutil.SanitizeSid`, which is a stricter function: an install that rolls back to the JS hook must still find the file the Go writer left, and vice versa. A Go test runs the real JS writer through node to pin the pairing (a reader that disagreed would report `auto` forever, which is indistinguishable from the honest no-marker case). Two writers of the `skill-invoked` event now exist, both in Go and both in `package hooks`, sharing `skillInvokedRow` and the `skillInvokedEventName` constant; `schema_version` is still pinned by `skill-schema-parity.test.js`, which reads the Go constant out of the source. **The #263 first-invocation gate is degraded on a Node-free install**: it reads a manifest only `lib/skill-scrape.js` produces, so with no node there is no manifest, `ManifestEntryFor` returns nil, and a bundled skill's FIRST invocation is ungated — the pre-#263 behavior; the second is gated from the tree the first extracted. That is also why `sessionstart.SpawnSkillManifestRefresh` was NOT deleted with this port, despite a comment there instructing exactly that: the port moved the consumer, not the producer, so the spawn is now the only thing producing a manifest anywhere. Schema v2 resolves `invocation_source` to `manual`/`auto` from the per-turn slash marker instead of always writing `unknown` — but only for a genuine `PreToolUse(Skill)` dispatch, which is the AUTO case. **A typed slash command never dispatches the Skill tool at all** (#205 live dogfood, #278): Claude Code resolves it natively, so this hook structurally never fires for a manual invocation, and the marker it would join against goes unread. The manual row is written by `tkr hook user-prompt-submit` instead (`recordManualSkillInvocation`, now Go too) on the same turn the `<command-name>` tag is observed — see that hook's row above. Schema v3 (INV-095) adds the bundled-skill payload gate: no longer pure observability. Bundled skills inject their whole reference tree as a **user-role text block, not a tool_result** (the result is ~27 chars), so no `PostToolUse` fires and no tkr filter can ever see it — the measured `claude-api` injection cost ~250K tokens against API ground truth and stays in the cached prefix for the rest of the session. Policy + measurement live in `internal/skillbundle` (ported from `lib/skill-bundle.js`, deleted); the hook only does I/O and emits. Threshold-based, never name-based. Default mode is **ask** (`permissionDecision:"ask"`, the human decides): the gate fires on 3.2% of Skill dispatches in the measured population (5 of 156 across 314 sessions), which is a targeted interruption rather than prompt fatigue, and `warn` offers no decision point at all — `systemMessage` renders only after the hook returns and the payload lands regardless. `TKR_SKILL_GATE=warn` de-escalates to notify-only, `=deny` blocks outright; both the ask and deny texts carry the on-disk file index so a refusal leaves the model able to read what it needed. An **absent** setting means `ask`; a **malformed** one degrades to `warn` — the weakest acting mode, never the strongest. Cost is always reported as a **range**, never a point (see `costRange()`): the tree overstates the payload while `bytes/4` understates these tokens by ~45%, and the two errors do not cancel. A **manual `/skill` is never gated** — it is the escape hatch the denial text points at. Every failure path allows |
| `tkr hook subagent-outcome` (native) | SubagentStop | Bounded outcome row per observed subagent stop → `subagent-outcomes.jsonl`. Records `completion:"stopped"`, never "completed" — the payload carries no status. Schema v2 also parses the worker's fenced `tkr-handoff` trailer into optional `declared_*` fields: a claim channel, not a verification one — `verification` stays `"not_observed"` on every row. Does not join; `tkr route stats` does that at read time. Ported from `subagent-outcome.js` in #664; the implementation is `internal/hooks/subagentoutcome.go`. The JS file is NOT deletion-pending: `lib/agent-completions.js` still `require()`s it directly for `parseHandoff`, and that library is loaded by `post-tool-call.js` on every tool call, which has not gone native |
| `tkr hook session-summary` (native) | Stop, SessionEnd | Per-turn value report (Stop) + statusline shard cleanup (SessionEnd). Ported from `session-summary.js` in #664; the JS awaits deletion. |
| `tkr hook team-push` (native) | SessionEnd | Debounced team telemetry push (opt-in; `TKR_TEAM_DISABLE=1`). Ported from `team-push.js` in #664; the JS awaits deletion. |
| `keepalive/*.sh` | Stop / SessionEnd | Keepalive v2: async-rewake watcher, cleanup (activity signal moved to the native `tkr hook user-prompt-submit` + `tkr hook post-tool-call`; `resolve-project.sh` key must stay byte-identical to `lib/keepalive-activity.js`) |
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
  to inject context. To replace a result, use `updatedToolOutput` (never
  `updatedToolResponse`) and preserve the original `tool_response` shape.
  Live-verified on native Read with Claude Code 2.1.232: a shape-matched
  object replaced both the model-visible result and persisted transcript;
  a bare replacement string was accepted by the hook runner but ignored.
  **Extended to MCP tools on 2.1.241** (#500), where two things differ.
  (a) The envelope is load-bearing: a two-run controlled experiment with
  one variable changed found a TOP-LEVEL `updatedToolOutput` silently
  ignored — the model received all 56,212 bytes — while the same payload
  nested inside `hookSpecificOutput` cut the `tool_result` to 100 bytes.
  Nest it. (b) "Preserve the shape" is not academic here: the live MCP
  `tool_response` is a **bare array**, `[{type:"text",text}]`, NOT the
  `{content:[...]}` wrapper. `{...tool_response}` on an array yields
  `{"0":{...}}`, which serializes as an object and is silently ignored —
  the same failure mode as the bare string. `makeResponse`
  (`lib/posttool/response.js`) carries the array branch; `extractToolText`
  returned `null` for this shape until #500, so no filter could see MCP
  output at all. Do not re-derive either finding from a synthetic fixture:
  the pre-#500 `asArray` unit test passed against a shape MCP never emits,
  which is exactly why the bug read as already-handled.
- **Stderr** — debug only; never relied on for control flow. On a hook that
  exits 0 it reaches the debug log and nothing else — not the transcript,
  not the user. Anything a human is meant to READ goes out as
  `systemMessage` on stdout (rendered to the user, never entered into model
  context); anything the MODEL is meant to read goes out as
  `additionalContext`. A warning written to stderr is a warning nobody
  receives (#349).
- **Exit code** — non-zero treated as failure; hook silently skipped.
  Don't use exit codes for decisions.
- **PostToolUse receives the ORIGINAL tool input, not a PreToolUse
  `updatedInput`.** Claude Code executes the rewritten command but hands
  PostToolUse the command the model wrote. A PostToolUse hook therefore
  **cannot** tell from its payload whether the rewrite hook already
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
- **The memory classifier has exactly one implementation again.**
  `hooks/memory-health.js` was a 414-line parallel JS port of the Go
  classifier, and the duplication rule that used to live here — "any change
  to one side must be made to the other in the same commit" — is retired
  because the JS side is gone. #664 took the Stop hook native first
  (`tkr hook memory-health`), which left the file reachable only through
  `lib/sessionstart/memory-nudge.js`; the Phase 4 cutover deleted that
  requirer and the file with it. Both consumers now call
  `internal/memhealth` directly: the Stop hook via
  `internal/cmd/hook_memoryhealth.go`, the SessionStart nudge via
  `internal/hooks/sessionstart/memorynudge.go`. New per-file work in the
  classifier must still stay I/O-free — the 500ms Stop budget already pays
  a read and a stat per file.
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
  rather than hedged: `manual` when the turn's prompt carried Claude
  Code's `<command-name>` scaffold for that skill (or, absent scaffold, a
  literal leading `/<skill>`), `auto` otherwise, and `unknown` only when
  no skill name was supplied and the question could not be asked. Two
  writers produce `manual` rows now (#278), and since #664 Wave B Stage 3
  BOTH are Go and both live in `package hooks`: the native
  `tkr hook skill-invoked` for the
  rare case a Skill-tool dispatch fires on the same turn as the marker,
  and `tkr hook user-prompt-submit` directly for the common case — a typed
  slash command never dispatches the Skill tool at all, so
  the native hook's `PreToolUse(Skill)` handler structurally cannot
  observe it; see that hook's row in the table above. Manual-vs-auto is
  the whole distinction between "the skill triggered" and "the user typed
  the command", so a ledger that says `unknown` everywhere cannot measure
  triggering at all. The manual writer reuses `skillInvokedRow` and
  `appendSkillInvokedRow` rather than declaring a parallel shape, and the
  `event` discriminator is a shared constant (`skillInvokedEventName`) rather
  than a literal at each site: every reader filters on `event`, so two writers
  that disagreed on it would make one population invisible — which is
  indistinguishable from "the skill was never invoked". A manual row carries
  only the six mandatory fields; a manual invocation is never gated, so there
  is no INV-095 gate verdict to record.
- `skill-bundles.json` — measured size of each skill's bundled reference
  tree, keyed by skill name (INV-095). Feeds the native skill-invoked gate
  (`internal/skillbundle`)
  so the hot path is one small read instead of a temp-dir walk: cold
  measure of the real 65-file `claude-api` tree is ~6.5ms, warm ~0.4ms.
  Misses are cached only for NAMESPACED skills — plugin skills (`tkr:*`,
  `blueprint:*`) structurally ship no bundle and must not pay a walk per
  dispatch — for `MISS_TTL_MS` (1h), so a CLI upgrade that adds a bundle
  is picked up the same day rather than never. A colon-less name
  (`looksBundled()`) neither trusts nor writes a negative entry (#219):
  extraction happens at skill-LOAD time, strictly AFTER this PreToolUse
  gate has decided, so the miss recorded by a bundled skill's first
  invocation would otherwise mask the very tree that invocation extracts
  and keep the gate blind for an hour of dispatches, not one. A
  colon-less skill with genuinely no tree instead re-walks the bundle
  root every dispatch — measured 1.9ms p50 / 3.2ms max against a real
  17-version root, noise inside the <100ms hook budget. A positive
  entry is trusted only while
  the directory it names still exists, since an upgrade relocates the
  tree under a new `<version>/<hash>`. Several CLI versions coexist under
  the bundle root; `resolveBundleDir` (#219) prefers the highest-semver
  version that has a NON-EMPTY tree for the skill, falling back to older
  ones — an empty directory (content pruned, directory left behind; 9 of
  13 `claude-api` dirs observed empty on one box) never wins the
  newest-mtime race, which previously let a stale empty dir report a
  silent `tokens: 0, files: 0`. When the resolved version is not the
  newest version directory present on disk, `bundleFor()` sets
  `crossVersion: true` and both the gate text and the ledger's
  `bundle_dir_version` / `bundle_cross_version` fields (schema v5) say so
  — the hook is never told which version is about to load, so this is a
  visible lower-bound flag, not a fix for the underlying blind spot. The
  first-ever invocation of a skill on a box (no tree extracted yet at
  all) cannot be measured from disk: the decision is due before the tool
  runs, and a null bundle is ambiguous between "ships no bundle" (nearly
  every skill) and "first invocation of a big one". Since #263 that
  ambiguity is resolved out-of-band — the null-bundle path consults
  `skill-manifest.json` (below), so a known-big first invocation gets a
  real ask quoting the scraped estimate, and every manifest failure
  degrades to the old ungated behavior. The SECOND invocation is gated
  from the measured tree — the first one's own skill-load extraction
  puts it on disk, and the no-negative-cache rule above makes it visible
  immediately (#219).
  Sizes are `bytes/4` from `stat` (cache
  schema v2 stores raw bytes alongside — see below); file contents are
  never read. **The tree is not an upper bound on the
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
  and gate text quotes both ends. That estimator was calibrated
  in #218: `tracking.EstimateTokens` is now `bytes/2.4` (n=315 across all
  content classes, 2.0–2.75 B/t; see
  `docs/reports/2026-08-10-estimator-calibration.md`), while this file's
  stored tokens deliberately stay `bytes/4` — they are `costRange()`'s low
  end by construction. Ledger schema v4 records `bundle_bytes` so rows are
  re-derivable under any divisor.
- `skill-manifest.json` — per-CLI-version static scrape of the installed
  binary's bundled-skill set (#263): `{ccVersion, binaryPath, binarySize,
  binaryMtimeMs, scrapedAt, complete, skills:[{name, hasTree,
  approxBytes, userInvocable}]}`. Written OUT of the hot path by the
  scraper; read by `manifestEntryFor()` on the null-bundle path for
  colon-less names only — the one case `bundleFor` is structurally blind
  to (first invocation; extraction happens at skill-LOAD time, after the
  gate has decided). Trusted only when the schema matches, `complete` is
  true, the described binary still stats to the same size+mtime, and no
  extracted version dir is newer than `ccVersion`; any failure reads as
  "no manifest" and the dispatch stays ungated exactly as pre-#263.
  `approxBytes` is scraped, not measured: ledger rows gated from it carry
  `manifest_bytes` + `gate_first_invocation` (schema v6) and never the
  `bundle_*` fields, so the scraped and measured populations stay
  separable. Once the first invocation extracts the real tree, the
  temp-dir measurement takes over as ground truth. Refreshed automatically:
  `tkr hook session-start` (startup source only) runs the skill-manifest
  refresh (`internal/hooks/sessionstart/skillmanifestrefresh.go`),
  a cheap check — no manifest, wrong schema, or the described binary no
  longer stats to the same size+`floor(mtimeMs)` — followed by a detached,
  unref'd `node skill-scrape.js` rescrape (60s hard kill) when stale.
  Deliberately not keyed on `complete`: an incomplete scrape against an
  unchanged binary would resolve the same way again, so re-running it every
  session buys nothing. Honors `TKR_HOOKS_DISABLED`.
- `slash-marker-<sid>.json` — one-turn record that the user's prompt was
  a slash command, written by `tkr hook user-prompt-submit` (the only hook
  that sees the raw prompt) and read by `internal/slashmarker` from the
  native skill-invoked hook (which fires later
  and holds a skill name but no prompt) — kept as defense-in-depth for
  the rare case a Skill-tool dispatch does fire on the same turn. It is
  NOT how the common case gets attributed (#278): the same hook
  also writes the `skill-invoked` manual row directly, on this same turn,
  because that reader structurally never runs for a typed
  command (see `instructions-load.jsonl` above).
  **No longer a cross-language contract as of #664 Wave B Stage 3**: the
  WRITER went native alongside the reader (`slashmarker.RecordSlashCommand`),
  so both halves are Go. `MarkerPath`'s JS-shaped sid sanitizer is kept
  verbatim anyway — it is a byte-for-byte reimplementation of
  `sid && !/[/\\]/.test(sid) && !sid.includes("..") ? sid : "default"`, NOT
  `hookutil.SanitizeSid`, which is a stricter function — because an install
  that rolls back to the JS hook must still find the file this writer left,
  and vice versa. A reader that sanitized differently would report `auto`
  forever, which is indistinguishable from the honest no-marker case. Written ONLY on
  slash-command turns, so ordinary prompts pay one regex and no I/O.
  Scoped by `prompt_id` with a 60s TTL as the backstop, so a marker
  cannot make a later turn's auto trigger look manual. Honors
  `TKR_SKILL_AUDIT_DISABLED=1`. The alternative — deriving manual-vs-auto
  at read time from the session transcript — was rejected because the
  transcript rotates and the ledger is meant to outlive it.
- `decisions.jsonl` — shared audit ledger, discriminated by `event`:
  delegation rows, `route-classified` (Go), `autoroute`, and
  `work-directive` (one row per coordinator directive that actually went
  out — the follow-rate denominator; a plan that stayed silent leaves no
  row). Writers must use `ts`, not `at`: every reader keys on `ts`, so a
  row with `at` has no timestamp as far as any window is concerned.
- `task-spawns.jsonl` — one row per Agent/Task dispatch (schema v6; the
  header below said v5 for two schema bumps). Written by
  `internal/hooks/taskspawns.go` since #664 Wave B; `hooks/lib/task-spawns.js`
  is the retired JS twin and the two agreed on every field, which is why the
  many Go readers needed no change at the cutover.
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
  Since #664 Wave B the native writer can produce NEITHER `veto_local_deny`
  nor a `timeout`/`unreachable` `veto_unavailable` — the veto is in-process,
  so those describe a subprocess that no longer exists. They remain in the
  schema, and are read, for the rows node already wrote. The read side gained
  them at the same time (`signals.WorkSpawnRow`, `tkr route outcomes`
  `veto_counts`): before that fix a v6 local-deny row was invisible to the
  aggregate — not checked, not denied, not anything — so a window whose only
  veto activity was denials reported `not observed`.
- `veto-mode.json` — the last work mode a veto check actually REPORTED. **No
  longer written by anything as of #664 Wave B.** It existed so
  `lib/veto-fallback.js`'s fail-closed timeout branch could ask "does this
  install enforce?" without a second JS reader of the Go config; the only
  writer was `agent-search-inject.js` and the only reader was that branch.
  The native port has no subprocess and therefore no timeout, so the branch
  is unreachable and the write would have had no reader — see the
  `tkr hook agent-search-inject` row above. Absence was always decisive in
  the safe direction (no cache, one older than 24h, or an unreadable one all
  mean "no evidence"), so an install that still runs the JS hook via a
  rollback simply never denies on its first timeout, which is the documented
  fresh-install behavior.
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
  (schema v1, #134 R0.1). Written by `internal/hooks/agentcompletions.go`
  since #664 Wave B; `hooks/lib/agent-completions.js` is the retired JS
  twin and the two agree on every field, which is why the Go reader
  (`internal/signals/completions.go`) needed no change at the cutover. It
  is a DIFFERENT ledger from `task-spawns.jsonl` and the two are the
  opposite ends of one join: the spawn row is what the coordinator asked
  for at PreToolUse, this row is what the worker actually did. Carries all
  three anchors
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
  marker `first-batch-<sid>.json` (swept at 24h by `tkr hook
  session-start`).
  Kill switch: `TKR_FIRST_BATCH_DISABLED=1`.
- `trajectory.json` — cap projection cache
- `anomaly.json` — burn anomaly cache
- `hook-timings.jsonl` — hook elapsed_ms per call. Gated behind
  `TKR_HOOK_TIMINGS=1` (off by default) and rotated before append, because
  the PostToolUse writer appends on EVERY tool call. Native since #664
  Wave B: `tkr hook post-tool-call` arms its row only PAST the
  `TKR_HOOKS_DISABLED` check, where the JS armed it at module top and so
  still wrote one for a run the kill switch had already stopped.
- The rest of the PostToolUse hook's own state, all under the state dir and
  all owned by `tkr hook post-tool-call`:
  - `explore-nudge.json` — `{count, nudged, queries}` for the
    Read/Glob/Grep streak detector. Reset on Bash; Edit and other
    non-exploration tools are NEUTRAL (neither advance nor reset), so an
    explore-edit-explore rhythm stays visible.
  - `search-adoption.jsonl` — one `native_read_burst` row each time that
    nudge fires (SRCH-011), sharing the store the Go MCP handlers append
    `tkr_search`/`tkr_graph` rows to; `tkr top --json` reads the ratio.
    Rotation-capped at 2MB.
  - `ctx-breakpoint-<sid>.json` — `{high_water_k}`, the MONOTONIC mark
    behind the Channel 2 advisories. Once ctx crosses 100K the 100K
    advisory never fires again, even after a compaction drops ctx back
    below it, and a multi-threshold jump emits only the highest crossing.
    Read fresh inside the detector on every call (Risk #15) — never
    pre-composed by the caller.
  - `cache-bust-<sid>.json` — `{count, paths}` for the CACHE-002 post-write
    counter, `paths` capped at 5. Wording escalates at 3 busts in one
    session. Distinct from `l5-state-<sid>.json`, which is the PRE-write
    `tkr hook cache-bust-warn`'s file: opposite sides of the edit, separate
    state, and different file-matching rules (this one adds INV-026 path
    scoping). Kill switch: `TKR_CACHE_BUST_DISABLED=1`.
  - `push-nudge-<sid>.flag` — once-per-session debounce for the Ship 5
    push-boundary nudge. Kill switch: `TKR_PUSH_NUDGE_DISABLED=1`.
  - `last-activity` — epoch-ms touch on every tool call. NOT the keepalive
    marker; see the keepalive rule above for why only a human may advance
    that one.
  - `reconcile-counter` / `mode-auto-counter` — every-N-tool-call counters
    for the `tkr signals reconcile-decisions` and `tkr mode auto` spawns
    (`TKR_RECONCILE_EVERY_N` / `TKR_MODE_AUTO_EVERY_N`, default 5 each;
    `TKR_MODE_AUTO_DISABLED=1` kills the second). Written tmp+rename
    (M-10): a torn read restarts the count and makes the cadence
    unpredictable rather than merely late.
  - `last-statusline-fire.ms` — 1s debounce on the statusline spawn. The
    payload is overwrite-only and latest-write-wins, so a skipped fire
    inside the window costs nothing and bounds the per-tool-call spawn rate.
  - `effort-<sid>.json` — the session's observed effort (issue #123).
    PostToolUse is the AUTHORITATIVE observer — Claude Code populates
    `input.effort`/`CLAUDE_EFFORT` only inside a tool-use context — so it
    writes with `clearWhenAbsent`: an undetectable effort DELETES the
    snapshot rather than leaving a pre-/model-switch value standing. Shared
    writer with SessionStart (`internal/hooks/sessionstart.PersistSessionEffort`),
    deliberately one owner rather than two spellings.
  - `telemetry-history.jsonl` — the compression/search savings ledger,
    rotated before append at `internal/telemetry.HistoryMaxBytes`. The
    PostToolUse writer records a zero-saving event ONLY when it can name a
    `reason` (`host_cap_exceeded`, `already_routed_tkr`,
    `no_matching_filter`, `search_output_already_clean`); a zero-saving
    event with nothing to say is skipped, which is why "the cap-nudge
    fired" and "a cap-nudge row exists" are different questions.
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
- Both are Go-owned since #664 Wave B Stage 3. The receipt WRITER is
  `writeDirectiveReceipt` in `internal/hooks/workroutestate.go`, beside the
  reader #788 shipped — so `work-receipt-<sid>.json` is no longer a
  cross-language contract and the on-disk shape is an implementation detail
  shared by two functions in one file. The claim is `claimPlan` in the same
  file. Neither is folded into `route-current-<sid>.json`: that file has
  exactly one writer (`route.WriteCurrent`), and a read-modify-write from a
  second owner would race the next `tkr route classify` and silently drop a
  verdict. SessionStart sweeps both at 24h alongside mode and statusline
  files. `internal/hooks/agentsearchinject_receipt_test.go`'s
  `TestJSWriterAndGoReaderAgreeOnWorkReceipt` still runs the real node writer
  through the Go reader; it now pins a writer production no longer uses, and
  is kept only for the one-release rollback window.
- `classify-timeouts.jsonl` — INV-073 marker rows for a `tkr route classify`
  killed by the hook budget, read by `internal/signals`. The native
  UserPromptSubmit hook classifies IN-PROCESS, so it cannot produce a row:
  the `source` values `user-prompt-submit` and `user-prompt-submit-merged`
  describe a `spawnSync` kill of a subprocess that no longer exists. The
  writer is NOT ported — it would have no reachable call site. The ledger still
  has a Go reader, and a rollback install running the JS hook still appends. Read an empty ledger as "no subprocess classify was killed",
  never as "no classify was slow".
- `compact-bypass-<sid>` — pre-compact nudge bypass flag
- `run/<key>.{json,sock,start,cooldown}` — resident-runtime state (#209),
  in a `0700` directory. `<key>` is sha256(project root)[:16], computed
  identically by `lib/resident-client.js` and `internal/resident.Key`; if
  those two ever disagree the feature silently never engages, so the
  parity is tested rather than assumed. `.json` is the `0600` endpoint
  file (address, token, and the binary's size+mtime — the upgrade guard);
  `.sock` the Unix socket (Windows uses a named pipe,
  `\\.\pipe\tkr-resident-<key>`, with a DACL granting only the current
  user, LocalSystem and administrators); `.start` an mtime-only marker
  rate-limiting starts to one per 5s so a crash-looping runtime cannot
  become an extra spawn per Bash call; `.cooldown` an epoch-ms deadline
  written after a request timeout so a hung runtime costs one deadline,
  not one per call.
  Every failure to use the runtime falls back to spawning `tkr` exactly
  as before. Off unless `TKR_RESIDENT_ENABLED=1`; `TKR_RESIDENT_DISABLED=1`
  wins over it. **Two starting points, one mechanism** (#287): the request
  path starts a runtime lazily on the first call that finds none, and
  `tkr hook session-start` warms the runtime on `startup`/`resume`
  so that first call finds one already up. `warm()` reaches the SAME
  `maybeStart()` through the same gates — it changes when a start happens,
  never whether the rules apply — and it never blocks: no connect, no ping,
  detached + `unref()`'d spawn, a verdict for every input and a throw for
  none. Its one extra check is a `signal 0` liveness probe of the
  endpoint's pid, because a crashed runtime leaves a valid endpoint file
  behind and warm-up would otherwise guarantee the first Bash call hits a
  corpse; the request path needs no such probe since its connect answers
  the same question. When reading the endpoint from Node, stat with
  `{bigint: true}` — the float `mtimeMs` carries sub-ms precision that
  Go's `UnixMilli()` truncates, and a plain `===` rejects every endpoint.
- `rewrite-heads.json` — rewrite-eligibility heads manifest (HOOK-003).
  Written by the Go binary (refresh-on-rewrite, `tkr init`, doctor);
  read by the native rewrite verb to skip the filter registry for commands no rule
  or filter can match. `complete:false` (or missing/stale/wrong-schema)
  disables the fast-path — never edit by hand; `tkr doctor` reports it.
- `mode-<sid>.json` — per-session budget mode (PLAN-33). Resolved by
  `internal/mode.StatePath`: TKR_SESSION_ID → `mode-<sid>.json`;
  sid-less → newest `mode-*.json` by mtime, then legacy `mode.json`.
  SessionStart sweeps stale files (>24h mtime) and refreshes the
  current session's file via `tkr mode auto`.
- `hookhealth/<name>-<pid>-<ts>.json` — SessionEnd cancellation markers
  (`internal/hooks/hookutil/hookhealth.go`). Claude Code caps ALL
  SessionEnd hooks combined at a 1.5s budget by default (raised only up
  to a per-hook `timeout`, capped at 60s) — a hook still running when it
  expires is killed and reported as "Hook cancelled", with no chance to
  log anything itself. `team-push` and `session-summary` (the Go hooks)
  and the bash `cleanup.sh` hook write `{"name":...}` here the instant
  real work starts and remove it the instant they finish; not keyed by
  session id, since `team-push` deliberately never reads stdin and a sid
  would cost it a read it otherwise avoids. `tkr hook session-start`
  (startup only) sweeps markers older than 90s — safely past the
  `timeout: 20` set on all three in `.claude-plugin/plugin.json` — and
  surfaces any as a `systemMessage` nudge naming which hook(s) were
  cancelled or crashed; the sweep is self-consuming, so it fires once
  per stale batch rather than every session. Only these three hooks are
  instrumented — a third-party plugin's SessionEnd hook getting
  cancelled (as `session-lifecycle-hook.mjs` was, alongside these,
   2026-09-07) produces no marker and is invisible to this nudge.

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
  session's file on clean exit. `tkr hook session-start` runs
  `SweepStaleStatuslineFiles()` to prune files >24h old from crashed
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

`manifest-no-node.test.js` is a manifest guard, not a hook test: it
parses `.claude-plugin/plugin.json` and fails if any hook or
`mcpServers` command string invokes `node` (#664 Stage 4b — the
SessionStart `--ensure` bootstrap and the `mcpServers.tkr` Node
launcher are both gone; a future edit reintroducing either would
reopen the no-Node-host failure mode ADR-0041 exists to close). `bash
${CLAUDE_PLUGIN_ROOT}/hooks/keepalive/cleanup.sh` is explicitly
allowlisted in the test rather than left to a substring-match
loophole.
