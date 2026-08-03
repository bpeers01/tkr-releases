#!/usr/bin/env node
// bin/tkr-launcher.js
//
// Bootstrap launcher for the tkr Go binary when the plugin is installed
// via a marketplace (no `tkr` on PATH). Two modes:
//
//   node tkr-launcher.js <args...>   exec mode (default) — resolve/
//                                     download the binary, then spawn it
//                                     with <args...>, stdio inherited,
//                                     forwarding its exit code. This is
//                                     what mcpServers.tkr in
//                                     .claude-plugin/plugin.json invokes
//                                     with arg "mcp".
//
//   node tkr-launcher.js --ensure    ensure mode — a SessionStart hook.
//                                     Follows the hook contract in
//                                     hooks/CLAUDE.md: stdin tolerated/
//                                     ignored, stdout is ONLY the JSON
//                                     hook response.
//
// Dependency-free: Node builtins only (fs, path, os, http, https, crypto,
// child_process). Ships standalone inside the plugin bundle as
// bin/ + .claude-plugin/ — does NOT depend on hooks/lib/*.
//
// Resolution order (never touches a PATH- or TKR_BIN-resolved binary):
//   1. TKR_BIN env, if executable
//   2. `tkr` / `tkr.exe` on PATH (string scan of PATH dirs, no shelling out)
//   3. managed install dir: CLAUDE_PLUGIN_DATA/bin, else
//      (TKR_STATE_DIR or ~/.tkr)/bin — the ONLY dir this launcher writes to.
//
// Version pin: read from ../.claude-plugin/plugin.json (relative to this
// file). Managed binary re-downloaded when its version differs from the
// plugin's pinned version. Download verified against checksums.sha256
// from the same release before install — never installs unverified.
//
// Kill switches TKR_HOOKS_DISABLED=1 / TKR_LAUNCHER_DISABLED=1 short-
// circuit --ensure mode before any stdin handler is registered.

"use strict";

function killSwitchActive() {
  return process.env.TKR_HOOKS_DISABLED === "1" || process.env.TKR_LAUNCHER_DISABLED === "1";
}

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const DOWNLOAD_TIMEOUT_MS = 60000;
const BACKOFF_MS = 60 * 60 * 1000; // 1h — ensure mode only, exec always retries.
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------
// Platform / asset mapping
// ---------------------------------------------------------------------

function isWindows(platform) {
  return (platform || process.platform) === "win32";
}

function binaryName(platform) {
  return isWindows(platform) ? "tkr.exe" : "tkr";
}

const ASSET_MAP = {
  "linux:x64": "tkr-linux-amd64",
  "darwin:x64": "tkr-darwin-amd64",
  "darwin:arm64": "tkr-darwin-arm64",
  "win32:x64": "tkr-windows-amd64.exe",
};

// assetName returns the release asset filename for a platform/arch pair,
// or null for an unsupported combo — never guesses a wrong asset.
function assetName(platform, arch) {
  return ASSET_MAP[`${platform}:${arch}`] || null;
}

// ---------------------------------------------------------------------
// checksums.sha256 parsing (sha256sum format: "<hex>  <filename>" or
// "<hex> *<filename>")
// ---------------------------------------------------------------------

function parseChecksums(text) {
  const out = {};
  if (!text) return out;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------
// State dir / managed install dir
// ---------------------------------------------------------------------

// stateDir mirrors hooks/lib/state-dir.js (kept as a local copy — this
// file has no dependency on hooks/).
function stateDir(env) {
  env = env || process.env;
  return env.TKR_STATE_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".tkr");
}

function managedDir(env) {
  env = env || process.env;
  const base = env.CLAUDE_PLUGIN_DATA ? env.CLAUDE_PLUGIN_DATA : stateDir(env);
  return path.join(base, "bin");
}

function managedBinaryPath(env, platform) {
  return path.join(managedDir(env), binaryName(platform));
}

// ---------------------------------------------------------------------
// PATH probe — string scan only, never shells out.
// ---------------------------------------------------------------------

