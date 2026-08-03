// Tests for hooks/lib/sessionstart/install-stamp.js
//
// Run: node --test hooks/lib/sessionstart/install-stamp.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODULE_PATH = require.resolve("./install-stamp");

// loadFresh returns a freshly-required install-stamp module (bypasses the
// require cache) with environment variables pre-set from envOverrides.
function loadFresh(envOverrides) {
  delete require.cache[MODULE_PATH];
  const prev = {};
  for (const [k, v] of Object.entries(envOverrides || {})) {
    prev[k] = process.env[k];
    process.env[k] = v;
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
    },
  };
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-stamp-"));
}

// --- tests ---

test("absent stamp is written with method=marketplace", () => {
  const tmp = mkTmp();
  const stampPath = path.join(tmp, "install.stamp");
  const { mod, restore } = loadFresh({ TKR_INSTALL_STAMP_PATH: stampPath });
  try {
    mod.ensureInstallStamp();
    assert.ok(fs.existsSync(stampPath), "stamp file should exist");
    const data = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    assert.strictEqual(data.method, "marketplace");
    assert.ok(data.installed_at, "installed_at should be present");
    assert.ok(data.installer_version !== undefined, "installer_version should be present");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("present stamp is not overwritten, content unchanged", () => {
  const tmp = mkTmp();
  const stampPath = path.join(tmp, "install.stamp");
  const original = JSON.stringify({
    installed_at: "2020-01-01T00:00:00.000Z",
    installer_version: "v0.1.0",
    method: "curl",
  }) + "\n";
  fs.writeFileSync(stampPath, original);

  const { mod, restore } = loadFresh({ TKR_INSTALL_STAMP_PATH: stampPath });
  try {
    mod.ensureInstallStamp();
    const after = fs.readFileSync(stampPath, "utf8");
    assert.strictEqual(after, original, "file content must not change");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unwritable path does not throw (best-effort)", () => {
  const badPath = path.join(os.tmpdir(), "does-not-exist-parent", "x", "install.stamp");
  const { mod, restore } = loadFresh({
    TKR_INSTALL_STAMP_PATH: badPath,
    // Force mkdirSync to fail by pointing at a file instead of a dir.
    // We achieve this by writing a file at the parent path first.
  });
  // Write a file where the directory would be, so mkdirSync fails.
  const parent = path.dirname(badPath);
  const grandParent = path.dirname(parent);
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-stamp-bad-"));
  const fileAsDir = path.join(tmpBase, "blocked");
  fs.writeFileSync(fileAsDir, "I am a file, not a dir");
  const { mod: mod2, restore: restore2 } = loadFresh({
    TKR_INSTALL_STAMP_PATH: path.join(fileAsDir, "nested", "install.stamp"),
  });
  try {
    // Must not throw — best-effort contract.
    assert.doesNotThrow(() => mod2.ensureInstallStamp());
  } finally {
    restore();
    restore2();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("TKR_INSTALL_STAMP_DISABLED=1 prevents write", () => {
  const tmp = mkTmp();
  const stampPath = path.join(tmp, "install.stamp");
  const { mod, restore } = loadFresh({
    TKR_INSTALL_STAMP_PATH: stampPath,
    TKR_INSTALL_STAMP_DISABLED: "1",
  });
  try {
    mod.ensureInstallStamp();
    assert.ok(!fs.existsSync(stampPath), "stamp file must not be created when disabled");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
