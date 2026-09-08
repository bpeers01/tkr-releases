// HOOK-002 guard: every top-level hook file must be reachable — either
// wired to an event in .claude-plugin/plugin.json or require()d by a
// wired hook. Catches the unwired-producer class (skill-invoked.js wrote
// rows nothing triggered while tkr playbook-roi read them forever-empty).

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Files known-dead and awaiting deletion get listed here WITH the item
// that owns their removal — nothing else belongs in this list.
// #664's first two entries (tkr-rewrite.js, long-runner-warn.js) were
// deleted once their dependents moved.
//
// That deletion is worth one note, because the scope was under-counted
// TWICE before it was right. The first pass assumed three files. The
// second found hooks/bench/e2e-latency-bench.js and stopped there, and
// recorded that as the corrected scope. Two more turned up only on a
// grep for require()/path.join across the whole tree:
//   - scripts/inv112_spawn_population.js read tkr-rewrite.js as SOURCE and
//     eval'd commandMayRewrite out of it (now a frozen copy, see there);
//   - test/bench/resident-bench.js spawned it as its node-startup arm.
// Neither names the file in a way a reader scanning hook wiring would
// notice. The lesson for the next entry in this list: a hook file's
// dependents are not only the things that WIRE it — grep for the
// filename across every extension before believing a scope note.
const DELETION_PENDING = new Set([
  // #664: replaced by the native `tkr hook team-push` verb (plugin.json
  // SessionEnd now runs the Go binary directly). Kept one release as the
  // rollback path — revert the plugin.json entry to re-wire it.
  //
  // Scoped by the four-pass grep the note above demands; no live dependent
  // blocks deletion. What that grep turned up, recorded so nobody re-runs
  // it: README.md and hooks/CLAUDE.md carry inventory rows (both updated
  // with the port); cmd_resident_keepalive.go:45 names the file only in a
  // comment about the kill switch; the docs/ hits are historical design
  // records; and test/bench/fixtures/github/gh-repo-view.txt is a captured
  // `gh repo view` snapshot used as bench INPUT — it must keep its original
  // text and is not a dependent.
  // Deletion owner: #664 follow-up.
  "team-push.js",

  // #664: replaced by the native `tkr hook session-summary` verb. BOTH
  // plugin.json entries changed — this file is wired at Stop AND at
  // SessionEnd with disjoint jobs, so a port that rewired only one would
  // have been a silent half-port. Same one-release rollback path as the
  // entries above.
  //
  // Four-pass grep results, recorded so nobody re-runs them:
  // hooks/session-summary.test.js require()s this file directly
  // (renderSummary, extractSessionID). That IS a live dependent, but it
  // is the JS unit test for the code awaiting deletion rather than a
  // runtime wiring path, so it does not block unwiring and it goes at
  // the same time as this file. README.md and hooks/CLAUDE.md carry
  // inventory rows, both updated with the port. cmd_doctor_hook_exec.go:78
  // names the file only in a comment. inv132_hook_attribution.py carries
  // the bare string "session-summary" in an allowlist of hook NAMES for
  // attribution — it neither requires nor spawns this file. DONE.md,
  // TODO.md and docs/release-notes*.md are historical records.
  // test/bench/fixtures/github/gh-repo-view.txt is a captured `gh repo
  // view` snapshot used as bench INPUT — it must keep its original text
  // and is not a dependent.
  // Deletion owner: #664 follow-up, alongside team-push.js.
  "session-summary.js",

  // #664 Wave B: replaced by the native `tkr hook agent-search-inject` verb
  // (internal/hooks/agentsearchinject.go). Same one-release rollback path as
  // the entries above — revert the plugin.json PreToolUse(Agent) entry to
  // re-wire it.
  //
  // Four-pass grep results, recorded so nobody re-runs them. Two test files
  // require it directly (agent-search-inject.test.js and
  // agent-search-inject.work-assisted.test.js); those are the JS unit tests
  // for the code awaiting deletion, so they go at the same time and do not
  // block unwiring. Its four lib/ helpers were swept INDIVIDUALLY, because
  // "the top-level hook moved" is not a reason to delete a directory — the
  // sessionstart/ lesson in #664 was exactly that:
  //   lib/subagent-context.js    KEEP — keepalive-activity.js and
  //                              user-prompt-submit.js both require it
  //   lib/injection-config.js    KEEP — posttool/ctx-breakpoint.js and
  //                              user-prompt-submit.js both require it
  //   lib/git-status-snapshot.js KEEP — subagent-outcome.js requires it
  //   lib/work-route-state.js    KEEP — user-prompt-submit.js requires it,
  //                              and it is still the WRITER of the receipt
  //                              the Go hook now reads
  //   lib/task-spawns.js         no other requirer, but its READONLY twin is
  //   lib/veto-fallback.js       parsed by internal/route/veto_fallback_sync_test.go
  //                              as the Go-side profile-registry guard; both
  //                              stay until that test's fate is decided.
  // Everything else naming this file is documentation or a historical record.
  // Deletion owner: #664 follow-up, alongside session-summary.js.
  "agent-search-inject.js",

  // #664 Wave B: replaced by the native `tkr hook post-tool-call` verb
  // (internal/hooks/posttoolcall.go and its five siblings). Same one-release
  // rollback path as the entries above — revert the plugin.json PostToolUse
  // entry to re-wire it.
  //
  // Four-pass grep results, recorded so nobody re-runs them. Unlike the
  // entries above, this file has THREE live dependents that are not its own
  // unit test, and every one of them must move or die before it can be
  // deleted — this is not a same-day deletion:
  //   hooks/bench/e2e-latency-bench.js:216  SPAWNS it as a bench arm. Same
  //                                         shape as the dependent that made
  //                                         tkr-rewrite.js's scope wrong twice.
  //   hooks/lib/keepalive-interactive-answer.test.js:295  spawns it e2e to
  //                                         assert the #152 item 2 touch
  //                                         fires. That test covers
  //                                         lib/keepalive-activity.js, which
  //                                         is STILL LIVE for
  //                                         user-prompt-submit.js — so the
  //                                         test outlives this hook and needs
  //                                         re-pointing at the native verb.
  //   scripts/cache-footprint.py:101        spawns it to price the per-tool-
  //                                         call hook cost.
  // Its own unit test (post-tool-call.test.js) goes at the same time and does
  // not block unwiring. Its helpers were swept INDIVIDUALLY, because "the
  // top-level hook moved" is not a reason to delete a directory.
  //
  // That sweep was done by RESOLVING every require() under hooks/ into a
  // graph, not by grepping for filenames, and the two methods disagree —
  // which is the whole reason to record the result. The widely-held belief
  // going in (it is written into the port brief for this hook) was that
  // lib/posttool/{brevity,response,ctx-breakpoint,telemetry}.js are shared
  // with user-prompt-submit.js and others. They are NOT: `grep -n require
  // hooks/user-prompt-submit.js` lists 24 requires and none of them is a
  // posttool/ module. Every one of those four has exactly ONE live requirer,
  // this hook. Believing otherwise is the strictly worse error of the two —
  // it strands four dead files as permanently un-deletable, and nothing ever
  // re-checks a KEEP.
  //
  // PRIVATE — no live requirer but this hook, so they go WITH it:
  //   cache-bust-detector.js, push-clear-nudge.js
  //   lib/posttool/{brevity,response,ctx-breakpoint,telemetry,cap-nudge,
  //                 explore-nudge,bash-filter,session-ingest,sideeffects,
  //                 commit-refresh,tkr-spawn}.js
  //   lib/agent-completions.js
  //   hooks/data/posttool/{ctx-breakpoint-advisories.json,explore-nudge.md}
  // tkr-spawn.js is private TRANSITIVELY — its only requirers are four other
  // modules on this list. The *.test.js beside each of these is that module's
  // own unit test and goes with it; gate-contract.test.js is the exception,
  // since it drives cap-nudge and ctx-breakpoint alongside gates that outlive
  // them, so it needs editing rather than deleting.
  //
  // The direction of one edge was believed backwards and is worth stating:
  // lib/injection-config.js does NOT require ctx-breakpoint. ctx-breakpoint
  // requires injection-config. injection-config stays either way (see below),
  // but reading that edge the wrong way makes ctx-breakpoint look shared.
  //
  // SHARED — live requirers outside this hook, so they STAY:
  //   lib/injection-config.js    agent-search-inject.js + user-prompt-submit.js
  //   lib/keepalive-activity.js  user-prompt-submit.js
  //   lib/effort-log.js          user-prompt-submit.js
  //   lib/session-id.js          user-prompt-submit.js, session-summary.js,
  //                              subagent-outcome.js, agent-search-inject.js
  //   lib/state-dir.js           ~20 requirers
  //   lib/{spawn-bounded,stdin-with-timeout,rotate-jsonl,safe-json,tkr-bin,
  //        statusline-path,resident-client}.js — all reached from
  //                              user-prompt-submit.js or another live hook.
  //
  // ONE DOWNSTREAM CONSEQUENCE, invisible from this file: lib/agent-
  // completions.js require()s ../subagent-outcome.js directly for parseHandoff,
  // and that edge is the ONLY reason hooks/CLAUDE.md records subagent-outcome.js
  // as "NOT deletion-pending" despite its own port. Deleting agent-completions.js
  // with this hook is therefore what unblocks subagent-outcome.js — re-read that
  // row before assuming it still applies.
  //
  // Deletion owner: #664 follow-up, and it must land AFTER the three
  // dependents above are re-pointed.
  "post-tool-call.js",

  // #664 Wave B Stage 3: replaced by the native `tkr hook user-prompt-submit`
  // verb (internal/hooks/userpromptsubmit.go and its six siblings). Same
  // one-release rollback path as the entries above — revert the plugin.json
  // UserPromptSubmit entry to re-wire it.
  //
  // Four-pass sweep, recorded so nobody re-runs it. Like post-tool-call.js this
  // is NOT a same-day deletion: four live dependents that are not its own unit
  // tests must move or die first, and three of them are the SPAWN shape that
  // made tkr-rewrite.js's scope wrong twice — nothing about them looks like a
  // hook-wiring reference.
  //   hooks/bench/e2e-latency-bench.js:211      spawns it as a bench arm.
  //   hooks/bench/js-fork-budget.test.js:54     names it as the fork-budget
  //                                             subject — and it is THE hook
  //                                             that test exists for, since it
  //                                             is the one seen cancelled in
  //                                             production. Re-point at the
  //                                             native verb rather than delete:
  //                                             the budget it asserts is now 0
  //                                             forks, not 1.
  //   hooks/bench/userprompt-bench.js:42-43     require()s writeInjectionLogRow
  //                                             directly for the writer bench.
  //   hooks/lib/keepalive-activity.test.js:33   spawns it e2e to assert the
  //                                             #129 typed-prompt touch fires.
  //                                             That test covers a lib that
  //                                             OUTLIVES this hook, so it needs
  //                                             re-pointing, not deleting —
  //                                             exactly the note already written
  //                                             against post-tool-call.js for
  //                                             the sibling assertion at :295.
  // hooks/agent-search-inject.work-assisted.test.js:744,783 also spawns it, but
  // that is the unit test for a file already on this list and goes with it.
  // Its own eleven *.test.js files go at the same time and do not block
  // unwiring.
  //
  // TWO INTEGRATION SCRIPTS still drive the JS, and this is a real coverage
  // gap for one release rather than a bookkeeping note — they assert
  // PRODUCTION behavior and, pointed at the JS, they now assert the rollback
  // path instead:
  //   test/integration/route-subagent-skip.sh:68   PLAN-3 T12. The JS hook
  //                                         names this script by path as the
  //                                         thing that would fail if the
  //                                         merged-spawn predicate classified
  //                                         a subagent dispatch. Re-pointing
  //                                         it is not a one-liner: it
  //                                         pre-seeds the prompt-hash cache
  //                                         and depends on the hook not
  //                                         classifying over it.
  //   test/integration/route-classifier.sh:452    spawns it as a cache-warm
  //                                         step.
  // The Go side does cover the subagent skip
  // (TestRouteInjectSkipsAndDisables in
  // internal/hooks/userpromptsubmit_test.go), so the behavior is gated — it is
  // the END-TO-END assertion that is not. test/integration/playbook-disabled-
  // regression.sh WAS a third and is already re-pointed at run_native.
  //
  // PRIVATE — no live requirer but this hook, so they go WITH it:
  //   lib/{stage-trace,route-source,classify-timeout,playbook-emit,
  //        work-directives}.js
  //   lib/slash-marker.js — WRITER half now native too (internal/slashmarker),
  //        so the file is fully superseded rather than half-shared.
  //
  // NEWLY PRIVATE, and this is the change this port makes to the graph:
  //   lib/injection-config.js    was SHARED with agent-search-inject.js
  //   lib/route-state.js         was SHARED with agent-search-inject.js
  //   lib/work-route-state.js    was SHARED with agent-search-inject.js
  // All three now have exactly TWO requirers, this hook and agent-search-inject.js,
  // and both are on this list — so they become deletable when both go, not
  // before. Deliberately NOT moved to a PRIVATE line above, because the entry
  // above still lists injection-config.js under SHARED on the strength of this
  // hook; leaving that reading intact and correcting it here is what keeps the
  // two entries from disagreeing.
  //
  // ONE CROSS-LANGUAGE CONTRACT CLOSED: work-receipt-<sid>.json and
  // slash-marker-<sid>.json were written by node and read by Go. Both halves
  // are Go now, so internal/hooks/agentsearchinject_receipt_test.go's
  // TestJSWriterAndGoReaderAgreeOnWorkReceipt — which runs the real node writer
  // — is pinning a writer that production no longer uses. It still passes and
  // is left alone for the rollback window; it goes with this file.
  //
  // Deletion owner: #664 follow-up, and it must land AFTER the four dependents
  // above are re-pointed.
  "user-prompt-submit.js",
]);

