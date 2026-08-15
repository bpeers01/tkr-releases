#!/usr/bin/env node
// Probe test for hooks/skill-invoked.js — confirms one row per call,
// kill-switch behavior, and field shape.
//
// Run: node hooks/skill-invoked.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA_VERSION } = require("./skill-invoked.js");

const HOOK = path.resolve(__dirname, "skill-invoked.js");
const LOG_NAME = "instructions-load.jsonl";

function runHook(payload, extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-skill-test-"));
  const env = { ...process.env, TKR_STATE_DIR: tmp };
  // Strip any inherited kill switches unless caller asked for them.
  delete env.TKR_HOOKS_DISABLED;
  delete env.TKR_SKILL_AUDIT_DISABLED;
  Object.assign(env, extraEnv || {});
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  const log = path.join(tmp, LOG_NAME);
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { res, rows, tmp, log };
}

test("returns {} on stdout for a valid Skill call", () => {
  const { res, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill: "ctx-audit" },
    session_id: "s-1",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
});

test("appends row with required PLAN-4 fields", () => {
  const { rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill: "tkr:continue", args: "" },
    session_id: "s-abc",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.event, "skill-invoked");
  assert.strictEqual(r.skill_name, "tkr:continue");
  assert.strictEqual(r.session_id, "s-abc");
  assert.strictEqual(r.schema_version, SCHEMA_VERSION);
  // v2: resolved, not hedged. No slash marker was written for this turn,
  // and a Skill dispatch on a turn the user did not open with /<skill>
  // is an auto trigger. "unknown" was the honest answer only while
  // nothing could tell the two apart.
  assert.strictEqual(r.invocation_source, "auto");
  assert.ok(typeof r.ts === "string" && r.ts.length > 0);
});

test("accepts spec-shape tool_input.skill_name as fallback", () => {
  // PLAN-4 L45 verify-gate uses skill_name; real CC uses skill.
  const { rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill_name: "ctx-audit" },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].skill_name, "ctx-audit");
});

test("prefers tool_input.skill over skill_name when both present", () => {
  const { rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: { skill: "real", skill_name: "fallback" },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].skill_name, "real");
});

