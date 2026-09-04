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

test("HOOK-002: skill-invoked.js is wired to PreToolUse Skill matcher", () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const entry = (plugin.hooks.PreToolUse || []).find(
    (e) =>
      e.matcher === "Skill" &&
      (e.hooks || []).some((h) => (h.command || "").includes("skill-invoked.js")),
  );
  assert.ok(entry, "PreToolUse Skill matcher must run skill-invoked.js");
});
