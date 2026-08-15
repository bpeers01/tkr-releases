// Tests for the resident-runtime client (#209).
//
// The property under test throughout is the fail-open contract: EVERY failure
// mode must return null, because null is what makes the caller spawn `tkr`
// exactly as it did before this feature existed. A client that throws, hangs,
// or returns a partial answer would turn a latency optimization into an
// availability regression on the hottest path Claude has.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const WIN = process.platform === "win32";
let endpointSerial = 0;

// Each test gets its own state dir. The module caches nothing at import time,
// but stateDir() is read per call, so the env has to be set before require —
// hence the fresh-require helper.
function freshClient(stateDir) {
  process.env.TKR_STATE_DIR = stateDir;
  delete require.cache[require.resolve("./resident-client.js")];
  delete require.cache[require.resolve("./state-dir.js")];
  return require("./resident-client.js");
}

function tmpState(name) {
  // Kept short: a Unix socket path over ~100 bytes cannot be bound at all, and
  // os.tmpdir() plus a long test name gets there faster than it looks.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tkrres-${name}-`));
  return dir;
}

// stampOf produces the size/mtime pair the server records, so a test can point
// an endpoint at an arbitrary binary without hand-copying the stamp rules.
function stampOf(exe) {
  const st = fs.statSync(exe, { bigint: true });
  return { exe_size: Number(st.size), exe_mtime_ms: Number(st.mtimeMs) };
}

function writeEndpoint(client, key, overrides) {
  const runDir = client.runDir();
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const exe = path.join(runDir, "fake-tkr");
  if (!fs.existsSync(exe)) fs.writeFileSync(exe, "binary", { mode: 0o755 });
  const st = fs.statSync(exe, { bigint: true });
  const ep = {
    schema: client.ENDPOINT_SCHEMA,
    proto: client.PROTO,
    version: "test",
    pid: process.pid,
    network: WIN ? "pipe" : "unix",
    address: WIN
      ? `\\\\.\\pipe\\tkrres-test-${process.pid}-${key}-${++endpointSerial}`
      : path.join(runDir, `${key}.sock`),
    token: "tok".repeat(10),
    project_root: "/p",
    exe,
    exe_size: Number(st.size),
    exe_mtime_ms: Number(st.mtimeMs),
    started_unix: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  fs.writeFileSync(path.join(runDir, `${key}.json`), JSON.stringify(ep), { mode: 0o600 });
  return ep;
}

// A minimal server speaking the wire format, so the client can be tested
// without building Go.
function frameHandler(handler) {
  return (socket) => {
    let buf = Buffer.alloc(0);
    let head = null;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (head === null) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        head = JSON.parse(buf.subarray(0, nl).toString("utf8"));
        buf = buf.subarray(nl + 1);
      }
      if (buf.length < head.n) return;
      handler(socket, head, buf.subarray(0, head.n));
    });
    socket.on("error", () => {});
  };
}

// serveEndpoint stands up a fake runtime on the production transport for this
// platform: AF_UNIX on POSIX and a named pipe on Windows.
async function serveEndpoint(client, key, handler) {
  const server = net.createServer(frameHandler(handler));
  const ep = writeEndpoint(client, key);
  await new Promise((resolve) => server.listen(ep.address, resolve));
  return { ep, server };
}

function reply(socket, { exit = 0, body = "", err }) {
  const payload = Buffer.from(body);
  const header = { proto: 1, exit, n: payload.length };
  if (err) header.err = err;
  socket.write(JSON.stringify(header) + "\n");
  if (payload.length) socket.write(payload);
  socket.end();
}

const ENV_ON = { TKR_RESIDENT_ENABLED: "1" };

test("disabled by default — the prototype does not turn itself on", async () => {
  const dir = tmpState("default");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  writeEndpoint(client, key);
  const res = await client.call("rewrite", "git status", null, { projectRoot: "/p", env: {} });
  assert.equal(res, null, "must not use the runtime without TKR_RESIDENT_ENABLED=1");
});