test("no row when skill name missing", () => {
  const { res, rows, tmp } = runHook({
    tool_name: "Skill",
    tool_input: {},
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("no row when tool_name is not Skill (misrouted matcher)", () => {
  const { rows, tmp } = runHook({
    tool_name: "Bash",
    tool_input: { skill: "ctx-audit" },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(rows.length, 0);
});

test("TKR_HOOKS_DISABLED=1 makes hook a no-op", () => {
  const { res, rows, tmp } = runHook(
    { tool_name: "Skill", tool_input: { skill: "ctx-audit" } },
    { TKR_HOOKS_DISABLED: "1" }
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("TKR_SKILL_AUDIT_DISABLED=1 makes hook a no-op (T7)", () => {
  const { res, rows, tmp } = runHook(
    { tool_name: "Skill", tool_input: { skill: "ctx-audit" } },
    { TKR_SKILL_AUDIT_DISABLED: "1" }
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("malformed JSON stdin → {} and no row", () => {
  const { res, rows, tmp } = runHook("{not json");
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, "{}");
  assert.strictEqual(rows.length, 0);
});

test("buildRow unit shape", () => {
  const { buildRow } = require("./skill-invoked.js");
  const row = buildRow({
    tool_name: "Skill",
    tool_input: { skill: "x" },
    session_id: "s",
  });
  assert.strictEqual(row.event, "skill-invoked");
  assert.strictEqual(row.schema_version, SCHEMA_VERSION);
  assert.strictEqual(row.skill_name, "x");
  assert.strictEqual(row.session_id, "s");
});

test("a slash-command turn is recorded as manual, not auto", () => {
  // The point of schema v2: "the skill fired 40 times" is not a trigger
  // measurement if the user typed /foo 40 times. The marker is written
  // by UserPromptSubmit; this asserts the reader half honors it.
  const { recordSlashCommand } = require("./lib/slash-marker.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-skill-manual-"));
  const prev = process.env.TKR_STATE_DIR;
  process.env.TKR_STATE_DIR = tmpDir;
  try {
    recordSlashCommand("/compress", "s-manual", "p-1");
    const { buildRow } = require("./skill-invoked.js");
    const row = buildRow({
      tool_name: "Skill",
      tool_input: { skill: "compress" },
      session_id: "s-manual",
      prompt_id: "p-1",
    });
    assert.strictEqual(row.invocation_source, "manual");

    // Same skill, a later turn. Must not inherit the marker.
    const later = buildRow({
      tool_name: "Skill",
      tool_input: { skill: "compress" },
      session_id: "s-manual",
      prompt_id: "p-2",
    });
    assert.strictEqual(later.invocation_source, "auto");
  } finally {
    if (prev === undefined) delete process.env.TKR_STATE_DIR;
    else process.env.TKR_STATE_DIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildRow carries bundle_dir_version + bundle_cross_version when the bundle resolved one (#219)", () => {
  const { buildRow } = require("./skill-invoked.js");
  const row = buildRow(
    { tool_name: "Skill", tool_input: { skill: "dataviz" }, session_id: "s" },
    {
      bundle: { tokens: 100, bytes: 400, files: 1, version: "2.1.221", crossVersion: true },
      mode: "ask",
      action: "ask",
    }
  );
  assert.strictEqual(row.bundle_dir_version, "2.1.221");
  assert.strictEqual(row.bundle_cross_version, true);
});

test("buildRow omits bundle_dir_version when the bundle carries no version (pre-#219 cache entry)", () => {
  const { buildRow } = require("./skill-invoked.js");
  const row = buildRow(
    { tool_name: "Skill", tool_input: { skill: "claude-api" }, session_id: "s" },
    { bundle: { tokens: 100, bytes: 400, files: 1 }, mode: "ask", action: "ask" }
  );
  assert.strictEqual(row.bundle_dir_version, undefined);
  assert.strictEqual(row.bundle_cross_version, undefined);
});

// --- INV-095 gate, end to end ----------------------------------------

const BIG_TOKENS = 200_000;

// Seeds the measurement cache rather than planting a tree under the real
// bundled-skills root: the hook cannot tell the difference, and the test
// must not depend on which Claude Code version happens to be installed
// on the machine running it.
function runGated(payload, extraEnv, seed) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-skill-gate-"));
  const treeDir = path.join(tmp, "tree");
  fs.mkdirSync(treeDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "skill-bundles.json"),
    JSON.stringify({
      schema: 2,
      entries: {
        "claude-api": {
          dir: treeDir,
          tokens: BIG_TOKENS,
          bytes: BIG_TOKENS * 4,
          files: 65,
          index: [
            ["shared/model-migration.md", 44088],
            ["shared/pricing.md", 12000],
          ],
          ts: Date.now(),
        },
      },
    })
  );
  const env = { ...process.env, TKR_STATE_DIR: tmp };
  for (const k of [
    "TKR_HOOKS_DISABLED",
    "TKR_SKILL_AUDIT_DISABLED",
    "TKR_SKILL_GATE",
    "TKR_SKILL_GATE_DISABLED",
    "TKR_SKILL_GATE_THRESHOLD",
  ]) {
    delete env[k];
  }
  Object.assign(env, extraEnv || {});
  if (seed) seed(tmp);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  const log = path.join(tmp, LOG_NAME);
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  let out = {};
  try {
    out = JSON.parse(res.stdout);
  } catch {
    out = { __unparsed: res.stdout };
  }
  return { res, out, rows, tmp, treeDir };
}

const gatedCall = {
  tool_name: "Skill",
  tool_input: { skill: "claude-api", args: "prompt caching ttl" },
  session_id: "s-gate",
  prompt_id: "p-gate",
};

test("gate default asks the user, and the question survives a no", () => {
  const { out, rows, tmp, treeDir } = runGated(gatedCall);
  try {
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, "ask");
    // An ask is not a block: the top-level form means deny, so emitting
    // it here would block on builds that read the old shape.
    assert.strictEqual(out.decision, undefined);
    const why = out.hookSpecificOutput.permissionDecisionReason;
    assert.match(why, /claude-api/);
    assert.ok(why.includes(treeDir), "reason must name the on-disk tree");
    assert.match(why, /shared\/model-migration\.md/);
    // Evidence is written before the decision, so a gated call still
    // leaves a row — same ordering as the spawn veto.
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].gate_mode, "ask");
    assert.strictEqual(rows[0].gate_action, "ask");
    assert.strictEqual(rows[0].bundle_tokens, BIG_TOKENS);
    assert.strictEqual(rows[0].bundle_bytes, BIG_TOKENS * 4);
    assert.strictEqual(rows[0].bundle_files, 65);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("deny mode still blocks in both response shapes", () => {
  const { out, rows, tmp } = runGated(gatedCall, { TKR_SKILL_GATE: "deny" });
  try {
    assert.strictEqual(out.decision, "block");
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
    assert.strictEqual(out.reason, out.hookSpecificOutput.permissionDecisionReason);
    assert.strictEqual(out.updatedInput, undefined);
    assert.strictEqual(rows[0].gate_action, "deny");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("warn mode notifies the user and never touches model context", () => {
  const { out, rows, tmp } = runGated(gatedCall, { TKR_SKILL_GATE: "warn" });
  try {
    assert.match(out.systemMessage, /claude-api/);
    assert.strictEqual(out.hookSpecificOutput, undefined);
    assert.strictEqual(out.decision, undefined);
    assert.strictEqual(rows[0].gate_action, "warn");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a manual /claude-api is never asked about — it is the escape hatch", () => {
  const { out, rows, tmp } = runGated(gatedCall, {}, (dir) => {
    const prev = process.env.TKR_STATE_DIR;
    process.env.TKR_STATE_DIR = dir;
    try {
      require("./lib/slash-marker.js").recordSlashCommand("/claude-api", "s-gate", "p-gate");
    } finally {
      if (prev === undefined) delete process.env.TKR_STATE_DIR;
      else process.env.TKR_STATE_DIR = prev;
    }
  });
  try {
    assert.deepStrictEqual(out, {});
    assert.strictEqual(rows[0].invocation_source, "manual");
    assert.strictEqual(rows[0].gate_action, "none");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a bundle under threshold is silent even in deny mode", () => {
  const { out, tmp } = runGated(gatedCall, {
    TKR_SKILL_GATE: "deny",
    TKR_SKILL_GATE_THRESHOLD: String(BIG_TOKENS + 1),
  });
  try {
    assert.deepStrictEqual(out, {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- #263 first-invocation manifest gate, end to end ------------------

// bundleFor must genuinely come up null: the bundle root lives under
// os.tmpdir(), so point the child's tmpdir (TMPDIR/TEMP/TMP) at an empty
// dir. The manifest and the fake binary it describes live in the state
// dir, exactly where the scraper writes them.
function runManifestGated(payload, extraEnv, mutate) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-skill-gate-"));
  const fakeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-empty-tmp-"));
  const bin = path.join(tmp, "claude.exe");
  fs.writeFileSync(bin, "b".repeat(4096));
  const st = fs.statSync(bin);
  const manifest = {
    schema: 1,
    ccVersion: "2.1.227",
    binaryPath: bin,
    binarySize: st.size,
    binaryMtimeMs: Math.floor(st.mtimeMs),
    scrapedAt: "2026-08-11T00:00:00.000Z",
    complete: true,
    skills: [{ name: "claude-api", hasTree: true, approxBytes: 867776, userInvocable: true }],
  };
  if (mutate) mutate(manifest, tmp);
  fs.writeFileSync(path.join(tmp, "skill-manifest.json"), JSON.stringify(manifest));
  const env = { ...process.env, TKR_STATE_DIR: tmp, TMPDIR: fakeTmp, TEMP: fakeTmp, TMP: fakeTmp };
  for (const k of [
    "TKR_HOOKS_DISABLED",
    "TKR_SKILL_AUDIT_DISABLED",
    "TKR_SKILL_GATE",
    "TKR_SKILL_GATE_DISABLED",
    "TKR_SKILL_GATE_THRESHOLD",
  ]) {
    delete env[k];
  }
  Object.assign(env, extraEnv || {});
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  const log = path.join(tmp, LOG_NAME);
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  let out = {};
  try {
    out = JSON.parse(res.stdout);
  } catch {
    out = { __unparsed: res.stdout };
  }
  return { res, out, rows, tmp, fakeTmp };
}

test("first invocation: the scrape manifest gates what bundleFor cannot see (#263)", () => {
  const { out, rows, tmp, fakeTmp } = runManifestGated(gatedCall);
  try {
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, "ask");
    const why = out.hookSpecificOutput.permissionDecisionReason;
    assert.match(why, /first invocation/i);
    // 867,776 scraped bytes as a range, never a point.
    assert.match(why, /217K/);
    assert.match(why, /316K/);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].gate_first_invocation, true);
    assert.strictEqual(rows[0].manifest_bytes, 867776);
    assert.strictEqual(rows[0].gate_mode, "ask");
    assert.strictEqual(rows[0].gate_action, "ask");
    // Scraped and measured populations stay separable in the ledger.
    assert.strictEqual(rows[0].bundle_tokens, undefined);
    assert.strictEqual(rows[0].bundle_bytes, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(fakeTmp, { recursive: true, force: true });
  }
});

test("first invocation: an unlisted skill stays ungated, exactly as before (#263 fail-open)", () => {
  const { out, rows, tmp, fakeTmp } = runManifestGated(gatedCall, null, (manifest) => {
    // claude-api unlisted -> manifestEntryFor null -> allow.
    manifest.skills = [];
  });
  try {
    assert.deepStrictEqual(out, {});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].gate_first_invocation, undefined);
    assert.strictEqual(rows[0].gate_action, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(fakeTmp, { recursive: true, force: true });
  }
});

test("first invocation: a SKILL.md-only manifest row never gates (#263)", () => {
  const { out, tmp, fakeTmp } = runManifestGated(gatedCall, null, (manifest) => {
    manifest.skills = [{ name: "claude-api", hasTree: false, approxBytes: null, userInvocable: true }];
  });
  try {
    assert.deepStrictEqual(out, {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(fakeTmp, { recursive: true, force: true });
  }
});

test("a row with no skill name still says unknown", () => {
  // The one case that genuinely cannot be answered: with no skill name
  // there is nothing to match a marker against, so the question was
  // never askable rather than answered "auto".
  const { buildRow } = require("./skill-invoked.js");
  const row = buildRow({ tool_name: "Skill", tool_input: {}, session_id: "s" });
  assert.strictEqual(row.skill_name, "");
  assert.strictEqual(row.invocation_source, "unknown");
});
