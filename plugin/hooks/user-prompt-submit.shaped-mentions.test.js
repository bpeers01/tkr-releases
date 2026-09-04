#!/usr/bin/env node
// Tests for shaped @-mentions (#658): @path:map|sig|skel|L<n>-<m> parsed
// from the raw prompt, resolved via `tkr fread`, and injected as
// additionalContext with zero model turns.
//
// Run: node hooks/user-prompt-submit.shaped-mentions.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  shapedMentionContext,
  resolveShapedMention,
  shapedModeToFreadArg,
  shapedModeLabel,
  countLines,
  SHAPED_MENTION_CAP_BYTES,
} = require("./user-prompt-submit.js");

// ── shapedModeToFreadArg / shapedModeLabel ──────────────────────────────────

test("shapedModeToFreadArg maps the four mention tokens to fread modes", () => {
  assert.strictEqual(shapedModeToFreadArg("map"), "map");
  assert.strictEqual(shapedModeToFreadArg("sig"), "signatures");
  assert.strictEqual(shapedModeToFreadArg("skel"), "skeleton");
  assert.strictEqual(shapedModeToFreadArg("L40-90"), "lines:40-90");
  assert.strictEqual(shapedModeToFreadArg("bogus"), null);
});

test("shapedModeLabel is human-readable per mode", () => {
  assert.strictEqual(shapedModeLabel("map"), "map");
  assert.strictEqual(shapedModeLabel("sig"), "signatures");
  assert.strictEqual(shapedModeLabel("skel"), "skeleton");
  assert.strictEqual(shapedModeLabel("L40-90"), "lines 40-90");
});

// ── countLines ───────────────────────────────────────────────────────────────

