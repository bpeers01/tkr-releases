// Tests for hooks/lib/sessionstart/statusline-sweep.js — SessionStart
// cleanup of leftover per-session statusline payloads from crashed
// sessions where the Stop hook never ran.
//
// Run: node --test hooks/lib/sessionstart/statusline-sweep.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sweep-"));
}

function loadFresh() {
  delete require.cache[require.resolve("./statusline-sweep")];
  delete require.cache[require.resolve("../statusline-path")];
  return require("./statusline-sweep");
}

test("sweep deletes stale files matching project prefix", () => {
  const tmp = mkTmp();
  const prev = process.env.TMPDIR;
  const prevCwd = process.cwd();
  try {
    process.env.TMPDIR = tmp;
    // Use a dedicated project dir so the prefix is deterministic.
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-proj-"));
    process.chdir(projDir);

    const { sweepStaleStatuslineFiles, STALE_MS } = loadFresh();
    const { getTelemetryGlobPrefix } = require("../statusline-path");
    const prefix = getTelemetryGlobPrefix();

    // Stale file (>24h old) and fresh file (just now).
    const stale = path.join(tmp, prefix + "stale-sid.json");
    const fresh = path.join(tmp, prefix + "fresh-sid.json");
    fs.writeFileSync(stale, "{}");
    fs.writeFileSync(fresh, "{}");
    const oldTime = (Date.now() - STALE_MS - 60_000) / 1000;
    fs.utimesSync(stale, oldTime, oldTime);

    const removed = sweepStaleStatuslineFiles();
    assert.strictEqual(removed, 1, "exactly one file should be removed");
    assert.strictEqual(fs.existsSync(stale), false, "stale file removed");
    assert.strictEqual(fs.existsSync(fresh), true, "fresh file kept");
    process.chdir(prevCwd);
    fs.rmSync(projDir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweep ignores files not matching the prefix", () => {
  const tmp = mkTmp();
  const prev = process.env.TMPDIR;
  const prevCwd = process.cwd();
  try {
    process.env.TMPDIR = tmp;
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-proj-"));
    process.chdir(projDir);

    const { sweepStaleStatuslineFiles, STALE_MS } = loadFresh();

    // Stale file from another project — must not be touched.
    const otherProject = path.join(tmp, "claude-statusline--other-proj-sid.json");
    fs.writeFileSync(otherProject, "{}");
    const oldTime = (Date.now() - STALE_MS - 60_000) / 1000;
    fs.utimesSync(otherProject, oldTime, oldTime);

    // Unrelated tmp file with a stale mtime — must not be touched.
    const unrelated = path.join(tmp, "some-other-file.json");
    fs.writeFileSync(unrelated, "{}");
    fs.utimesSync(unrelated, oldTime, oldTime);

    const removed = sweepStaleStatuslineFiles();
    assert.strictEqual(removed, 0);
    assert.strictEqual(fs.existsSync(otherProject), true);
    assert.strictEqual(fs.existsSync(unrelated), true);
    process.chdir(prevCwd);
    fs.rmSync(projDir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweep deletes the legacy no-sid orphan unconditionally (2026-05-25)", () => {
  // Pre-per-session-scoping tkr versions wrote
  // claude-statusline-<slug>.json (no sid). Nothing writes there anymore,
  // but a stale copy on disk gets read by sid-less callers and serves
  // wildly-wrong pressure (observed: 70% when API said 9%). Sweep deletes
  // it regardless of mtime since the file is provably orphaned.
  const tmp = mkTmp();
  const prev = process.env.TMPDIR;
  const prevCwd = process.cwd();
  try {
    process.env.TMPDIR = tmp;
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-proj-"));
    process.chdir(projDir);

    const { sweepStaleStatuslineFiles } = loadFresh();
    const { slugifyCwd } = require("../statusline-path");
    // Slug from process.cwd(), not the pre-chdir projDir string: on
    // macOS os.tmpdir()/mkdtempSync return a /var/... path that chdir +
    // process.cwd() resolves to /private/var/... (symlink), and the
    // code under test slugs process.cwd() internally. Slugging projDir
    // here would silently target a filename sweepStaleStatuslineFiles
    // never constructs (#400).
    const legacy = path.join(
      tmp,
      "claude-statusline-" + slugifyCwd(process.cwd()) + ".json"
    );
    fs.writeFileSync(legacy, '{"seven_day_pct":70}');
    // Give it a FRESH mtime — the mtime-based STALE_MS gate must not
    // apply; the orphan delete is unconditional.
    fs.utimesSync(legacy, Date.now() / 1000, Date.now() / 1000);

    const removed = sweepStaleStatuslineFiles();
    assert.strictEqual(removed, 1, "legacy orphan should be deleted");
    assert.strictEqual(fs.existsSync(legacy), false);
    process.chdir(prevCwd);
    fs.rmSync(projDir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweep on empty / missing tmpdir is a no-op", () => {
  const tmp = mkTmp();
  const prev = process.env.TMPDIR;
  try {
    process.env.TMPDIR = tmp;
    const { sweepStaleStatuslineFiles } = loadFresh();
    assert.strictEqual(sweepStaleStatuslineFiles(), 0);

    // Now point at a non-existent dir — must still not throw.
    process.env.TMPDIR = path.join(tmp, "does-not-exist");
    const { sweepStaleStatuslineFiles: sweep2 } = loadFresh();
    assert.strictEqual(sweep2(), 0);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
