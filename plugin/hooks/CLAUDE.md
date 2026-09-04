# hooks/ — Claude Code hook handlers

Zone-scoped guidance for tkr hook scripts (PreToolUse, PostToolUse,
SessionStart, PreCompact, Stop, SubagentStop, UserPromptSubmit,
InstructionsLoaded).

## Files

| Hook file | Event | Purpose |
|-----------|-------|---------|
| `tkr hook rewrite` (native Go verb, no JS) | PreToolUse(Bash) | Rewrite raw bash → `tkr <cmd>` for filtering. Ported from `tkr-rewrite.js` in #664 (deleted); the implementation is `internal/hooks/rewrite_hook.go`. A SEPARATE embedded copy survives at `internal/hooks/script/tkr-rewrite.js` — that one is what `tkr init` installs for standalone (non-plugin) setups and is still fully live |
| `agent-search-inject.js` | PreToolUse(Agent) | Auto-inject `tkr search` into Agent prompts; opt-in autoroute (COMPETE-002): downgrade Explore spawns to haiku on classifier `delegate_via` verdict; work routing (native-work-routing §13): record planned-vs-actual on every spawn, and at `mode = "assisted"` fill a compatible Agent call from the current work plan; spawn-time veto (ADR-0033): for `tkr:*` types only, ask `tkr route veto-check` whether the profile's own contract forbids this spawn and block it in an enforcing mode. Fails open for every failure meaning the check COULD NOT RUN — unreachable binary, non-zero exit, unparseable JSON all read as allow — because a machine without a working tkr must not have its spawns depend on one; each names itself in the ledger's `veto_unavailable` so an open failure is measurable rather than silent (#143 finding 1). A TIMEOUT is the scoped exception: the budget is measured (`TKR_VETO_TIMEOUT_MS`, default 2500ms) so exceeding it means hung rather than busy, and it then fails CLOSED for one class only — read-only profile **and** mutation intent **and** a previously observed enforcing mode. Everything else still fails open. See `lib/veto-fallback.js`, which owns the budget so the value and the rule for what a timeout MEANS cannot drift apart. The binary is resolved via `lib/tkr-bin.js` (shared with the other JS hooks; the rewrite hook that once shared it is native since #664) |
| `post-tool-call.js` | PostToolUse | Compress Bash output via TOML filter pipeline; on Agent/Task events also append one agent-completion row (#134 R0.1, `lib/agent-completions.js`); on AskUserQuestion/ExitPlanMode events perform the keepalive interactive-answer touch (`lib/keepalive-activity.js` `interactiveAnswerTouch`, issue #152 item 2). The touch lives here rather than in a matched `PostToolUse(AskUserQuestion\|ExitPlanMode)` entry because this is the plugin's UNMATCHED PostToolUse entry — it already receives the event, so a matched entry would only add a second node spawn and an edit to the prefix-cache-critical `plugin.json`. Cost on every other tool call is one `Set.has()` |
| `post-tool-batch.js` | PostToolBatch | One first-batch row per prompt classifying the coordinator's first successful action (#134 R0.2). Event exists on CC ≥2.1.x (verified against the 2.1.221 binary; payload `tool_calls`); older builds never fire it and the read side must report that as "unavailable", never as inactivity |
| `cli-corrections-injector.js` | PostToolUse(Bash) | Inject cli-corrections on Bash failure (PD-7) |
| `tkr hook session-start` (native Go verb, no JS) | SessionStart | Brevity reinforcement + tkr awareness banner; on `startup`/`resume` also warms the opt-in resident runtime (#287, `internal/hooks/sessionstart/residentwarm.go`) so the first eligible Bash call is served rather than paying the fallback and starting the runtime for the call after it. Non-blocking and a no-op on every install that has not set `TKR_RESIDENT_ENABLED=1`. On `startup` also builds the INV-016 memory-health nudge (`internal/hooks/sessionstart/memorynudge.go`); like the Stop-hook memory audit (#349), it goes out as `systemMessage` — not stderr — and (#357) the 24h dedup write is ordered to fire only once the message is actually assembled into that channel, so it can never record a nudge nobody saw. Ported from `session-start.js` in #664 Phase 4 (the JS orchestrator, `hooks/lib/sessionstart/` and `hooks/data/sessionstart/` were deleted with the flip); the implementation is `internal/cmd/hook_sessionstart.go` plus `internal/hooks/sessionstart/` |
| `pre-compact.js` | PreCompact | Snapshot session + nudge `/clear` over `/compact` |
| `tkr hook memory-health` (native) | Stop | Memory file rotation, dedup, staleness check. Ported from `memory-health.js` in #664; the implementation is `internal/cmd/hook_memoryhealth.go`, which lives beside the classifier it calls rather than in `internal/hooks/` with the other ports — porting it into that package would have made a THIRD copy of the classifier (see the stability rule below). The JS file is NOT deletion-pending: `lib/sessionstart/memory-nudge.js` still `require()`s it for `auditMemDir`. Warnings go out as `systemMessage` on stdout, silent stdout when clean (#349) — they were `process.stderr.write` on a hook that exits 0 until then, which per the Stderr rule below is the debug log only, so no warning this hook produced had ever been seen by a user without `--debug`. `formatMemHealthWarnings()` is pure and holds the wording; only `RunMemoryHealthHook()` writes (`formatProjectWarnings()` is its JS twin, still live for the nudge path) |
| `user-prompt-submit.js` | UserPromptSubmit | Reinforce brevity mode on every prompt; keepalive activity touch (`lib/keepalive-activity.js`, folded in from the former bash `activity-touch.sh` — issue #129); writes the `skill-invoked` ledger's manual rows directly (`recordManualSkillInvocation`, #278) — see the `skill-invoked.js` row below for why this hook, not that one, is where they get written |
| `tkr hook instructions-loaded` (native Go verb, no JS) | InstructionsLoaded | Telemetry to `~/.tkr/instructions-load.jsonl` |
| `tkr hook cache-bust-warn` (native Go verb, no JS) | PreToolUse(Edit\|Write) | Warn before editing prefix-cache-critical files (PlaybookV2 L5). Ported from `cache-bust-warn.js` in #664 (deleted); the implementation is `internal/hooks/cachebustwarn.go` |
| `tkr hook long-runner-warn` (native Go verb, no JS) | PreToolUse(Bash) | Warn on watch/serve/follow commands that outlive the cache TTL (L4). Ported from `long-runner-warn.js` in #664/#681 (deleted); the implementation is `internal/hooks/longrunner.go` |
| `skill-invoked.js` | PreToolUse(Skill) | Skill-invocation telemetry → `instructions-load.jsonl`. Schema v2 resolves `invocation_source` to `manual`/`auto` from the per-turn slash marker instead of always writing `unknown` — but only for a genuine `PreToolUse(Skill)` dispatch, which is the AUTO case. **A typed slash command never dispatches the Skill tool at all** (#205 live dogfood, #278): Claude Code resolves it natively, so this hook structurally never fires for a manual invocation, and the marker it would join against goes unread. The manual row is written by `user-prompt-submit.js` instead (`recordManualSkillInvocation`) on the same turn the `<command-name>` tag is observed — see that hook's row above. Schema v3 (INV-095) adds the bundled-skill payload gate: no longer pure observability. Bundled skills inject their whole reference tree as a **user-role text block, not a tool_result** (the result is ~27 chars), so no `PostToolUse` fires and no tkr filter can ever see it — the measured `claude-api` injection cost ~250K tokens against API ground truth and stays in the cached prefix for the rest of the session. Policy + measurement live in `lib/skill-bundle.js`; the hook only does I/O and emits. Threshold-based, never name-based. Default mode is **ask** (`permissionDecision:"ask"`, the human decides): the gate fires on 3.2% of Skill dispatches in the measured population (5 of 156 across 314 sessions), which is a targeted interruption rather than prompt fatigue, and `warn` offers no decision point at all — `systemMessage` renders only after the hook returns and the payload lands regardless. `TKR_SKILL_GATE=warn` de-escalates to notify-only, `=deny` blocks outright; both the ask and deny texts carry the on-disk file index so a refusal leaves the model able to read what it needed. An **absent** setting means `ask`; a **malformed** one degrades to `warn` — the weakest acting mode, never the strongest. Cost is always reported as a **range**, never a point (see `costRange()`): the tree overstates the payload while `bytes/4` understates these tokens by ~45%, and the two errors do not cancel. A **manual `/skill` is never gated** — it is the escape hatch the denial text points at. Every failure path allows |
| `tkr hook subagent-outcome` (native) | SubagentStop | Bounded outcome row per observed subagent stop → `subagent-outcomes.jsonl`. Records `completion:"stopped"`, never "completed" — the payload carries no status. Schema v2 also parses the worker's fenced `tkr-handoff` trailer into optional `declared_*` fields: a claim channel, not a verification one — `verification` stays `"not_observed"` on every row. Does not join; `tkr route stats` does that at read time. Ported from `subagent-outcome.js` in #664; the implementation is `internal/hooks/subagentoutcome.go`. The JS file is NOT deletion-pending: `lib/agent-completions.js` still `require()`s it directly for `parseHandoff`, and that library is loaded by `post-tool-call.js` on every tool call, which has not gone native |
| `tkr hook session-summary` (native) | Stop, SessionEnd | Per-turn value report (Stop) + statusline shard cleanup (SessionEnd). Ported from `session-summary.js` in #664; the JS awaits deletion. |
| `tkr hook team-push` (native) | SessionEnd | Debounced team telemetry push (opt-in; `TKR_TEAM_DISABLE=1`). Ported from `team-push.js` in #664; the JS awaits deletion. |
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
  writers produce `manual` rows now (#278): `skill-invoked.js` for the
  rare case a Skill-tool dispatch fires on the same turn as the marker,
  and `user-prompt-submit.js` directly for the common case — a typed
  slash command never dispatches the Skill tool at all, so
  `skill-invoked.js`'s `PreToolUse(Skill)` handler structurally cannot
  observe it; see that hook's row in the table above. Manual-vs-auto is
  the whole distinction between "the skill triggered" and "the user typed
  the command", so a ledger that says `unknown` everywhere cannot measure
  triggering at all.
- `skill-bundles.json` — measured size of each skill's bundled reference
  tree, keyed by skill name (INV-095). Feeds the `skill-invoked.js` gate
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
  a slash command, written by `user-prompt-submit.js` (the only hook that
  sees the raw prompt) and read by `skill-invoked.js` (which fires later
  and holds a skill name but no prompt) — kept as defense-in-depth for
  the rare case a Skill-tool dispatch does fire on the same turn. It is
  NOT how the common case gets attributed (#278): `user-prompt-submit.js`
  also writes the `skill-invoked` manual row directly, on this same turn,
  because `skill-invoked.js`'s reader structurally never runs for a typed
  command (see `instructions-load.jsonl` above). Written ONLY on
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
  marker `first-batch-<sid>.json` (swept at 24h by `tkr hook
  session-start`).
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
