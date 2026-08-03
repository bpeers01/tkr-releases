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
const DELETION_PENDING = new Set([
  // (empty — mechanical-classifier.js was deleted by DOC-002(d))
]);

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

  // A hook is also "reachable" when a wired hook requires it (helper
  // modules like cache-bust-detector.js / push-clear-nudge.js).
  const required = new Set();
  for (const f of topLevel) {
    const src = fs.readFileSync(path.join(hooksDir, f), "utf8");
    for (const m of src.matchAll(/require\("\.\/([\w.-]+?)(?:\.js)?"\)/g)) {
      required.add(m[1] + ".js");
    }
  }

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
