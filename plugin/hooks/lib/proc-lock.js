// Cross-platform single-instance lock for tkr hook + binary spawns.
//
// Lock files at ~/.tkr/locks/<name>.lock (honors TKR_STATE_DIR).
// Atomic create-or-fail via fs.openSync(..., 'wx') — works on Windows,
// macOS, Linux without extra deps.
//
// Format (single-line JSON, atomic <4KB write):
//   {"v":1,"pid":1234,"ts":1715381234567,"cmd":"search --refresh","host":"DESKTOP"}
//
// Stale-detection rules (either triggers reclaim):
//   1. PID dead (process.kill(pid, 0) throws ESRCH/EPERM).
//   2. Age > maxAgeMs.
//
// Lock format MUST stay byte-compatible with internal/proclock/proclock.go.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { stateDir } = require("./state-dir");

const SCHEMA_VERSION = 1;

const TKR_STATE_DIR = stateDir();

const LOCK_DIR = path.join(TKR_STATE_DIR, "locks");

function lockPath(name) {
  return path.join(LOCK_DIR, `${name}.lock`);
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means proc exists but we lack signal rights — still alive.
    return e && e.code === "EPERM";
  }
}

function isStale(holder, maxAgeMs) {
  if (!holder) return true;
  if (typeof holder.pid !== "number" || typeof holder.ts !== "number") return true;
  // M-20: cross-host locks are always stale. State dir may be on shared
  // storage (Dropbox, NFS, OneDrive) — a lock from another host's PID
  // namespace must not block this host. host field is optional in v1
  // schema; missing host falls through to age/pid checks for back-compat.
  if (typeof holder.host === "string" && holder.host && holder.host !== os.hostname()) {
    return true;
  }
  // M-20: future-ts skew. Clock drift, paused VMs, or a malicious write
  // can leave ts > now, making (now - ts) negative and the lock immortal.
  // Treat anything more than 5min in the future as stale.
  if (holder.ts > Date.now() + 5 * 60_000) return true;
  if (Date.now() - holder.ts > maxAgeMs) return true;
  if (!pidAlive(holder.pid)) return true;
  return false;
}

function readHolder(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const h = JSON.parse(raw);
    if (typeof h !== "object" || h === null) return null;
    return h;
  } catch {
    return null;
  }
}

function writeHolder(filePath, cmd) {
  const holder = {
    v: SCHEMA_VERSION,
    pid: process.pid,
    ts: Date.now(),
    cmd: String(cmd || ""),
    host: os.hostname(),
  };
  // openSync('wx') = O_CREAT | O_EXCL | O_WRONLY — atomic create-or-fail.
  const fd = fs.openSync(filePath, "wx");
  try {
    fs.writeSync(fd, JSON.stringify(holder));
  } finally {
    fs.closeSync(fd);
  }
  return holder;
}

// tryAcquire returns one of:
//   { acquired: true,  holder, release: () => void }
//   { acquired: false, holder }    // live lock-holder
//
// opts.maxAgeMs (default 60_000): treat lock as stale beyond this age.
// opts.cmd: optional descriptor stored in the lock file.
function tryAcquire(name, opts) {
  const maxAgeMs = (opts && opts.maxAgeMs) || 60_000;
  const cmd = (opts && opts.cmd) || name;
  const file = lockPath(name);

  fs.mkdirSync(LOCK_DIR, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const holder = writeHolder(file, cmd);
      return {
        acquired: true,
        holder,
        release: makeRelease(file),
      };
    } catch (e) {
      if (e.code !== "EEXIST") {
        // Unexpected fs error — treat as not-acquired but don't crash caller.
        return { acquired: false, holder: null };
      }
      // EEXIST: existing lock — check staleness.
      const existing = readHolder(file);
      if (existing && !isStale(existing, maxAgeMs)) {
        return { acquired: false, holder: existing };
      }
      // Stale: unlink + retry once.
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return { acquired: false, holder: null };
}

function makeRelease(file) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try { fs.unlinkSync(file); } catch {}
  };
}

// withLock runs fn() iff the lock is acquired. fn may be sync or async.
// Lock is released after fn settles. If lock is held, returns
// { skipped: true, holder } without invoking fn.
async function withLock(name, opts, fn) {
  const r = tryAcquire(name, opts);
  if (!r.acquired) return { skipped: true, holder: r.holder };
  try {
    const value = await fn();
    return { skipped: false, value };
  } finally {
    r.release();
  }
}

module.exports = {
  SCHEMA_VERSION,
  tryAcquire,
  isStale,
  withLock,
  lockPath,
  LOCK_DIR,
};