function findOnPath(env, platform, existsFn) {
  const exists = existsFn || fs.existsSync;
  const PATH = (env && env.PATH) || (env && env.Path) || "";
  if (!PATH) return null;
  const dirs = PATH.split(path.delimiter).filter(Boolean);
  const names = isWindows(platform) ? ["tkr.exe", "tkr"] : ["tkr"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutablePath(p, platform, existsFn, accessFn) {
  const exists = existsFn || fs.existsSync;
  if (!p || !exists(p)) return false;
  if (isWindows(platform)) return true; // no X bit to probe on Windows.
  const access = accessFn || ((fp) => fs.accessSync(fp, fs.constants.X_OK));
  try {
    access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------

// resolveBinary picks which tkr binary to use. Returns
// { path, source } where source is "TKR_BIN" | "PATH" | "managed" | null.
// Only "managed" is ever eligible for replacement — TKR_BIN and PATH
// binaries are never touched or redownloaded.
function resolveBinary(env, platform, opts) {
  env = env || process.env;
  opts = opts || {};
  const existsFn = opts.existsFn || fs.existsSync;

  if (env.TKR_BIN && isExecutablePath(env.TKR_BIN, platform, existsFn, opts.accessFn)) {
    return { path: env.TKR_BIN, source: "TKR_BIN" };
  }

  const onPath = findOnPath(env, platform, existsFn);
  if (onPath) {
    return { path: onPath, source: "PATH" };
  }

  const managed = managedBinaryPath(env, platform);
  if (existsFn(managed)) {
    return { path: managed, source: "managed" };
  }

  return { path: null, source: null };
}

// ---------------------------------------------------------------------
// Plugin version pin
// ---------------------------------------------------------------------

function readPluginVersion(launcherDir) {
  try {
    const p = path.join(launcherDir, "..", ".claude-plugin", "plugin.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j.version || null;
  } catch {
    return null;
  }
}

// installedVersion best-effort probes `<bin> version`; tolerates failure
// (spec: "tolerate failure").
function installedVersion(binPath) {
  try {
    const res = spawnSync(binPath, ["version"], { encoding: "utf8", timeout: 5000 });
    if (res && res.status === 0 && res.stdout) {
      const m = res.stdout.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1] : res.stdout.trim();
    }
  } catch {
    // tolerate
  }
  return null;
}

// ---------------------------------------------------------------------
// Failure backoff (ensure mode only — exec mode always retries)
// ---------------------------------------------------------------------

function launcherStatePath(env) {
  return path.join(stateDir(env), "launcher-state.json");
}

function readLauncherState(env) {
  try {
    return JSON.parse(fs.readFileSync(launcherStatePath(env), "utf8"));
  } catch {
    return null;
  }
}

function writeLauncherState(env, state) {
  try {
    const p = launcherStatePath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, p);
  } catch {
    // best-effort
  }
}

function backoffActive(env, now) {
  const st = readLauncherState(env);
  if (!st || !st.last_attempt_at) return false;
  return now - st.last_attempt_at < BACKOFF_MS;
}

function recordFailure(env, reason, now) {
  writeLauncherState(env, { last_attempt_at: now, last_reason: reason });
}

function clearBackoff(env) {
  writeLauncherState(env, { last_attempt_at: 0, last_reason: null });
}

// ---------------------------------------------------------------------
// HTTP fetch with redirects (GitHub releases -> CDN)
// ---------------------------------------------------------------------

function releasesBaseUrl(env) {
  return (env && env.TKR_RELEASES_BASE_URL) || "https://github.com/bpeers01/tkr-releases/releases";
}

function moduleFor(url) {
  return url.startsWith("https:") ? https : http;
}

function httpGetFollow(url, redirectsLeft, cb) {
  if (redirectsLeft < 0) {
    cb(new Error("too many redirects"));
    return;
  }
  let req;
  try {
    const mod = moduleFor(url);
    req = mod.get(url, { headers: { "User-Agent": "tkr-launcher" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch (e) {
          cb(e);
          return;
        }
        httpGetFollow(next, redirectsLeft - 1, cb);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        cb(new Error(`http ${res.statusCode} for ${url}`));
        return;
      }
      cb(null, res);
    });
  } catch (e) {
    cb(e);
    return;
  }
  req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
  req.on("error", (err) => cb(err));
}

function fetchBuffer(url, cb) {
  httpGetFollow(url, MAX_REDIRECTS, (err, res) => {
    if (err) return cb(err);
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
    res.on("error", (e) => cb(e));
  });
}

function fetchToFile(url, destPath, cb) {
  httpGetFollow(url, MAX_REDIRECTS, (err, res) => {
    if (err) return cb(err);
    const out = fs.createWriteStream(destPath);
    let failed = false;
    const onErr = (e) => {
      if (failed) return;
      failed = true;
      cb(e);
    };
    res.on("error", onErr);
    out.on("error", onErr);
    out.on("finish", () => {
      if (failed) return;
      out.close(() => cb(null));
    });
    res.pipe(out);
  });
}

function fetchBufferP(url) {
  return new Promise((resolve, reject) => fetchBuffer(url, (e, b) => (e ? reject(e) : resolve(b))));
}

function fetchToFileP(url, dest) {
  return new Promise((resolve, reject) => fetchToFile(url, dest, (e) => (e ? reject(e) : resolve())));
}

// ---------------------------------------------------------------------
// Install (atomic rename; Windows locked-exe rename-first dance)
// ---------------------------------------------------------------------

function cleanupStaleOldFiles(dir, currentOldFile) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.old-\d+$/.test(f)) continue;
      const full = path.join(dir, f);
      if (full === currentOldFile) continue;
      try {
        fs.unlinkSync(full);
      } catch {
        // best-effort — may still be locked by a live process.
      }
    }
  } catch {
    // dir missing/unreadable — nothing to clean.
  }
}

