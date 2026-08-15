// Tests for hooks/lib/sessionstart/skill-manifest-refresh.js
//
// Run: node --test hooks/lib/sessionstart/skill-manifest-refresh.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  isManifestStale,
  spawnSkillManifestRefresh,
  refreshSkillManifestIfStale,
} = require("./skill-manifest-refresh");
const { MANIFEST_FILE, MANIFEST_SCHEMA } = require("../skill-bundle");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-manifest-refresh-"));
}

function mkFakeBinary(dir, size) {
  const p = path.join(dir, "fake-claude-binary");
  fs.writeFileSync(p, Buffer.alloc(size || 16));
  return p;
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));
}

// --- isManifestStale ---

test("isManifestStale: no manifest file → stale", () => {
  const tmp = mkTmp();
  try {
    assert.strictEqual(isManifestStale({ dir: tmp }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: malformed JSON → stale", () => {
  const tmp = mkTmp();
  try {
    fs.writeFileSync(path.join(tmp, MANIFEST_FILE), "NOT JSON");
    assert.strictEqual(isManifestStale({ dir: tmp }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: wrong schema version → stale", () => {
  const tmp = mkTmp();
  try {
    const bin = mkFakeBinary(tmp);
    const st = fs.statSync(bin);
    writeManifest(tmp, {
      schema: MANIFEST_SCHEMA + 1,
      binaryPath: bin,
      binarySize: st.size,
      binaryMtimeMs: Math.floor(st.mtimeMs),
      complete: true,
      skills: [],
    });
    assert.strictEqual(isManifestStale({ dir: tmp }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: missing binaryPath field → stale", () => {
  const tmp = mkTmp();
  try {
    writeManifest(tmp, { schema: MANIFEST_SCHEMA, complete: true, skills: [] });
    assert.strictEqual(isManifestStale({ dir: tmp }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: binaryPath no longer stats (removed/renamed) → stale", () => {
  const tmp = mkTmp();
  try {
    writeManifest(tmp, {
      schema: MANIFEST_SCHEMA,
      binaryPath: path.join(tmp, "does-not-exist"),
      binarySize: 16,
      binaryMtimeMs: 0,
      complete: true,
      skills: [],
    });
    assert.strictEqual(isManifestStale({ dir: tmp }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: size mismatch → stale", () => {
  const tmp = mkTmp();
  try {
    const bin = mkFakeBinary(tmp, 16);
    const st = fs.statSync(bin);
    writeManifest(tmp, {
      schema: MANIFEST_SCHEMA,
      binaryPath: bin,
      binarySize: st.size + 1,
      binaryMtimeMs: Math.floor(st.mtimeMs),
      complete: true,
      skills: [],
    });
    assert.strictEqual(isManifestStale({ dir: tmp }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: mtime mismatch → stale", () => {
  const tmp = mkTmp();
  try {
    const bin = mkFakeBinary(tmp, 16);
    const st = fs.statSync(bin);
    writeManifest(tmp, {
      schema: MANIFEST_SCHEMA,
      binaryPath: bin,
      binarySize: st.size,
      binaryMtimeMs: Math.floor(st.mtimeMs) + 1000,
      complete: true,
      skills: [],
    });
    assert.strictEqual(isManifestStale({ dir: tmp }), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: size + mtime match, schema matches → fresh (not stale)", () => {
  const tmp = mkTmp();
  try {
    const bin = mkFakeBinary(tmp, 16);
    const st = fs.statSync(bin);
    writeManifest(tmp, {
      schema: MANIFEST_SCHEMA,
      binaryPath: bin,
      binarySize: st.size,
      binaryMtimeMs: Math.floor(st.mtimeMs),
      complete: true,
      skills: [],
    });
    assert.strictEqual(isManifestStale({ dir: tmp }), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isManifestStale: complete:false but binary unchanged → NOT stale (no gain from re-scraping)", () => {
  const tmp = mkTmp();
  try {
    const bin = mkFakeBinary(tmp, 16);
    const st = fs.statSync(bin);
    writeManifest(tmp, {
      schema: MANIFEST_SCHEMA,
      binaryPath: bin,
      binarySize: st.size,
      binaryMtimeMs: Math.floor(st.mtimeMs),
      complete: false,
      skills: [],
    });
    assert.strictEqual(isManifestStale({ dir: tmp }), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- spawnSkillManifestRefresh ---

test("spawnSkillManifestRefresh: TKR_HOOKS_DISABLED=1 → no spawn, no throw", () => {
  const prev = process.env.TKR_HOOKS_DISABLED;
  process.env.TKR_HOOKS_DISABLED = "1";
  try {
    assert.doesNotThrow(() => spawnSkillManifestRefresh());
  } finally {
    if (prev === undefined) delete process.env.TKR_HOOKS_DISABLED;
    else process.env.TKR_HOOKS_DISABLED = prev;
  }
});

test("spawnSkillManifestRefresh: enabled → spawns without throwing", () => {
  const tmp = mkTmp();
  const prev = process.env.TKR_HOOKS_DISABLED;
  delete process.env.TKR_HOOKS_DISABLED;
  try {
    // TKR_CC_BINARY points at a nonexistent file so the spawned scraper
    // fails fast (stat throws inside scrapeManifest) instead of running
    // a real ~22s scrape against the actual installed binary and
    // clobbering the real ~/.tkr/skill-manifest.json as a test side
    // effect. TKR_STATE_DIR is scoped to tmp for the same reason.
    const env = {
      ...process.env,
      TKR_HOOKS_DISABLED: undefined,
      TKR_CC_BINARY: path.join(tmp, "nonexistent-binary"),
      TKR_STATE_DIR: tmp,
    };
    delete env.TKR_HOOKS_DISABLED;
    assert.doesNotThrow(() => spawnSkillManifestRefresh({ env }));
  } finally {
    if (prev !== undefined) process.env.TKR_HOOKS_DISABLED = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- refreshSkillManifestIfStale (integration of the two above) ---

test("refreshSkillManifestIfStale: stale + disabled → no-op, no throw", () => {
  const tmp = mkTmp();
  const prev = process.env.TKR_HOOKS_DISABLED;
  process.env.TKR_HOOKS_DISABLED = "1";
  try {
    // No manifest present → stale; disabled kill switch must still
    // suppress the spawn without throwing.
    assert.doesNotThrow(() => refreshSkillManifestIfStale({ dir: tmp }));
  } finally {
    if (prev === undefined) delete process.env.TKR_HOOKS_DISABLED;
    else process.env.TKR_HOOKS_DISABLED = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refreshSkillManifestIfStale: fresh manifest → does not throw (spawn skipped)", () => {
  const tmp = mkTmp();
  try {
    const bin = mkFakeBinary(tmp, 16);
    const st = fs.statSync(bin);
    writeManifest(tmp, {
      schema: MANIFEST_SCHEMA,
      binaryPath: bin,
      binarySize: st.size,
      binaryMtimeMs: Math.floor(st.mtimeMs),
      complete: true,
      skills: [],
    });
    assert.doesNotThrow(() => refreshSkillManifestIfStale({ dir: tmp }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
