// hooks/lib/resident-client.js
//
// Client for the local resident TKR runtime (#209).
//
// Why this exists: `PreToolUse(Bash)` rewrite and `PostToolUse` filter-stdin
// spawn a full tkr process per Bash call, and ~90% of that wall clock is
// process start doing work that is identical every time. This talks to a
// long-lived process that has already paid it.
//
// The contract that makes this safe to ship:
//
//   EVERY failure returns null, and null means "spawn tkr exactly as before".
//   Missing runtime, stale runtime, wrong protocol, upgraded binary, bad
//   token, timeout, malformed frame, unreadable endpoint file — all null.
//   A dead or slow runtime must never be able to block Claude.
//
// Kill switches: TKR_HOOKS_DISABLED=1 (checked by the callers at module top,
// before this file loads) and TKR_RESIDENT_DISABLED=1 (checked here).
//
// Wire format and lifecycle live in internal/resident/resident.go. PROTO
// below is the same constant as resident.Proto — change both together, or
// every read here silently falls back to spawning.

"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { stateDir } = require("./state-dir");
const { tkrSpawnArgv, resolveTkrExe, samePhysicalPath } = require("./tkr-bin");

const PROTO = 1;
const ENDPOINT_SCHEMA = 1;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_HEADER = 64 * 1024;

// Client deadline for one request. Deliberately far tighter than the server's
// own per-op budget: the point is to fall back to a spawn early, not to wait
// for a wedged runtime. A blown deadline costs this much ONCE, then the
// cooldown below suppresses the resident path entirely for a minute.
const DEFAULT_TIMEOUT_MS = 750;
// Suppression window after a timeout. Without it, a hung runtime costs one
// deadline per Bash call for as long as it stays hung.
const COOLDOWN_MS = 60_000;
// Minimum gap between lazy-start attempts. Without it, a runtime that crashes
// on startup becomes one spawn per Bash call — strictly worse than today.
const START_COOLDOWN_MS = 5_000;

function runDir() {
  return path.join(stateDir(), "run");
}

// keyFor mirrors resident.Key: sha256 of the project root, first 16 hex chars.
// One runtime per project root, because the state it reuses (config, filter
// registry) is root-scoped.
function keyFor(projectRoot) {
  return crypto.createHash("sha256").update(String(projectRoot)).digest("hex").slice(0, 16);
}

function disabled(env = process.env) {
  return env.TKR_RESIDENT_DISABLED === "1";
}

// enabled: the prototype ships OFF. #209 is an experiment, and an experiment
// that turns itself on for everyone is a release.
function enabled(env = process.env) {
  return env.TKR_RESIDENT_ENABLED === "1" && !disabled(env);
}