// installBinary moves tmpPath into targetPath. On win32, a pre-existing
// target is renamed to `<target>.old-<pid>` FIRST (a live MCP server may
// hold the current binary locked; rename works where overwrite fails),
// then the new binary is moved in.
function installBinary(tmpPath, targetPath, platform) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  let oldFile = null;
  if (isWindows(platform) && fs.existsSync(targetPath)) {
    oldFile = `${targetPath}.old-${process.pid}`;
    try {
      fs.renameSync(targetPath, oldFile);
    } catch {
      oldFile = null; // best-effort; fall through and try the move anyway.
    }
  }
  fs.renameSync(tmpPath, targetPath);
  if (!isWindows(platform)) {
    try {
      fs.chmodSync(targetPath, 0o755);
    } catch {
      // best-effort
    }
  }
  cleanupStaleOldFiles(path.dirname(targetPath), oldFile);
}

// ---------------------------------------------------------------------
// Top-level ensure/download orchestration
// ---------------------------------------------------------------------

// ensureBinaryInstalled resolves (and, if needed, downloads + verifies +
// installs) the tkr binary. Returns a result object; never throws.
async function ensureBinaryInstalled(env, launcherDir, opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const mode = opts.mode || "exec"; // "exec" | "ensure"
  const now = opts.now || Date.now();

  const resolved = resolveBinary(env, platform, opts);

  // TKR_BIN / PATH binaries are never touched, never redownloaded.
  if (resolved.path && resolved.source !== "managed") {
    return { ok: true, action: "found", path: resolved.path, source: resolved.source };
  }

  const version = readPluginVersion(launcherDir);
  if (!version) {
    return { ok: false, action: "error", reason: "cannot-read-plugin-version" };
  }

  const asset = assetName(platform, arch);
  if (!asset) {
    return { ok: false, action: "error", reason: `unsupported-platform ${platform}/${arch}`, platform, arch };
  }

  const target = managedBinaryPath(env, platform);

  if (resolved.source === "managed") {
    const iv = installedVersion(resolved.path);
    if (iv === version) {
      return { ok: true, action: "found", path: resolved.path, source: "managed" };
    }
    // version mismatch (or unknown — probe failure is tolerated and
    // treated as "needs refresh") falls through to redownload below.
  }

  if (mode === "ensure" && backoffActive(env, now)) {
    return { ok: false, action: "backoff", reason: "recent-failure-within-1h" };
  }

  const baseUrl = releasesBaseUrl(env);
  const assetUrl = `${baseUrl}/download/v${version}/${asset}`;
  const checksumsUrl = `${baseUrl}/download/v${version}/checksums.sha256`;

  let tmpPath = null;
  try {
    const checksumsBuf = await fetchBufferP(checksumsUrl);
    const checksums = parseChecksums(checksumsBuf.toString("utf8"));
    const expected = checksums[asset];
    if (!expected) {
      throw new Error(`no checksum entry for ${asset}`);
    }

    fs.mkdirSync(managedDir(env), { recursive: true });
    tmpPath = path.join(managedDir(env), `.${asset}.download-${process.pid}`);
    await fetchToFileP(assetUrl, tmpPath);

    const actual = sha256File(tmpPath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error("checksum-mismatch");
    }

    installBinary(tmpPath, target, platform);
    tmpPath = null;
    clearBackoff(env);
    return { ok: true, action: "installed", path: target, version };
  } catch (err) {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
    }
    const reason = String((err && err.message) || err);
    recordFailure(env, reason, now);
    return { ok: false, action: "download-failed", reason };
  }
}

