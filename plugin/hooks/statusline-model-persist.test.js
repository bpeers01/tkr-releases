// Tests for the MODEL_PERSIST block in hooks/statusline.sh (MODEL-LAG-001).
//
// The payload's `model_id` is the model of the transcript's most-recent
// ASSISTANT turn, so at UserPromptSubmit time for turn N it names turn
// N-1's model: the first prompt of a session has no model at all, and the
// prompt right after a `/model` switch routes against the model the user
// just left. The statusline is the only surface CC hands the LIVE model
// to, and this block is what makes that model outlive the render.
//
// So the property under test is "the live model reaches the payload, and
// nothing else in the payload is harmed getting it there" — the second
// half matters because this file is shared with CC's authoritative
// rate-limit fields and tkr's own writers.
//
// Strategy: extract the block VERBATIM from statusline.sh between the
// MODEL_PERSIST sentinels, so the test can never drift from the script it
// is testing. Skips on hosts without bash or jq.
//
// Run: node --test hooks/statusline-model-persist.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function which(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(finder, [cmd], { stdio: "ignore" });
  return r.status === 0;
}

const SKIP = !which("bash") || !which("jq");
const SCRIPT = path.join(__dirname, "statusline.sh");

function extractBlock() {
  // Normalize CRLF first: on a Windows checkout with core.autocrlf the
  // sentinel line ends \r\n, and JS `.` treats \r as a line terminator,
  // so the strict pattern never matches — green on CI (LF), red on
  // every Windows dev machine. Normalizing also keeps the extracted
  // block runnable by bash, which trips over stray \r.
  const src = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
  const m = src.match(
    /^\s*# >>> MODEL_PERSIST.*?\n([\s\S]*?)^\s*# <<< MODEL_PERSIST/m,
  );
  assert.ok(m, "MODEL_PERSIST sentinels not found in statusline.sh");
  return m[1];
}

// Run the extracted block against a synthetic payload and return the
// payload as it stands afterwards. `model` is the value $MODEL holds by
// the time the block runs — statusline.sh has already stripped the
// "Claude " prefix and " (1M context)" suffix upstream of here.
function runBlock(model, payloadBefore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-model-persist-"));
  const tel = path.join(dir, "claude-statusline.json");
  if (payloadBefore !== undefined) fs.writeFileSync(tel, payloadBefore);
  const script = `
set -u
TELEMETRY_FILE="$1"
MODEL="$2"
${extractBlock()}
`;
  try {
    const r = spawnSync("bash", ["-c", script, "bash", tel, model], {
      encoding: "utf8",
    });
    assert.strictEqual(r.status, 0, `block exited ${r.status}: ${r.stderr}`);
    return {
      exists: fs.existsSync(tel),
      raw: fs.existsSync(tel) ? fs.readFileSync(tel, "utf8") : null,
      dir,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the live model reaches the payload", { skip: SKIP }, () => {
  const out = runBlock("Haiku 4.5", "{}");
  assert.strictEqual(JSON.parse(out.raw).model_display, "Haiku 4.5");
});

// The whole point: routing reads model_display in preference to model_id,
// so the two must be able to disagree. A block that overwrote model_id,
// or refused to write when one was already present, would leave the lag
// exactly where it was.
test("model_display can disagree with model_id", { skip: SKIP }, () => {
  const out = runBlock(
    "Haiku 4.5",
    JSON.stringify({ model_id: "claude-opus-5-20260724" }),
  );
  const doc = JSON.parse(out.raw);
  assert.strictEqual(doc.model_display, "Haiku 4.5");
  assert.strictEqual(
    doc.model_id,
    "claude-opus-5-20260724",
    "model_id belongs to cmd_statusline_update — this block must not touch it",
  );
});

// This file carries CC's authoritative rate-limit numbers and tkr's own
// savings fields. A clobbering write here would silently degrade pressure
// classification, which is a much worse bug than the one being fixed.
test("every other field survives the merge", { skip: SKIP }, () => {
  const before = {
    seven_day_pct: 91,
    five_hour_pct: 40,
    seven_day_resets_at: 1770000000,
    tkr_savings_7d_pct: 73,
    turn_count: 12,
    model_id: "claude-opus-5",
  };
  const doc = JSON.parse(runBlock("Sonnet 5", JSON.stringify(before)).raw);
  for (const [k, v] of Object.entries(before)) {
    assert.deepStrictEqual(doc[k], v, `field ${k} was altered`);
  }
  assert.strictEqual(doc.model_display, "Sonnet 5");
});

test("a later render replaces the earlier model", { skip: SKIP }, () => {
  const doc = JSON.parse(
    runBlock("Sonnet 5", JSON.stringify({ model_display: "Opus 4.8" })).raw,
  );
  assert.strictEqual(doc.model_display, "Sonnet 5");
});

// Silence conditions. Each of these would otherwise write a payload that
// asserts something false about the session's model.
for (const [label, model] of [
  ["no model on stdin", ""],
  ["jq's null passthrough", "null"],
]) {
  test(`${label} writes nothing`, { skip: SKIP }, () => {
    const out = runBlock(model, JSON.stringify({ seven_day_pct: 50 }));
    const doc = JSON.parse(out.raw);
    assert.ok(
      !("model_display" in doc),
      `${label} should not have produced a model_display`,
    );
    assert.strictEqual(doc.seven_day_pct, 50);
  });
}

// The statusline runs before anything else in a fresh session, so the
// payload may not exist yet. Creating it is correct — that first render
// is precisely the turn-1 case where model_id does not exist either.
test("a missing payload is created, not skipped", { skip: SKIP }, () => {
  const out = runBlock("Opus 5", undefined);
  assert.ok(out.exists, "payload was not created");
  assert.strictEqual(JSON.parse(out.raw).model_display, "Opus 5");
});

// Corrupt payloads happen (interrupted write, full disk). The block must
// not propagate the corruption, and must not throw away the live model
// either — starting fresh is the only outcome that does both.
test("a corrupt payload is replaced, not propagated", { skip: SKIP }, () => {
  const doc = JSON.parse(runBlock("Opus 5", "{not json").raw);
  assert.strictEqual(doc.model_display, "Opus 5");
});

// statusline.sh strips decorations before this block, so the values that
// arrive here are the bare display names. Guard the contract with the
// consumer: route.NormalizeModel maps exactly these to matrix keys, and
// cmd_route_test.go's TestResolveActiveModel_DisplayBeatsID depends on
// this spelling surviving the write byte-for-byte.
test("display names are written verbatim", { skip: SKIP }, () => {
  for (const name of ["Opus 4.8", "Sonnet 5", "Haiku 4.5", "Opus 5"]) {
    assert.strictEqual(JSON.parse(runBlock(name, "{}").raw).model_display, name);
  }
});