test("TKR_RESIDENT_DISABLED=1 wins over TKR_RESIDENT_ENABLED=1", async () => {
  const dir = tmpState("killswitch");
  const client = freshClient(dir);
  const env = { TKR_RESIDENT_ENABLED: "1", TKR_RESIDENT_DISABLED: "1" };
  assert.equal(client.enabled(env), false);
  const res = await client.call("rewrite", "git status", null, { projectRoot: "/p", env });
  assert.equal(res, null);
});

test("missing endpoint file returns null", async () => {
  const dir = tmpState("missing");
  const client = freshClient(dir);
  const res = await client.call("rewrite", "git status", null, { projectRoot: "/p", env: ENV_ON });
  assert.equal(res, null);
});

test("endpoint validation refuses every wrong shape", async () => {
  const dir = tmpState("shape");
  const client = freshClient(dir);
  const cases = {
    "future schema": { schema: client.ENDPOINT_SCHEMA + 1 },
    "past schema": { schema: client.ENDPOINT_SCHEMA - 1 },
    "future proto": { proto: client.PROTO + 1 },
    "no token": { token: "" },
    "no address": { address: "" },
    "zero pid": { pid: 0 },
    "unknown network": { network: "carrier-pigeon" },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const key = client.keyFor("/p-" + name);
    writeEndpoint(client, key, overrides);
    assert.equal(client.readEndpoint(key, { TKR_BIN: path.join(client.runDir(), "fake-tkr") }), null, name);
  }
});

test("malformed endpoint JSON returns null, never throws", async () => {
  const dir = tmpState("garbage");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  fs.mkdirSync(client.runDir(), { recursive: true, mode: 0o700 });
  for (const content of ["", "{", "not json", "[]", "null", "0"]) {
    fs.writeFileSync(path.join(client.runDir(), `${key}.json`), content);
    assert.equal(client.readEndpoint(key, {}), null, JSON.stringify(content));
  }
});

// The upgrade guard. This is also the regression test for the bug that made
// the feature silently never engage: Node's non-bigint stat reports mtimeMs as
// a FLOAT with sub-millisecond precision, while Go's UnixMilli() truncates, so
// a naive === rejected every endpoint as "upgraded".
test("binary stamp: matches an unchanged binary, refuses a changed one", async () => {
  const dir = tmpState("stamp");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const ep = writeEndpoint(client, key);
  const env = { TKR_BIN: ep.exe };

  assert.ok(client.readEndpoint(key, env), "unchanged binary must be accepted");

  // Size change.
  fs.writeFileSync(ep.exe, "binary that is longer now", { mode: 0o755 });
  assert.equal(client.readEndpoint(key, env), null, "resized binary must be refused");

  // Same size, later mtime.
  fs.writeFileSync(ep.exe, "binary", { mode: 0o755 });
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(ep.exe, future, future);
  assert.equal(client.readEndpoint(key, env), null, "rebuilt binary must be refused");

  // Vanished binary.
  fs.rmSync(ep.exe);
  assert.equal(client.readEndpoint(key, env), null, "missing binary must be refused");
});

// ── executable identity ─────────────────────────────────────────────────────
//
// resolveTkrBin returns a COMMAND STRING and legitimately falls back to the
// bare "tkr". The endpoint check needs a PHYSICAL path, and conflating the two
// broke every PATH-only install: path.resolve("tkr") is cwd-relative, so it
// never matched the server's os.Executable(), and the client rejected its own
// runtime forever — while still firing a lazy start every 5s, which is worse
// than not having the feature.

test("identity: an explicit TKR_BIN is accepted", () => {
  const dir = tmpState("idexplicit");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const ep = writeEndpoint(client, key);
  assert.ok(client.readEndpoint(key, { TKR_BIN: ep.exe, PATH: "" }));
});

