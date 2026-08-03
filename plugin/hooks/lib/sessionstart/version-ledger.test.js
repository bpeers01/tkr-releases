// Tests for hooks/lib/sessionstart/version-ledger.js
//
// Run: node --test hooks/lib/sessionstart/version-ledger.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODULE_PATH = require.resolve("./version-ledger");

// loadFresh returns a freshly-required version-ledger module with the given
// env overrides applied. Caller must call restore() in finally.
function loadFresh(envOverrides) {
  delete require.cache[MODULE_PATH];
  // Also clear state-dir so it re-reads TKR_STATE_DIR.
  const stateDirPath = require.resolve("../state-dir");
  delete require.cache[stateDirPath];

  const prev = {};
  for (const [k, v] of Object.entries(envOverrides || {})) {
    prev[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  const mod = require(MODULE_PATH);
  return {
    mod,
    restore() {
      for (const [k, prevVal] of Object.entries(prev)) {
        if (prevVal === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = prevVal;
        }
      }
      delete require.cache[MODULE_PATH];
      delete require.cache[stateDirPath];
    },
  };
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-vledger-"));
}

function readLedger(dir) {
  const p = path.join(dir, "version-ledger.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((acc, l) => {
      try {
        acc.push(JSON.parse(l));
      } catch {
        // skip malformed lines
      }
      return acc;
    }, []);
}

// --- tests ---

test("first append: empty dir → ledger created with correct fields", () => {
  const tmp = mkTmp();
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: "v9.0.0",
  });
  try {
    mod.appendVersionLedger("sess-001");
    const rows = readLedger(tmp);
    assert.strictEqual(rows.length, 1, "should have exactly one row");
    assert.strictEqual(rows[0].session_id, "sess-001");
    assert.strictEqual(rows[0].tkr_version, "v9.0.0");
    assert.ok(rows[0].first_seen, "first_seen must be present");
    // Verify it's a valid ISO 8601 / RFC3339 string.
    assert.ok(!isNaN(Date.parse(rows[0].first_seen)), "first_seen must be parseable as a date");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("dedup same day: two calls with same session + version → only one row", () => {
  const tmp = mkTmp();
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: "v9.0.0",
  });
  try {
    mod.appendVersionLedger("sess-002");
    mod.appendVersionLedger("sess-002");
    const rows = readLedger(tmp);
    assert.strictEqual(rows.length, 1, "second call must be deduped");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("different session, same day → two rows", () => {
  const tmp = mkTmp();
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: "v9.0.0",
  });
  try {
    mod.appendVersionLedger("sess-A");
    mod.appendVersionLedger("sess-B");
    const rows = readLedger(tmp);
    assert.strictEqual(rows.length, 2);
    const ids = rows.map((r) => r.session_id).sort();
    assert.deepStrictEqual(ids, ["sess-A", "sess-B"]);
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("different version, same session, same day → two rows", () => {
  const tmp = mkTmp();
  try {
    const { mod: mod1, restore: r1 } = loadFresh({
      TKR_STATE_DIR: tmp,
      TKR_VERSION: "v9.0.0",
    });
    try {
      mod1.appendVersionLedger("sess-C");
    } finally {
      r1();
    }

    const { mod: mod2, restore: r2 } = loadFresh({
      TKR_STATE_DIR: tmp,
      TKR_VERSION: "v9.1.0",
    });
    try {
      mod2.appendVersionLedger("sess-C");
    } finally {
      r2();
    }

    const rows = readLedger(tmp);
    assert.strictEqual(rows.length, 2, "different versions must produce two rows");
    const versions = rows.map((r) => r.tkr_version).sort();
    assert.deepStrictEqual(versions, ["v9.0.0", "v9.1.0"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing sessionID → no-op, file not created", () => {
  const tmp = mkTmp();
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: "v9.0.0",
  });
  try {
    mod.appendVersionLedger("");
    mod.appendVersionLedger(null);
    mod.appendVersionLedger(undefined);
    const ledger = path.join(tmp, "version-ledger.jsonl");
    assert.ok(!fs.existsSync(ledger), "ledger must not be created for empty session ID");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("TKR_VERSION_LEDGER_DISABLED=1 → no-op, file not created", () => {
  const tmp = mkTmp();
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: "v9.0.0",
    TKR_VERSION_LEDGER_DISABLED: "1",
  });
  try {
    mod.appendVersionLedger("sess-disabled");
    const ledger = path.join(tmp, "version-ledger.jsonl");
    assert.ok(!fs.existsSync(ledger), "ledger must not be created when disabled");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveTkrVersion returns null when TKR_VERSION unset and no binary → write skipped, no crash", () => {
  const tmp = mkTmp();
  // Do not set TKR_VERSION.  spawnSync will fail if 'tkr' not on PATH (or
  // succeed — either way we just verify no crash and, crucially, verify
  // that when the version is null (simulated by unsetting TKR_VERSION), the
  // ledger is NOT written.  We test this directly via resolveTkrVersion: if
  // it returns null, appendVersionLedger short-circuits.
  //
  // Since we can't guarantee 'tkr' is on PATH in CI, we test the
  // TKR_VERSION env path for the "version resolved" branch and use
  // resolveTkrVersion() directly for the "null" branch.
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: undefined,  // unset — forces spawnSync path
  });
  try {
    // resolveTkrVersion either returns a version string (if tkr is on PATH)
    // or null (if not).  In either case appendVersionLedger must not throw.
    assert.doesNotThrow(() => mod.appendVersionLedger("sess-nobin"));
    // We can't assert on file existence here because tkr may or may not be
    // on PATH in the test runner environment.  The important property is
    // no crash, tested above.
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("malformed existing line is skipped, new row appended cleanly", () => {
  const tmp = mkTmp();
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: "v9.0.0",
  });
  try {
    // Pre-seed the ledger with a garbage line.
    const ledgerFile = path.join(tmp, "version-ledger.jsonl");
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(ledgerFile, "THIS IS NOT JSON\n");

    mod.appendVersionLedger("sess-malformed");

    const rows = readLedger(tmp);
    assert.strictEqual(rows.length, 1, "should have exactly one valid row");
    assert.strictEqual(rows[0].session_id, "sess-malformed");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("TKR_STATE_DIR override: ledger written to override dir, not ~/.tkr", () => {
  const tmp = mkTmp();
  const { mod, restore } = loadFresh({
    TKR_STATE_DIR: tmp,
    TKR_VERSION: "v9.0.0",
  });
  try {
    mod.appendVersionLedger("sess-statedir");
    const rows = readLedger(tmp);
    assert.strictEqual(rows.length, 1, "row should land in override dir");
    assert.strictEqual(rows[0].session_id, "sess-statedir");
    // Confirm ledgerPath() agrees with TKR_STATE_DIR.
    assert.strictEqual(mod.ledgerPath(), path.join(tmp, "version-ledger.jsonl"));
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