// ---------------------------------------------------------------------
// Failure-notice text (names the install-script fallback per platform)
// ---------------------------------------------------------------------

function fallbackNoticeText(platform) {
  return isWindows(platform)
    ? "install manually: irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex"
    : "install manually: curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh";
}

// ---------------------------------------------------------------------
// Ensure mode (SessionStart hook)
// ---------------------------------------------------------------------

function writeHookOutput(msg) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: msg },
    }),
  );
}

// readStdinTolerant drains + ignores stdin (or times out) then calls cb.
// Never throws; malformed/absent stdin is fine — ensure mode reads no
// fields from it.
function readStdinTolerant(cb) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cb();
  };
  const timer = setTimeout(finish, 2000);
  if (timer.unref) timer.unref();
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.resume();
  } catch {
    clearTimeout(timer);
    finish();
  }
}

function ensureModeMain() {
  if (killSwitchActive()) {
    process.stdout.write("{}");
    return;
  }
  readStdinTolerant(() => {
    ensureBinaryInstalled(process.env, __dirname, { mode: "ensure" })
      .then((result) => {
        if (result.ok && result.action === "installed") {
          writeHookOutput(`tkr: installed binary v${result.version} to ${result.path}`);
        } else if (!result.ok && (result.action === "download-failed" || result.action === "error")) {
          writeHookOutput(
            `tkr: could not install the tkr binary automatically (${result.reason}). ` +
              fallbackNoticeText(process.platform),
          );
        } else {
          process.stdout.write("{}");
        }
      })
      .catch(() => process.stdout.write("{}"));
  });
}

// ---------------------------------------------------------------------
// Exec mode (default — MCP server entrypoint)
// ---------------------------------------------------------------------

async function execMode(args) {
  const result = await ensureBinaryInstalled(process.env, __dirname, { mode: "exec" });
  if (!result.ok) {
    process.stderr.write(`tkr-launcher: could not resolve the tkr binary (${result.reason || result.action}).\n`);
    process.stderr.write(`tkr-launcher: ${fallbackNoticeText(process.platform)}\n`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(result.path, args, { stdio: "inherit" });
  child.on("error", (err) => {
    process.stderr.write(`tkr-launcher: failed to spawn ${result.path}: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : code === null ? 1 : code;
  });
}

// ---------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--ensure") {
    ensureModeMain();
  } else {
    execMode(argv).catch((err) => {
      process.stderr.write(`tkr-launcher: unexpected error: ${err && err.message}\n`);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  assetName,
  binaryName,
  isWindows,
  parseChecksums,
  sha256File,
  stateDir,
  managedDir,
  managedBinaryPath,
  findOnPath,
  isExecutablePath,
  resolveBinary,
  readPluginVersion,
  installedVersion,
  launcherStatePath,
  readLauncherState,
  writeLauncherState,
  backoffActive,
  recordFailure,
  clearBackoff,
  releasesBaseUrl,
  installBinary,
  cleanupStaleOldFiles,
  ensureBinaryInstalled,
  fallbackNoticeText,
  killSwitchActive,
};