test("identity: a PATH-only install is accepted", () => {
  const dir = tmpState("idpath");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  // The binary lives on PATH under the bare name, with no TKR_BIN and no
  // standard install location — the exact shape that was rejected forever.
  // On Windows a PATH install means tkr.exe: whichFromPath honors PATHEXT,
  // and an extensionless "tkr" is not a command there.
  const binDir = path.join(dir, "pathbin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, WIN ? "tkr.exe" : "tkr");
  fs.writeFileSync(exe, "binary", { mode: 0o755 });
  const ep = writeEndpoint(client, key, { exe, ...stampOf(exe) });

  const env = { PATH: binDir, HOME: path.join(dir, "nohome") };
  assert.ok(
    client.readEndpoint(key, env),
    "a PATH-only install must be able to use the runtime it started",
  );
});

test("identity: a standard install location is accepted", () => {
  const dir = tmpState("idstd");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  // Mirror resolveTkrBin's standard probe: $HOME/.local/bin/tkr on unix.
  const home = path.join(dir, "home");
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, process.platform === "win32" ? "tkr.exe" : "tkr");
  fs.writeFileSync(exe, "binary", { mode: 0o755 });
  const ep = writeEndpoint(client, key, { exe, ...stampOf(exe) });

  assert.ok(client.readEndpoint(key, { HOME: home, USERPROFILE: home, PATH: "" }));
});

// Symlinked installs are the common shape for ~/.local/bin. Both sides must
// compare the physical file or these never match.
test("identity: a symlinked install is accepted", (t) => {
  const dir = tmpState("idsymlink");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const realDir = path.join(dir, "opt");
  const linkDir = path.join(dir, "linkbin");
  fs.mkdirSync(realDir, { recursive: true });
  fs.mkdirSync(linkDir, { recursive: true });
  const real = path.join(realDir, "tkr");
  fs.writeFileSync(real, "binary", { mode: 0o755 });
  const link = path.join(linkDir, "tkr");
  try {
    fs.symlinkSync(real, link);
  } catch {
    t.skip("symlinks not permitted in this environment");
    return;
  }
  // The server records the resolved physical path (EvalSymlinks(os.Executable)).
  writeEndpoint(client, key, { exe: real, ...stampOf(real) });
  // The client finds the SYMLINK on PATH and must still recognize it.
  assert.ok(
    client.readEndpoint(key, { PATH: linkDir, HOME: path.join(dir, "nohome") }),
    "a symlinked install must resolve to the same physical binary",
  );
});

// The .js launcher is a shape this project ships (.claude-plugin/plugin.json
// points Claude Code at bin/tkr-launcher.js). It is run as `node <launcher>`,
// so the runtime's os.Executable() is a DIFFERENT file and identity cannot be
// established. The client must skip the resident path — and, critically, must
// not keep starting runtimes it will always reject.
test("identity: a .js launcher is refused and starts nothing", async () => {
  const dir = tmpState("idlauncher");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const ep = writeEndpoint(client, key);
  const launcher = path.join(client.runDir(), "tkr-launcher.js");
  fs.writeFileSync(launcher, "// launcher");
  const env = { ...ENV_ON, TKR_BIN: launcher };

  assert.equal(client.readEndpoint(key, env), null, "a launcher cannot prove identity");

  const res = await client.call("rewrite", "git status", null, { projectRoot: "/p", env });
  assert.equal(res, null);
  assert.equal(
    fs.existsSync(path.join(client.runDir(), `${key}.start`)),
    false,
    "must not start a runtime it can never accept",
  );
});

// Same rule for "no tkr anywhere": unverifiable identity means no start
// attempts, or the feature costs a detached spawn every 5s forever.
test("identity: unresolvable tkr starts nothing", async () => {
  const dir = tmpState("idnone");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  writeEndpoint(client, key);
  const env = { ...ENV_ON, PATH: path.join(dir, "empty"), HOME: path.join(dir, "nohome") };
  delete env.TKR_BIN;

  const res = await client.call("rewrite", "git status", null, { projectRoot: "/p", env });
  assert.equal(res, null);
  assert.equal(
    fs.existsSync(path.join(client.runDir(), `${key}.start`)),
    false,
    "must not start a runtime it can never accept",
  );
});