// Nothing was added here for the #664 Phase 4 cutover, and that is the
// point: session-start.js and memory-health.js were DELETED in the same
// commit that unwired them, so they never spent a release known-dead.
// DELETION_PENDING is for the gap between unwiring and deletion; a file
// removed in the same change skips the list entirely.

test("HOOK-002: every top-level hook is wired or required by a wired hook", () => {
  const hooksDir = __dirname;
  const pluginJSON = fs.readFileSync(
    path.join(hooksDir, "..", ".claude-plugin", "plugin.json"),
    "utf8",
  );

  const wired = new Set();
  for (const m of pluginJSON.matchAll(/hooks\/([\w.-]+\.(?:js|sh|ps1))/g)) {
    wired.add(m[1]);
  }

  const topLevel = fs
    .readdirSync(hooksDir)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));

  // A hook is also "reachable" when another hook module requires it (helper
  // modules like cache-bust-detector.js / push-clear-nudge.js).
  //
  // The requiring module is not necessarily top-level, so walk every .js
  // under hooks/ and resolve each require against the file that wrote it.
  // The case that established this: lib/sessionstart/memory-nudge.js
  // require()d ../../memory-health.js, which is how that file stayed live
  // through #664's port of its Stop entry to `tkr hook memory-health` —
  // unwired in plugin.json, still loaded at SessionStart. A scan of
  // top-level requires alone could not see that edge and would have called
  // a file with a live runtime dependent an orphan, the same under-counting
  // the DELETION_PENDING note above warns about, in the opposite direction.
  // Both files are gone as of the #664 Phase 4 cutover; the walk stays,
  // because the class of edge it catches does not depend on that example.
  const required = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".js")) {
        const src = fs.readFileSync(full, "utf8");
        for (const m of src.matchAll(/require\("(\.[./\w-]+?)(?:\.js)?"\)/g)) {
          const target = path.resolve(path.dirname(full), m[1] + ".js");
          if (path.dirname(target) === hooksDir) {
            required.add(path.basename(target));
          }
        }
      }
    }
  };
  walk(hooksDir);

  const orphans = topLevel.filter(
    (f) => !wired.has(f) && !required.has(f) && !DELETION_PENDING.has(f),
  );
  assert.deepStrictEqual(
    orphans,
    [],
    `unwired hook producers (wire them in plugin.json or delete both sides): ${orphans.join(", ")}`,
  );
});