test("countLines reads the real line count, -1 on missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-lines-"));
  try {
    const fp = path.join(dir, "five.txt");
    fs.writeFileSync(fp, "a\nb\nc\nd\ne\n");
    assert.strictEqual(countLines(fp), 6); // trailing empty line after last \n
    assert.strictEqual(countLines(path.join(dir, "missing.txt")), -1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── fread shim ───────────────────────────────────────────────────────────────
//
// Mirrors the TKR_BIN shim pattern in agent-search-inject.test.js: point
// TKR_BIN at a .js file, which tkrSpawnArgv launches as `node <path>`
// identically on every platform. This shim inspects `-mode` and prints a
// response sized/shaped for the test that installed it.
function installFreadShim(dir, modeToOutput) {
  const shim = path.join(dir, "tkr-fread-shim.js");
  const body =
    "const args = process.argv.slice(2);\n" +
    "const i = args.indexOf('-mode');\n" +
    "const mode = i >= 0 ? args[i + 1] : '';\n" +
    "const outputs = " + JSON.stringify(modeToOutput) + ";\n" +
    "if (Object.prototype.hasOwnProperty.call(outputs, mode)) {\n" +
    "  process.stdout.write(outputs[mode]);\n" +
    "  process.exit(0);\n" +
    "}\n" +
    "process.stderr.write('unhandled mode: ' + mode + '\\n');\n" +
    "process.exit(1);\n";
  fs.writeFileSync(shim, body);
  return shim;
}

function withTkrBin(shim, fn) {
  const prev = process.env.TKR_BIN;
  process.env.TKR_BIN = shim;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TKR_BIN;
    else process.env.TKR_BIN = prev;
  }
}

// ── resolveShapedMention ───────────────────────────────────────────────────

test("resolveShapedMention: missing path returns { missing: true }, no spawn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-missing-"));
  try {
    const res = resolveShapedMention("does-not-exist.js", "map", dir);
    assert.deepStrictEqual(res, { missing: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveShapedMention: bad mode token returns null before touching disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-badmode-"));
  try {
    const res = resolveShapedMention("anything.js", "bogus", dir);
    assert.strictEqual(res, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveShapedMention: map view under cap injects header + body verbatim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-map-"));
  try {
    const fixture = path.join(dir, "fixture.js");
    fs.writeFileSync(fixture, "line1\nline2\nline3\n");
    const shim = installFreadShim(dir, { map: "# Outline: fixture.js\nL1 foo\n" });
    withTkrBin(shim, () => {
      const res = resolveShapedMention("fixture.js", "map", dir);
      assert.ok(res && res.text, "expected a resolved text body");
      assert.match(res.text, /^\[tkr @mention fixture\.js: map view of 4-line file/);
      assert.match(res.text, /widen with tkr_read mode=lines:N-M\]/);
      assert.match(res.text, /# Outline: fixture\.js/);
      assert.doesNotMatch(res.text, /degraded to map/);
      assert.doesNotMatch(res.text, /not the complete view/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveShapedMention: L<n>-<m> resolves via lines:N-M and points expansion at map", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-lines-mode-"));
  try {
    const fixture = path.join(dir, "fixture.js");
    fs.writeFileSync(fixture, "a\n".repeat(200));
    const shim = installFreadShim(dir, { "lines:40-90": "...40 lines of content...\n" });
    withTkrBin(shim, () => {
      const res = resolveShapedMention("fixture.js", "L40-90", dir);
      assert.match(res.text, /^\[tkr @mention fixture\.js: lines 40-90 view of 201-line file/);
      assert.match(res.text, /widen with tkr_read mode=map for the full outline\]/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveShapedMention: over-cap skeleton degrades to map and says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-degrade-"));
  try {
    const fixture = path.join(dir, "big.js");
    fs.writeFileSync(fixture, "x\n".repeat(5000));
    const bigSkeleton = "S".repeat(SHAPED_MENTION_CAP_BYTES + 500);
    const smallMap = "# Outline: big.js\nL1 fn a\n";
    const shim = installFreadShim(dir, { skeleton: bigSkeleton, map: smallMap });
    withTkrBin(shim, () => {
      const res = resolveShapedMention("big.js", "skel", dir);
      assert.match(res.text, /requested skeleton exceeded the injection cap, degraded to map/);
      assert.match(res.text, /# Outline: big\.js/);
      assert.doesNotMatch(res.text, /S{10,}/); // the oversized skeleton body was discarded
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveShapedMention: even the map view over cap gets hard-truncated and says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-hardtrunc-"));
  try {
    const fixture = path.join(dir, "huge.js");
    fs.writeFileSync(fixture, "x\n".repeat(50000));
    const hugeMap = "M".repeat(SHAPED_MENTION_CAP_BYTES + 5000);
    const shim = installFreadShim(dir, { map: hugeMap });
    withTkrBin(shim, () => {
      const res = resolveShapedMention("huge.js", "map", dir);
      assert.match(res.text, /view truncated at \d+ bytes, not the complete view/);
      const bodyBytes = Buffer.byteLength(res.text.split("\n").slice(1).join("\n"), "utf8");
      assert.ok(bodyBytes <= SHAPED_MENTION_CAP_BYTES);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveShapedMention: fread failure (non-zero exit) fails open to null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-failopen-"));
  try {
    const fixture = path.join(dir, "fixture.js");
    fs.writeFileSync(fixture, "x\n");
    const shim = installFreadShim(dir, {}); // no mode handled -> exit 1
    withTkrBin(shim, () => {
      const res = resolveShapedMention("fixture.js", "map", dir);
      assert.strictEqual(res, null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── shapedMentionContext (full parse + resolve pipeline) ───────────────────

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

test("shapedMentionContext: @path:map injects, zero warnings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-ctx-ok-"));
  try {
    const fixture = path.join(dir, "f.js");
    fs.writeFileSync(fixture, "a\nb\n");
    const shim = installFreadShim(dir, { map: "# Outline: f.js\nL1 fn a\n" });
    withTkrBin(shim, () => {
      withCwd(dir, () => {
        const res = shapedMentionContext({ prompt: "look at @f.js:map please" });
        assert.match(res.context, /\[tkr @mention f\.js: map view/);
        assert.strictEqual(res.systemMessage, "");
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shapedMentionContext: missing file warns via systemMessage, no context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-ctx-missing-"));
  try {
    withCwd(dir, () => {
      const res = shapedMentionContext({ prompt: "check @nope.js:map" });
      assert.strictEqual(res.context, "");
      assert.match(res.systemMessage, /"nope\.js" not found/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shapedMentionContext: @path#mode warns about the harness stripping '#suffix', injects nothing for it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-ctx-hash-"));
  try {
    const fixture = path.join(dir, "f.js");
    fs.writeFileSync(fixture, "a\n");
    withCwd(dir, () => {
      const res = shapedMentionContext({ prompt: "see @f.js#map" });
      assert.strictEqual(res.context, "");
      assert.match(res.systemMessage, /attached the FULL file/);
      assert.match(res.systemMessage, /Use "@f\.js:map"/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shapedMentionContext: a mention typed twice resolves and injects once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-ctx-dedup-"));
  try {
    const fixture = path.join(dir, "f.js");
    fs.writeFileSync(fixture, "a\n");
    const shim = installFreadShim(dir, { map: "# Outline: f.js\n" });
    withTkrBin(shim, () => {
      withCwd(dir, () => {
        const res = shapedMentionContext({ prompt: "@f.js:map and again @f.js:map" });
        const occurrences = res.context.split("# Outline: f.js").length - 1;
        assert.strictEqual(occurrences, 1);
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shapedMentionContext: no @ in prompt is a no-op with no subprocess", () => {
  const res = shapedMentionContext({ prompt: "just a normal prompt, no mentions here" });
  assert.deepStrictEqual(res, { context: "", systemMessage: "" });
});

test("shapedMentionContext: subagent dispatch is never parsed for mentions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-ctx-subagent-"));
  try {
    const fixture = path.join(dir, "f.js");
    fs.writeFileSync(fixture, "a\n");
    withCwd(dir, () => {
      // isSubagentContext keys on agent_id/agent_type/scope/subagent_type —
      // see hooks/lib/subagent-context.js.
      const res = shapedMentionContext({
        prompt: "@f.js:map",
        agent_id: "agent-123",
      });
      assert.deepStrictEqual(res, { context: "", systemMessage: "" });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shapedMentionContext: TKR_SHAPED_MENTIONS_DISABLED=1 kill switch short-circuits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-shaped-ctx-killswitch-"));
  const prev = process.env.TKR_SHAPED_MENTIONS_DISABLED;
  process.env.TKR_SHAPED_MENTIONS_DISABLED = "1";
  try {
    const fixture = path.join(dir, "f.js");
    fs.writeFileSync(fixture, "a\n");
    withCwd(dir, () => {
      const res = shapedMentionContext({ prompt: "@f.js:map" });
      assert.deepStrictEqual(res, { context: "", systemMessage: "" });
    });
  } finally {
    if (prev === undefined) delete process.env.TKR_SHAPED_MENTIONS_DISABLED;
    else process.env.TKR_SHAPED_MENTIONS_DISABLED = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