test("a runtime started from a different binary is refused", async () => {
  const dir = tmpState("otherbin");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const ep = writeEndpoint(client, key);
  const other = path.join(client.runDir(), "other-tkr");
  fs.writeFileSync(other, "different", { mode: 0o755 });
  assert.equal(
    client.readEndpoint(key, { TKR_BIN: other }),
    null,
    "TKR_BIN pointing elsewhere must not be served by this runtime",
  );
});

test("served request returns exit code and body", async () => {
  const dir = tmpState("served");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const { ep, server } = await serveEndpoint(client, key, (socket, head, body) => {
    assert.equal(head.token, ep.token, "token must be sent");
    assert.equal(head.op, "filter-stdin");
    reply(socket, { exit: 0, body: `got:${body.toString()}` });
  });
  try {
    const res = await client.call("filter-stdin", "df -h", "payload", {
      projectRoot: "/p",
      env: { ...ENV_ON, TKR_BIN: ep.exe },
    });
    assert.ok(res, "expected a served response");
    assert.equal(res.exit, 0);
    assert.equal(res.body.toString(), "got:payload");
  } finally {
    server.close();
  }
});

test("multi-line body survives framing in both directions", async () => {
  const dir = tmpState("frames");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  // Contains a line that looks exactly like a response header — a line-oriented
  // protocol would truncate here.
  const payload = 'line1\n{"proto":1,"exit":0,"n":0}\nline3\n';
  const { ep, server } = await serveEndpoint(client, key, (socket, _head, body) => {
    reply(socket, { exit: 0, body: body.toString() });
  });
  try {
    const res = await client.call("filter-stdin", "df -h", payload, {
      projectRoot: "/p",
      env: { ...ENV_ON, TKR_BIN: ep.exe },
    });
    assert.equal(res.body.toString(), payload);
  } finally {
    server.close();
  }
});

test("a response carrying err returns null so the caller spawns", async () => {
  const dir = tmpState("errreply");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const { ep, server } = await serveEndpoint(client, key, (socket) => {
    reply(socket, { exit: 1, body: "", err: "unknown op" });
  });
  try {
    const res = await client.call("rewrite", "git status", null, {
      projectRoot: "/p",
      env: { ...ENV_ON, TKR_BIN: ep.exe },
    });
    assert.equal(res, null);
  } finally {
    server.close();
  }
});

test("wrong protocol in the response returns null", async () => {
  const dir = tmpState("badproto");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const { ep, server } = await serveEndpoint(client, key, (socket) => {
    socket.write(JSON.stringify({ proto: 99, exit: 0, n: 0 }) + "\n");
    socket.end();
  });
  try {
    const res = await client.call("rewrite", "git status", null, {
      projectRoot: "/p",
      env: { ...ENV_ON, TKR_BIN: ep.exe },
    });
    assert.equal(res, null);
  } finally {
    server.close();
  }
});

test("a truncated response returns null rather than a partial answer", async () => {
  const dir = tmpState("truncated");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const { ep, server } = await serveEndpoint(client, key, (socket) => {
    // Promise 100 bytes, send 5, hang up. A client that trusted the header
    // would hand the caller a silently truncated command output.
    socket.write(JSON.stringify({ proto: 1, exit: 0, n: 100 }) + "\n");
    socket.write("short");
    socket.end();
  });
  try {
    const res = await client.call("filter-stdin", "df -h", "x", {
      projectRoot: "/p",
      env: { ...ENV_ON, TKR_BIN: ep.exe },
    });
    assert.equal(res, null);
  } finally {
    server.close();
  }
});

test("garbage on the wire returns null", async () => {
  const dir = tmpState("wiregarbage");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const { ep, server } = await serveEndpoint(client, key, (socket) => {
    socket.write("this is not a frame\n");
    socket.end();
  });
  try {
    const res = await client.call("rewrite", "git status", null, {
      projectRoot: "/p",
      env: { ...ENV_ON, TKR_BIN: ep.exe },
    });
    assert.equal(res, null);
  } finally {
    server.close();
  }
});