// Reverse direction of the guard above: a reference with no file behind
// it fails silently at runtime (Claude Code skips erroring hooks), which
// is how caveman shipped intensity levels that were "silently cosmetic".
test("HOOK-002: every plugin.json command reference resolves to a file", () => {
  const repoRoot = path.join(__dirname, "..");
  const plugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"),
  );

  const missing = [];
  for (const entries of Object.values(plugin.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) {
        const m = (h.command || "").match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/);
        if (!m) continue;
        if (!fs.existsSync(path.join(repoRoot, m[1]))) {
          missing.push(`${m[1]} (referenced by "${h.command}")`);
        }
      }
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    `plugin.json references files that do not exist: ${missing.join(", ")}`,
  );
});

// The check is on the MATCHER being wired to a handler, not on which handler:
// #664 ported this hook from hooks/skill-invoked.js to the native
// `tkr hook skill-invoked` verb, and a guard that named the JS command string
// would have reported the hook unwired the moment it went native — the same
// failure the routeeval preflight hit at #742, where a registration check
// matched on the JS command form and a port broke it. Both command forms are
// accepted so this test survives the next port too.
test("HOOK-002: the PreToolUse Skill matcher is wired to a skill-invoked handler", () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const entry = (plugin.hooks.PreToolUse || []).find(
    (e) =>
      e.matcher === "Skill" &&
      (e.hooks || []).some((h) => {
        const cmd = h.command || "";
        return cmd.includes("skill-invoked.js") || /\btkr hook skill-invoked\b/.test(cmd);
      }),
  );
  assert.ok(
    entry,
    "PreToolUse Skill matcher must run either hooks/skill-invoked.js or `tkr hook skill-invoked`",
  );
});

