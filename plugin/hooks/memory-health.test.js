#!/usr/bin/env node
// Probe test for hooks/memory-health.js — verifies source-confirmed
// constants and frontmatter-quality detection.
//
// Run: node hooks/memory-health.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  auditMemDir,
  auditMemIndex,
  checkFrontmatter,
  classify,
  parseCreated,
  entryAgeDays,
  staleDaysForProvenance,
  STALE_DAYS,
  STALE_DAYS_BY_PROVENANCE,
  INDEX_LINE_CAP,
  INDEX_CHAR_CAP,
  MAX_MEMORY_FILES_WARN,
  MIN_DESCRIPTION_LENGTH,
} = require("./memory-health.js");

function mkTmpMemDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-mem-test-"));
  return tmp;
}

function writeMem(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

function fm(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("---", "", "body content here.");
  return lines.join("\n");
}

test("INDEX_CHAR_CAP matches source MAX_ENTRYPOINT_BYTES = 25000", () => {
  assert.strictEqual(INDEX_CHAR_CAP, 25000);
});

test("INDEX_LINE_CAP matches source MAX_ENTRYPOINT_LINES = 200", () => {
  assert.strictEqual(INDEX_LINE_CAP, 200);
});

test("MAX_MEMORY_FILES_WARN is below 200-file cap", () => {
  assert.ok(MAX_MEMORY_FILES_WARN < 200);
  assert.ok(MAX_MEMORY_FILES_WARN >= 150);
});

test("checkFrontmatter flags missing fields", () => {
  assert.deepStrictEqual(checkFrontmatter({}), ["missing_frontmatter"]);
  assert.deepStrictEqual(
    checkFrontmatter({ name: "x", type: "user" }),
    ["missing_frontmatter"],
  );
  assert.deepStrictEqual(
    checkFrontmatter({ name: "x", description: "y" }),
    ["missing_frontmatter"],
  );
});

test("checkFrontmatter flags short description", () => {
  const issues = checkFrontmatter({
    name: "x",
    description: "short",
    type: "user",
  });
  assert.deepStrictEqual(issues, ["weak_description"]);
});

test("checkFrontmatter flags generic description", () => {
  const issues = checkFrontmatter({
    name: "x",
    description: "memory file",
    type: "user",
  });
  assert.deepStrictEqual(issues, ["weak_description"]);
});

test("checkFrontmatter passes for valid frontmatter", () => {
  const issues = checkFrontmatter({
    name: "user_role",
    description: "Senior backend engineer with deep Go expertise",
    type: "user",
  });
  assert.deepStrictEqual(issues, []);
});

test("auditMemDir counts missing-frontmatter files", () => {
  const dir = mkTmpMemDir();
  try {
    writeMem(dir, "no-fm.md", "no frontmatter at all\n");
    writeMem(
      dir,
      "valid.md",
      fm({
        name: "valid",
        description: "A specific actionable memory description",
        type: "user",
      }),
    );
    const r = auditMemDir(dir);
    assert.strictEqual(r.missingFrontmatter, 1);
    assert.strictEqual(r.weakDescription, 0);
    assert.strictEqual(r.total, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditMemDir counts weak-description files", () => {
  const dir = mkTmpMemDir();
  try {
    writeMem(
      dir,
      "weak.md",
      fm({ name: "weak", description: "notes", type: "user" }),
    );
    writeMem(
      dir,
      "short.md",
      fm({ name: "short", description: "tiny", type: "user" }),
    );
    writeMem(
      dir,
      "ok.md",
      fm({
        name: "ok",
        description: "Specific enough description to be useful",
        type: "user",
      }),
    );
    const r = auditMemDir(dir);
    assert.strictEqual(r.weakDescription, 2);
    assert.strictEqual(r.missingFrontmatter, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditMemDir sets fileCountWarn when total > MAX_MEMORY_FILES_WARN", () => {
  const dir = mkTmpMemDir();
  try {
    for (let i = 0; i < MAX_MEMORY_FILES_WARN + 5; i++) {
      writeMem(
        dir,
        `mem-${i.toString().padStart(3, "0")}.md`,
        fm({
          name: `mem${i}`,
          description: "Specific enough description to be useful",
          type: "user",
        }),
      );
    }
    const r = auditMemDir(dir);
    assert.strictEqual(r.fileCountWarn, true);
    assert.ok(r.total > MAX_MEMORY_FILES_WARN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditMemDir does not warn at small file counts", () => {
  const dir = mkTmpMemDir();
  try {
    writeMem(
      dir,
      "one.md",
      fm({
        name: "one",
        description: "Specific enough description to be useful",
        type: "user",
      }),
    );
    const r = auditMemDir(dir);
    assert.strictEqual(r.fileCountWarn, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditMemIndex warns past 25000-byte cap", () => {
  const dir = mkTmpMemDir();
  try {
    const big = "x".repeat(25001);
    fs.writeFileSync(path.join(dir, "MEMORY.md"), big);
    const idx = auditMemIndex(dir);
    assert.strictEqual(idx.warn, true);
    assert.ok(idx.chars >= 25001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditMemIndex passes at 24000 bytes (under cap)", () => {
  const dir = mkTmpMemDir();
  try {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`- entry ${i}: short index line`);
    }
    fs.writeFileSync(path.join(dir, "MEMORY.md"), lines.join("\n"));
    const idx = auditMemIndex(dir);
    assert.strictEqual(idx.warn, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auditMemIndex warns past 200-line cap", () => {
  const dir = mkTmpMemDir();
  try {
    const lines = [];
    for (let i = 0; i < 201; i++) {
      lines.push(`- e${i}`);
    }
    fs.writeFileSync(path.join(dir, "MEMORY.md"), lines.join("\n"));
    const idx = auditMemIndex(dir);
    assert.strictEqual(idx.warn, true);
    assert.ok(idx.lines > 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("classify still detects DEAD via shipped/resolved markers", () => {
  const dir = mkTmpMemDir();
  try {
    writeMem(
      dir,
      "dead.md",
      fm({
        name: "dead",
        description: "Specific enough description to be useful",
        type: "project",
      }) + "\n\nphase 1 complete and pushed",
    );
    const r = auditMemDir(dir);
    assert.strictEqual(r.dead, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Provenance parity.
//
// The threshold table here and the one in internal/cmd/memory.go are parallel
// ports with no shared constant. The cases below are mirrored verbatim in
// internal/cmd/memory_test.go (TestClassifyMemEntry_ProvenanceThresholds,
// TestParseMemCreated) so a table edited on one side only fails on the side
// that was not edited, rather than diverging quietly.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-02T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

// Body with no dead markers and no forward keywords: age and provenance decide.
const NEUTRAL_BODY = "Distribution pipeline ships via the two-repo model.";

test("provenance table ordering: corrected > stated > observed > inferred", () => {
  const t = STALE_DAYS_BY_PROVENANCE;
  assert.ok(t["user-corrected"] > t["user-stated"]);
  assert.ok(t["user-stated"] > t.observed);
  assert.ok(t.observed > t.inferred);
  // Inferred must expire faster than the unclassed default; corrected slower.
  assert.ok(t.inferred < STALE_DAYS);
  assert.ok(t["user-corrected"] > STALE_DAYS);
});

test("provenance thresholds match the Go table", () => {
  // Hard-coded, not derived: this is the assertion that catches a one-sided
  // edit. The same four numbers appear in internal/cmd/memory.go.
  assert.deepStrictEqual(STALE_DAYS_BY_PROVENANCE, {
    "user-corrected": 180,
    "user-stated": 120,
    observed: 45,
    inferred: 7,
  });
  assert.strictEqual(STALE_DAYS, 21);
});

test("classify applies per-provenance stale thresholds", () => {
  const cases = [
    ["inferred expires first", "inferred", 8, "STALE"],
    ["inferred inside its week", "inferred", 6, "GOOD"],
    ["inferred stale before the flat default", "inferred", 14, "STALE"],
    ["observed survives the flat default", "observed", 30, "GOOD"],
    ["observed past 45d", "observed", 46, "STALE"],
    ["user-stated survives a quarter", "user-stated", 100, "GOOD"],
    ["user-stated past 120d", "user-stated", 121, "STALE"],
    ["user-corrected survives 120d", "user-corrected", 150, "GOOD"],
    ["user-corrected past 180d", "user-corrected", 181, "STALE"],
    // The superset guarantee: absent and unrecognized both mean 21.
    ["absent provenance keeps flat 21d", undefined, 30, "STALE"],
    ["absent provenance under 21d", undefined, 20, "GOOD"],
    ["unrecognized provenance keeps flat 21d", "vibes", 30, "STALE"],
    ["unrecognized provenance buys no runway", "user-corected", 30, "STALE"],
  ];
  for (const [name, provenance, ageDays, want] of cases) {
    const frontmatter = { type: "project" };
    if (provenance !== undefined) frontmatter.provenance = provenance;
    const got = classify(NEUTRAL_BODY, frontmatter, 900, daysAgo(ageDays), NOW);
    assert.strictEqual(got, want, `${name}: got ${got}, want ${want}`);
  }
});

test("staleDaysForProvenance falls back to the flat default", () => {
  assert.strictEqual(staleDaysForProvenance("inferred"), 7);
  assert.strictEqual(staleDaysForProvenance(""), STALE_DAYS);
  assert.strictEqual(staleDaysForProvenance(undefined), STALE_DAYS);
  assert.strictEqual(staleDaysForProvenance("nonsense"), STALE_DAYS);
  // Prototype keys are not thresholds.
  assert.strictEqual(staleDaysForProvenance("toString"), STALE_DAYS);
  assert.strictEqual(staleDaysForProvenance("constructor"), STALE_DAYS);
});

test("provenance does not age types that never aged", () => {
  // type decides whether an entry ages; provenance only decides how fast.
  for (const type of ["feedback", "user", ""]) {
    const got = classify(
      "Always check git diff before committing.",
      { type, provenance: "inferred" },
      2000,
      daysAgo(365),
      NOW,
    );
    assert.strictEqual(got, "GOOD", `type ${type} should not age on provenance`);
  }
});

test("forward keywords still block STALE regardless of provenance", () => {
  const got = classify(
    "Waiting for PLAN-18 before tagging v3.0.",
    { type: "project", provenance: "inferred" },
    900,
    daysAgo(365),
    NOW,
  );
  assert.strictEqual(got, "GOOD");
});

test("created: is the age source when present", () => {
  // mtime says "touched an hour ago" — a checkout does that. created: says the
  // claim is nine days old, and for an inferred claim that is expired.
  const got = classify(
    NEUTRAL_BODY,
    { type: "project", provenance: "inferred", created: "2026-07-24" },
    900,
    new Date(NOW.getTime() - 3600000),
    NOW,
  );
  assert.strictEqual(got, "STALE");
});

test("unparseable created: falls back to mtime, never to ancient", () => {
  const got = classify(
    NEUTRAL_BODY,
    { type: "project", provenance: "inferred", created: "sometime last year" },
    900,
    daysAgo(2),
    NOW,
  );
  assert.strictEqual(got, "GOOD");
});

test("future created: falls back to mtime", () => {
  assert.strictEqual(
    entryAgeDays(new Date(NOW.getTime() + 86400000 * 2), daysAgo(30), NOW),
    30,
  );
  assert.strictEqual(entryAgeDays(null, daysAgo(30), NOW), 30);
  assert.strictEqual(entryAgeDays(daysAgo(9), daysAgo(30), NOW), 9);
});

test("age is floored to whole days, matching the Go side", () => {
  // 21.5 days used to be STALE here and GOOD in the CLI.
  const mtime = new Date(NOW.getTime() - 21.5 * 86400000);
  assert.strictEqual(entryAgeDays(null, mtime, NOW), 21);
  assert.strictEqual(
    classify(NEUTRAL_BODY, { type: "project" }, 900, mtime, NOW),
    "GOOD",
  );
});

test("parseCreated accepts a date, tolerates a clock, rejects the rest", () => {
  const iso = (d) => d.toISOString().slice(0, 10);
  const ok = [
    ["2026-04-14", "2026-04-14"],
    ["  2026-04-14  ", "2026-04-14"],
    ["2026-04-14T09:30:00Z", "2026-04-14"],
    ["2026-04-14T09:30:00+02:00", "2026-04-14"],
    ["2026-04-14 09:30:00", "2026-04-14"],
    ["2026-04-14T09:30:00.123Z", "2026-04-14"],
  ];
  for (const [input, want] of ok) {
    const got = parseCreated(input);
    assert.ok(got instanceof Date, `${input} should parse`);
    assert.strictEqual(iso(got), want, `${input} → ${got && iso(got)}`);
  }
  const bad = [
    "",
    undefined,
    "2026-04",
    "2026",
    "April 14 2026",
    "14-04-2026",
    "2026-02-31", // impossible day is a bad date, not a guess
    "2026-13-01",
    "yesterday",
    "2026-04-14T09:30Z", // partial clock is not a form we accept
  ];
  for (const input of bad) {
    assert.strictEqual(parseCreated(input), null, `${input} should not parse`);
  }
});

test("auditMemDir counts provenance-classed stale files", () => {
  const dir = mkTmpMemDir();
  try {
    const desc = "Specific enough description to be useful";
    // 30 days old: stale as inferred (7d), fresh as user-corrected (180d).
    writeMem(
      dir,
      "inferred.md",
      fm({ name: "a", description: desc, type: "project", provenance: "inferred" }) +
        "\n" + NEUTRAL_BODY,
    );
    writeMem(
      dir,
      "corrected.md",
      fm({
        name: "b",
        description: desc,
        type: "project",
        provenance: "user-corrected",
      }) + "\n" + NEUTRAL_BODY,
    );
    const old = daysAgo(30);
    for (const n of ["inferred.md", "corrected.md"]) {
      fs.utimesSync(path.join(dir, n), old, old);
    }
    const r = auditMemDir(dir, undefined, NOW);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.total, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