test("endpoint validation refuses a non-native transport", () => {
  const dir = tmpState("foreign-transport");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const foreign = WIN
    ? { network: "tcp", address: "127.0.0.1:12345" }
    : { network: "pipe", address: "\\\\.\\pipe\\tkrres-foreign" };
  const ep = writeEndpoint(client, key, foreign);
  assert.equal(client.readEndpoint(key, { TKR_BIN: ep.exe }), null);
});

test("a stale socket (endpoint present, nobody listening) returns null fast", async () => {
  const dir = tmpState("stale");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  writeEndpoint(client, key); // no server ever started on the socket/pipe
  const t0 = Date.now();
  const res = await client.call("rewrite", "git status", null, {
    projectRoot: "/p",
    env: { ...ENV_ON, TKR_BIN: path.join(client.runDir(), "fake-tkr") },
  });
  const elapsed = Date.now() - t0;
  assert.equal(res, null);
  assert.ok(elapsed < 500, `stale endpoint cost ${elapsed}ms; must fail fast`);
});

// A hung runtime must cost ONE deadline, not one per Bash call.
test("a timeout writes a cooldown that suppresses the next calls", async () => {
  const dir = tmpState("cooldown");
  const client = freshClient(dir);
  const key = client.keyFor("/p");
  const { ep, server } = await serveEndpoint(client, key, () => {
    /* accept and never answer */
  });
  const env = { ...ENV_ON, TKR_BIN: ep.exe };
  try {
    const t0 = Date.now();
    const first = await client.call("rewrite", "git status", null, {
      projectRoot: "/p",
      env,
      timeoutMs: 120,
    });
    const firstMs = Date.now() - t0;
    assert.equal(first, null);
    assert.ok(firstMs >= 100, `expected to wait out the deadline, took ${firstMs}ms`);

    assert.ok(
      fs.existsSync(path.join(client.runDir(), `${key}.cooldown`)),
      "a timeout must record a cooldown",
    );

    const t1 = Date.now();
    const second = await client.call("rewrite", "git status", null, {
      projectRoot: "/p",
      env,
      timeoutMs: 120,
    });
    const secondMs = Date.now() - t1;
    assert.equal(second, null);
    assert.ok(secondMs < 50, `cooldown not honored: second call took ${secondMs}ms`);
  } finally {
    server.close();
  }
});

// A runtime that crashes on startup must not become one extra spawn per Bash
// call — that would make this feature strictly worse than no feature.
test("lazy start is rate-limited", async () => {
  const dir = tmpState("ratelimit");
  const client = freshClient(dir);
  const marker = path.join(client.runDir(), `${client.keyFor("/p")}.start`);
  // A binary that exits immediately, standing in for a runtime that dies.
  // Must be an ABSOLUTE path: resolveTkrExe realpaths an explicit TKR_BIN, so
  // a bare name like "cmd.exe" resolves against cwd, fails, and the call
  // bails on unverifiable identity before maybeStart ever runs.
  const stub = WIN
    ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
    : "/bin/true";
  const env = { ...ENV_ON, TKR_BIN: stub };

  await client.call("rewrite", "git status", null, { projectRoot: "/p", env });
  assert.ok(fs.existsSync(marker), "first miss should attempt a start");
  const firstMtime = fs.statSync(marker).mtimeMs;

  await client.call("rewrite", "git status", null, { projectRoot: "/p", env });
  await client.call("rewrite", "git status", null, { projectRoot: "/p", env });
  assert.equal(
    fs.statSync(marker).mtimeMs,
    firstMtime,
    "subsequent misses inside the window must not re-attempt a start",
  );
  assert.ok(client.START_COOLDOWN_MS >= 1000, "start cooldown must be a real window");
});