function timeoutMs(env = process.env) {
  const n = Number.parseInt(env.TKR_RESIDENT_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// projectRootFor is a port of config.FindProjectRoot plus cmd_resident.go's
// cwd fallback, and must stay one: the client derives the runtime key from
// this, `tkr resident status` derives it from the Go original, and a
// disagreement means the two look for each other in different files. That
// failure is silent — the feature just never engages — which is why the parity
// is asserted in resident-client.test.js rather than trusted.
//
// The rule, exactly: walk up from startDir looking for a `.tkr` DIRECTORY;
// stop before examining $HOME itself, so the user's global ~/.tkr is never
// mistaken for a project root; on no match, fall back to startDir.
//
// The Go side compares against home by file identity (os.SameFile) rather than
// string equality, because on Windows the walk can arrive in 8.3 short form
// (INV-064). Node has no SameFile; fs.realpathSync is the closest equivalent
// and is applied to both sides for the same reason.
function projectRootFor(startDir) {
  const start = path.resolve(startDir || process.cwd());
  let home = "";
  try {
    home = fs.realpathSync(require("os").homedir());
  } catch {
    home = "";
  }

  let dir = start;
  for (let i = 0; i < 256; i++) {
    if (home) {
      let real = dir;
      try {
        real = fs.realpathSync(dir);
      } catch {
        // unreadable — fall back to the literal path for the compare
      }
      if (real === home) return start;
    }
    try {
      if (fs.statSync(path.join(dir, ".tkr")).isDirectory()) return dir;
    } catch {
      // no .tkr here — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
  return start;
}

function readCooldown(key) {
  try {
    const raw = fs.readFileSync(path.join(runDir(), `${key}.cooldown`), "utf8");
    const until = Number.parseInt(raw, 10);
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

function writeCooldown(key, untilMs) {
  try {
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runDir(), `${key}.cooldown`), String(untilMs), { mode: 0o600 });
  } catch {
    // best-effort: a cooldown we cannot write costs latency, not correctness
  }
}

// readEndpoint loads and fully validates the discovery file. Returns null for
// anything less than a runtime we are certain we should talk to.
//
// The binary-stamp check is the upgrade guard and the reason this is not just
// a JSON parse: after `tkr` is replaced on disk, the running instance still
// serves the OLD code. Refusing it here — one stat of a file we already know
// the path of — is what makes upgrades safe. The server checks the same thing
// on its own timer, but only the client's check is on the path that would
// otherwise consume stale behavior.
function readEndpoint(key, env = process.env) {
  let ep;
  try {
    ep = JSON.parse(fs.readFileSync(path.join(runDir(), `${key}.json`), "utf8"));
  } catch {
    return null;
  }
  if (!ep || typeof ep !== "object") return null;
  if (ep.schema !== ENDPOINT_SCHEMA || ep.proto !== PROTO) return null;
  if (!ep.address || !ep.token || !(ep.pid > 0)) return null;
  if (ep.network !== "unix" && ep.network !== "tcp") return null;

  // The runtime must be running the same binary this hook would otherwise
  // spawn. Different TKR_BIN → different tkr → do not let one serve the other.
  //
  // Both sides are PHYSICAL paths: resolveTkrExe searches PATH for the bare
  // fallback and resolves symlinks, and the server records
  // filepath.EvalSymlinks(os.Executable()). Comparing the command string
  // instead broke every PATH-only install — path.resolve("tkr") is
  // cwd-relative, so it matched nothing and the client rejected its own
  // runtime forever while restarting one every 5s.
  const mine = resolveTkrExe(env);
  if (!mine) return null;
  const theirs = (() => {
    try {
      return fs.realpathSync(ep.exe);
    } catch {
      return null;
    }
  })();
  if (!samePhysicalPath(mine, theirs)) return null;

  // bigint:true is load-bearing, not style. Node's ordinary stat reports
  // mtimeMs as a FLOAT carrying sub-millisecond precision
  // (1786315956667.2983), while Go's ModTime().UnixMilli() truncates
  // (1786315956667). A plain === between the two never matches, so every
  // endpoint would be rejected as "upgraded" and the resident path would
  // silently never engage — the feature failing closed and looking like it
  // simply did not help. The bigint form is exact-truncated on both sides.
  let st;
  try {
    st = fs.statSync(theirs, { bigint: true });
  } catch {
    return null;
  }
  if (st.size !== BigInt(ep.exe_size) || st.mtimeMs !== BigInt(ep.exe_mtime_ms)) return null;

  return ep;
}

// maybeStart launches a runtime, detached and unref'd, at most once per
// START_COOLDOWN_MS. The current request does NOT wait for it — it falls back
// to a spawn and the next one finds a warm runtime.
//
// Rate limiting is the whole point: a runtime that fails to start would
// otherwise turn into an extra spawn on every Bash call, i.e. this feature
// making things worse. The marker is an empty file whose mtime is the state.
function maybeStart(projectRoot, key, env = process.env) {
  const marker = path.join(runDir(), `${key}.start`);
  try {
    const st = fs.statSync(marker);
    if (Date.now() - st.mtimeMs < START_COOLDOWN_MS) return false;
  } catch {
    // no marker — first attempt
  }
  try {
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, "", { mode: 0o600 });
  } catch {
    // If we cannot record the attempt we cannot rate-limit it, so do not
    // attempt at all. An unbounded spawn loop is worse than no runtime.
    return false;
  }
  try {
    const { cmd, argv } = tkrSpawnArgv(["resident", "serve", "--project-root", projectRoot], env);
    const child = spawn(cmd, argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: projectRoot,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// request sends one framed request and resolves to {exit, body} or null.
//
// Framing: one line of JSON header, then exactly header.n body bytes. The body
// stays opaque — filter-stdin payloads reach megabytes and JSON-escaping them
// twice per request would give back the latency this whole exercise is trying
// to win.
function request(ep, header, body, budgetMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // already gone
      }
      resolve(value);
    };

    const timer = setTimeout(() => done("timeout"), budgetMs);

    const target = ep.network === "unix" ? { path: ep.address } : tcpTarget(ep.address);
    if (!target) {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    const socket = net.connect(target);
    socket.on("error", () => done(null));

    let head = null;
    let need = 0;
    const chunks = [];
    let buffered = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      if (head === null) {
        const nl = buffered.indexOf(0x0a);
        if (nl < 0) {
          if (buffered.length > MAX_HEADER) done(null);
          return;
        }
        try {
          head = JSON.parse(buffered.subarray(0, nl).toString("utf8"));
        } catch {
          done(null);
          return;
        }
        if (!head || head.proto !== PROTO) {
          done(null);
          return;
        }
        need = Number.isFinite(head.n) ? head.n : 0;
        if (need < 0 || need > MAX_BODY) {
          done(null);
          return;
        }
        buffered = buffered.subarray(nl + 1);
      }
      if (buffered.length) chunks.push(buffered);
      buffered = Buffer.alloc(0);
      const have = chunks.reduce((n, c) => n + c.length, 0);
      if (have >= need) {
        done({ exit: head.exit, body: Buffer.concat(chunks).subarray(0, need), err: head.err });
      }
    });

    socket.on("end", () => {
      if (head === null) {
        done(null);
        return;
      }
      const have = chunks.reduce((n, c) => n + c.length, 0);
      if (have >= need) {
        done({ exit: head.exit, body: Buffer.concat(chunks).subarray(0, need), err: head.err });
      } else {
        // Truncated response — the runtime died mid-write. Fall back.
        done(null);
      }
    });

    socket.on("connect", () => {
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
      const line = JSON.stringify({ ...header, proto: PROTO, token: ep.token, n: payload.length });
      socket.write(line + "\n");
      if (payload.length) socket.write(payload);
    });
  });
}

function tcpTarget(address) {
  const idx = String(address).lastIndexOf(":");
  if (idx < 0) return null;
  const port = Number.parseInt(address.slice(idx + 1), 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host: "127.0.0.1", port };
}

// call is the single entry point. Returns {exit, body} on a served request, or
// null meaning "the caller must spawn tkr".
//
// Ordering is deliberate: the cheapest refusals come first, so the common
// disabled/absent cases cost one env read and one failed open, not a connect.
async function call(op, cmd, body, opts = {}) {
  const env = opts.env || process.env;
  if (!enabled(env)) return null;

  // Identity has to be establishable before anything else happens. If it is
  // not — no tkr on PATH, or a JS launcher whose eventual Go binary we cannot
  // name — then no endpoint can ever be accepted, and starting a runtime we
  // are guaranteed to reject is pure cost: a detached tkr spawn every 5s on
  // top of the spawn each call still pays. Bail before maybeStart, not after.
  if (!resolveTkrExe(env)) return null;

  const projectRoot = opts.projectRoot || projectRootFor(opts.cwd || process.cwd());
  const key = keyFor(projectRoot);

  if (Date.now() < readCooldown(key)) return null;

  const ep = readEndpoint(key, env);
  if (!ep) {
    // No usable runtime. Start one for NEXT time and let this call spawn.
    maybeStart(projectRoot, key, env);
    return null;
  }

  const budget = opts.timeoutMs || timeoutMs(env);
  const res = await request(ep, { op, cmd: String(cmd ?? "") }, body, budget);

  if (res === "timeout") {
    // A runtime that answers slowly is worse than none: it adds its deadline
    // to a spawn we still have to do. Suppress it and move on.
    writeCooldown(key, Date.now() + COOLDOWN_MS);
    return null;
  }
  if (!res) {
    // Connect refused / stale socket / malformed frame. The endpoint file may
    // be a crash leftover; try to bring a runtime back for next time.
    maybeStart(projectRoot, key, env);
    return null;
  }
  if (res.err) return null;
  return res;
}

module.exports = {
  call,
  keyFor,
  projectRootFor,
  readEndpoint,
  runDir,
  enabled,
  disabled,
  PROTO,
  ENDPOINT_SCHEMA,
  COOLDOWN_MS,
  START_COOLDOWN_MS,
  DEFAULT_TIMEOUT_MS,
};