// Same shape, same reason, for the Agent matcher: #664 Wave B ported this hook
// to `tkr hook agent-search-inject`, and a guard naming the JS command string
// would report the spawn hook unwired the moment it went native. That matcher
// is where run_in_background=false, the spawn ledger, the assisted rewrite and
// the ADR-0033 veto all live, so "wired to SOMETHING" is the fact worth
// pinning; which side of the language boundary answers is not.
test("HOOK-002: the PreToolUse Agent matcher is wired to an agent-search-inject handler", () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const entry = (plugin.hooks.PreToolUse || []).find(
    (e) =>
      e.matcher === "Agent" &&
      (e.hooks || []).some((h) => {
        const cmd = h.command || "";
        return (
          cmd.includes("agent-search-inject.js") ||
          /\btkr hook agent-search-inject\b/.test(cmd)
        );
      }),
  );
  assert.ok(
    entry,
    "PreToolUse Agent matcher must run either hooks/agent-search-inject.js or `tkr hook agent-search-inject`",
  );
});

// Same shape again for the UNMATCHED PostToolUse entry, ported in #664 Wave B.
// This one is worth pinning for a reason the other two are not: it is the
// entry that receives EVERY tool call, and three separate features ride on
// that fact rather than on a matcher of their own — the compression pipeline,
// the agent-completion ledger, and the #152 item 2 keepalive touch. A matcher
// added here to "scope" it would silently remove the second and third; an
// entry lost here removes all of them with no error anywhere, because Claude
// Code skips a hook it cannot run.
test("HOOK-002: the unmatched PostToolUse entry is wired to a post-tool-call handler", () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const entry = (plugin.hooks.PostToolUse || []).find(
    (e) =>
      e.matcher === undefined &&
      (e.hooks || []).some((h) => {
        const cmd = h.command || "";
        return cmd.includes("post-tool-call.js") || /\btkr hook post-tool-call\b/.test(cmd);
      }),
  );
  assert.ok(
    entry,
    "PostToolUse needs an UNMATCHED entry running either hooks/post-tool-call.js or `tkr hook post-tool-call`",
  );
});