// The client derives the runtime key from its own port of
// config.FindProjectRoot. If the two disagree, client and server look for each
// other in different files and the feature silently never engages.
test("projectRootFor matches the Go project-root resolution", () => {
  const dir = tmpState("rootparity");
  const client = freshClient(dir);

  const proj = path.join(dir, "myproj");
  const nested = path.join(proj, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(proj, ".tkr"));

  assert.equal(fs.realpathSync(client.projectRootFor(nested)), fs.realpathSync(proj));
  assert.equal(fs.realpathSync(client.projectRootFor(proj)), fs.realpathSync(proj));

  // No marker anywhere → the start directory itself, matching
  // cmd_resident.go's residentProjectRoot fallback.
  const orphan = path.join(dir, "orphan");
  fs.mkdirSync(orphan, { recursive: true });
  assert.equal(client.projectRootFor(orphan), path.resolve(orphan));

  // A FILE named .tkr is not a project root — Go requires a directory.
  const filey = path.join(dir, "filey");
  fs.mkdirSync(filey);
  fs.writeFileSync(path.join(filey, ".tkr"), "");
  assert.equal(client.projectRootFor(filey), path.resolve(filey));
});

// Cross-language check: the Go binary and this client must derive the SAME key
// for the same root. Skipped when no binary is available, and it says so.
test("key matches the Go implementation", (t) => {
  const bin = process.env.TKR_BIN || path.join(REPO, WIN ? "tkr.exe" : "tkr");
  if (!fs.existsSync(bin)) {
    t.skip(`no tkr binary at ${bin} — build it or set TKR_BIN to run this parity check`);
    return;
  }
  const dir = tmpState("keyparity");
  const client = freshClient(dir);
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tkrkey-")));
  fs.mkdirSync(path.join(proj, ".tkr"));
  // spawnSync, not execFileSync: `resident status` exits 1 when no runtime is
  // live, which is exactly the state here — the key is still reported.
  const r = spawnSync(bin, ["resident", "status", "--json"], {
    encoding: "utf8",
    cwd: proj,
    env: { ...process.env, TKR_STATE_DIR: dir },
  });

  // INV-126: an unguarded JSON.parse on empty/non-JSON stdout dies with
  // "Unexpected end of JSON input" and no indication of WHY — a stale
  // repo-root binary (predates `resident status --json`, or a build that
  // failed silently) looks identical to a parser bug from that message
  // alone. Name the binary, its mtime, and the remedy so the failure is
  // actionable on first read.
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(keyParityDiagnostic(bin, r, err));
  }
  // Cheap version check (no extra process spawn): a binary old enough to
  // predate the `--json` key field can still exit 0 with parseable JSON
  // that simply lacks `key` — catch that shape mismatch here too, rather
  // than letting it surface as an opaque assert.equal(undefined, ...).
  if (!report || typeof report.key !== "string") {
    throw new Error(
      keyParityDiagnostic(
        bin,
        r,
        new Error("parsed JSON has no string 'key' field — binary may predate this schema"),
      ),
    );
  }

  assert.equal(
    client.keyFor(client.projectRootFor(proj)),
    report.key,
    "JS and Go must agree on the runtime key for the same project root",
  );
});

// keyParityDiagnostic builds the actionable failure message for the
// key-parity test above: which binary ran, how stale it is, what it
// actually printed, and the one-line remedy (INV-126).
function keyParityDiagnostic(bin, r, err) {
  const mtime = (() => {
    try {
      return fs.statSync(bin).mtime.toISOString();
    } catch {
      return "unknown (stat failed)";
    }
  })();
  return (
    `key-parity: could not use JSON from '${bin} resident status --json'.\n` +
    `  binary: ${bin}\n` +
    `  binary mtime: ${mtime}\n` +
    `  exit code: ${r.status}, signal: ${r.signal}\n` +
    `  stdout: ${JSON.stringify(r.stdout)}\n` +
    `  stderr: ${JSON.stringify(r.stderr)}\n` +
    `  cause: ${err.message}\n` +
    `  remedy: rebuild the binary — 'go build ./cmd/tkr' — and re-run.`
  );
}
