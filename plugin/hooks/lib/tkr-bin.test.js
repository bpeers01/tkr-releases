#!/usr/bin/env node
// Tests for hooks/lib/tkr-bin.js — binary resolution + the JS entry-point
// rule (#143 finding 1).
//
// The load-bearing property is PATH INDEPENDENCE. The old veto shim put an
// extensionless `#!/bin/sh` file named `tkr` first on PATH, which Node
// cannot resolve on Windows without a shell — so on Windows the veto tests
// could not execute their own shim, and the ones asserting "no deny
// happened" passed vacuously. Resolving through TKR_BIN to an absolute
// path, and launching a .js target with the current node, removes the
// platform-specific step entirely.
//
// This suite cannot run on Windows from here, so it proves the property
// rather than the platform: with PATH emptied, the resolved shim must
// still run. PATH lookup is the only part of the old mechanism that was
// platform-specific, so a mechanism that never consults PATH cannot fail
// the way the old one did.
//
// Run: node --test hooks/lib/tkr-bin.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { resolveTkrBin, tkrSpawnArgv } = require("./tkr-bin");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-bin-"));
}

test("TKR_BIN wins over every other candidate", () => {
  const dir = tmpdir();
  const bin = path.join(dir, "my-tkr");
  fs.writeFileSync(bin, "");
  try {
    assert.strictEqual(resolveTkrBin({ TKR_BIN: bin, HOME: dir }), bin);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a TKR_BIN naming a nonexistent file falls through to PATH resolution", () => {
  const dir = tmpdir();
  try {
    // Not an error: the override is a preference, and PATH resolution is
    // still a legitimate way to find the binary. Failing hard here would
    // turn a stale env var into a broken hook. With no PATH entry supplied
    // at all, resolution finds nothing and returns null — never the bare
    // string "tkr" (INV-119: a bare name is never handed to spawn).
    assert.strictEqual(
      resolveTkrBin({ TKR_BIN: path.join(dir, "nope"), HOME: dir }),
      null,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("null is the fallback when nothing is installed and PATH has no match", () => {
  const dir = tmpdir();
  try {
    assert.strictEqual(resolveTkrBin({ HOME: dir }), null);
    assert.strictEqual(resolveTkrBin({ HOME: dir, PATH: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// INV-119: the whole point of the fix. resolveTkrBin must NEVER hand back
// the bare string "tkr" — every path that used to fall through to it must
// now either find an absolute PATH match or return null.
test("resolveTkrBin never returns the bare string 'tkr'", () => {
  const dir = tmpdir();
  try {
    assert.notStrictEqual(resolveTkrBin({ HOME: dir }), "tkr");
    assert.notStrictEqual(
      resolveTkrBin({ TKR_BIN: path.join(dir, "nope"), HOME: dir }),
      "tkr",
    );
    assert.notStrictEqual(resolveTkrBin({ HOME: dir, PATH: "" }), "tkr");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PATH resolution finds an installed binary and honors PATHEXT on win32", () => {
  const dir = tmpdir();
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exeName = process.platform === "win32" ? "tkr.exe" : "tkr";
  const exe = path.join(binDir, exeName);
  fs.writeFileSync(exe, "");
  try {
    const env = { HOME: path.join(dir, "nohome"), PATH: binDir };
    const resolved = resolveTkrBin(env);
    // whichFromPath builds the candidate from PATHEXT's own casing
    // (".EXE"), which Windows' case-insensitive filesystem happily matches
    // against the "tkr.exe" file this test wrote — same physical file, and
    // that is all that matters here. Compare case-insensitively on win32,
    // exactly like the module's own samePhysicalPath does.
    if (process.platform === "win32") {
      assert.strictEqual(resolved.toLowerCase(), exe.toLowerCase());
    } else {
      assert.strictEqual(resolved, exe);
    }
    // A bare extensionless file does NOT satisfy PATHEXT on win32 — Windows
    // resolution honors it, so an install must ship tkr.exe (or .cmd/.bat).
    if (process.platform === "win32") {
      const bareOnly = path.join(dir, "bareonly");
      fs.mkdirSync(bareOnly, { recursive: true });
      fs.writeFileSync(path.join(bareOnly, "tkr"), "");
      assert.strictEqual(
        resolveTkrBin({ HOME: path.join(dir, "nohome2"), PATH: bareOnly }),
        null,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The core INV-119 regression: a decoy tkr.exe sitting in a directory that
// is NOT on PATH (e.g. a repo root a hook happens to be invoked from as
// cwd) must never be selected, even though Windows' own CreateProcess would
// have found it via the implicit "search cwd before PATH" step that this
// module's whole design exists to avoid triggering.
test("a decoy tkr binary outside PATH (simulating repo-root cwd) is never chosen", () => {
  const dir = tmpdir();
  const decoyDir = path.join(dir, "repo-root-cwd");
  fs.mkdirSync(decoyDir, { recursive: true });
  const decoyName = process.platform === "win32" ? "tkr.exe" : "tkr";
  fs.writeFileSync(path.join(decoyDir, decoyName), "");
  try {
    // No TKR_BIN, no install location resolves inside decoyDir, and PATH
    // does not list decoyDir — only the fact that a process happened to be
    // launched with cwd=decoyDir would let the OS find the decoy, and this
    // module never gives the OS a bare name to search with.
    const env = { HOME: path.join(dir, "nohome"), PATH: "" };
    const bin = resolveTkrBin(env);
    assert.strictEqual(bin, null, "the cwd-local decoy must not be resolved");

    // Also assert at the tkrSpawnArgv boundary: the decoy must not become
    // cmd even indirectly.
    const { cmd } = tkrSpawnArgv(["resident", "status", "--json"], env);
    assert.notStrictEqual(cmd, path.join(decoyDir, decoyName));
    assert.strictEqual(cmd, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-JS binary is spawned directly, args unchanged", () => {
  const dir = tmpdir();
  const bin = path.join(dir, "tkr-real");
  fs.writeFileSync(bin, "");
  try {
    const { cmd, argv } = tkrSpawnArgv(["route", "veto-check"], { TKR_BIN: bin, HOME: dir });
    assert.strictEqual(cmd, bin);
    assert.deepStrictEqual(argv, ["route", "veto-check"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const ext of [".js", ".cjs", ".mjs", ".JS"]) {
  test(`a ${ext} entry point is launched with the current node`, () => {
    const dir = tmpdir();
    const bin = path.join(dir, "launcher" + ext);
    fs.writeFileSync(bin, "");
    try {
      const { cmd, argv } = tkrSpawnArgv(["rewrite"], { TKR_BIN: bin, HOME: dir });
      assert.strictEqual(cmd, process.execPath);
      assert.deepStrictEqual(argv, [bin, "rewrite"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("PATH independence: a resolved JS shim runs with PATH emptied", () => {
  // The whole point. The old mechanism needed the OS to find an
  // extensionless file on PATH — the step that does not work on Windows.
  // Nothing here consults PATH, so emptying it changes nothing.
  const dir = tmpdir();
  const bin = path.join(dir, "shim.js");
  fs.writeFileSync(bin, `process.stdout.write(JSON.stringify({verdict:"allow"}));\n`);
  try {
    const { cmd, argv } = tkrSpawnArgv(["route", "veto-check"], { TKR_BIN: bin });
    const res = spawnSync(cmd, argv, {
      encoding: "utf8",
      // No shell, exactly as vetoCheck spawns. PATH is a directory that
      // contains nothing at all.
      env: { ...process.env, PATH: tmpdir() },
      windowsHide: true,
    });
    assert.ifError(res.error);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepStrictEqual(JSON.parse(res.stdout), { verdict: "allow" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a JS shim spawned WITHOUT the argv mapping fails — the mapping is required, not cosmetic", () => {
  // Guards the caller contract in the module header. Handing the resolved
  // .js path straight to spawnSync means "exec a text file", which fails
  // as ENOEXEC/EACCES — and on a fail-open path like the veto that is
  // indistinguishable from a clean allow, so the failure would be silent.
  const dir = tmpdir();
  const bin = path.join(dir, "shim.js");
  fs.writeFileSync(bin, `process.stdout.write("{}");\n`);
  try {
    const res = spawnSync(bin, ["route", "veto-check"], { encoding: "utf8", windowsHide: true });
    assert.ok(
      res.error || res.status !== 0,
      "executing a .js file directly must not succeed",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── HOOK-004 producer-wiring guard ──────────────────────────────────────
//
// HOOK-004 (#230): 13+ hook spawn sites bypassed this resolver by calling
// spawn/spawnSync/spawnBounded/execFileSync directly with the bare literal
// "tkr", which silently no-ops (or worse, silently succeeds against the
// wrong binary) on any install where tkr is not on $PATH. All known sites
// were migrated to tkrSpawnArgv() in the same change that added this
// guard. This test is what keeps a new one from reappearing — same shape
// as the HOOK-002 unwired-producer guard (hooks/wiring-guard.test.js):
// a static source scan with an explicit, itemized exception list rather
// than a runtime check nothing exercises by default.

// Files intentionally exempt, each naming why. Nothing belongs here
// without a name attached — an unexplained entry defeats the guard.
const BARE_TKR_SPAWN_ALLOWLIST = new Set([
  // Dev-only latency benchmark, not a shipped hook handler. Already does
  // its own `process.env.TKR_BIN || "tkr"` fallback inline rather than
  // importing the resolver, which is a narrower (PATH-only) version of
  // the same override but is run manually by a developer who can see
  // what it resolved to — not a silent hot-path no-op.
  "bench/e2e-latency-bench.js",
]);

test("HOOK-004: no hook file spawns a bare literal \"tkr\" outside tkr-bin.js", () => {
  const hooksDir = path.join(__dirname, "..");
  const spawnCallRe = /\b(?:spawn\w*|execFileSync|execSync)\(\s*["']tkr["']/;

  function walk(dir) {
    let out = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) {
        out = out.concat(walk(full));
      } else if (name.name.endsWith(".js") && !name.name.endsWith(".test.js")) {
        out.push(full);
      }
    }
    return out;
  }

  const offenders = [];
  for (const file of walk(hooksDir)) {
    const rel = path.relative(hooksDir, file).split(path.sep).join("/");
    if (rel === "lib/tkr-bin.js") continue; // the resolver itself
    if (BARE_TKR_SPAWN_ALLOWLIST.has(rel)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (spawnCallRe.test(src)) offenders.push(rel);
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `bare "tkr" spawn sites bypassing lib/tkr-bin.js (route through tkrSpawnArgv(), ` +
      `or add to BARE_TKR_SPAWN_ALLOWLIST with a reason): ${offenders.join(", ")}`,
  );
});
