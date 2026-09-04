// Phase 2c contract (#16) — every nudge module's `gate(ctx)` must be a
// pure function: no fs writes, no spawns, no env mutation. Reads are
// caller's responsibility (orchestrator preloads via the wrapper).
//
// Failure here means a module is doing I/O inside its gate, which makes
// it impossible for the orchestrator to assemble ctx once and re-use it
// across a hook's composition.
//
// The five sessionstart/* entries left this registry at the #664 Phase 4
// cutover, when hooks/lib/sessionstart/ was deleted. Their gates are now
// Go (internal/hooks/sessionstart/), where purity is a property of the
// function signature rather than something a stub harness has to prove:
// each takes hookutil.Config and returns a string, with no fs or exec
// package in scope. What remains here is the posttool/ pair, which are
// still JS.
//
// Modules under test enumerated in REGISTRY below. To add a module:
//   1. Export `gate(ctx)` from it.
//   2. Add an entry here with a representative ctx.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const child_process = require("node:child_process");

// Modules with pure gate(ctx) exports. Each entry includes a few ctx
// variants to exercise the decision branches.
function loadRegistry() {
  return [
    {
      name: "posttool/cap-nudge",
      mod: require("./posttool/cap-nudge"),
      ctxs: [
        { env: {}, tool: "Glob", hasOutput: true },
        { env: {}, tool: "Grep", hasOutput: true },
        { env: {}, tool: "Read", hasOutput: true },
        { env: { TKR_CAP_NUDGE_DISABLED: "1" }, tool: "Glob", hasOutput: true },
        { env: {}, tool: "Glob", hasOutput: false },
      ],
    },
    {
      name: "posttool/ctx-breakpoint",
      mod: require("./posttool/ctx-breakpoint"),
      ctxs: [
        { ctxK: 0, highWaterK: 0, breakpoints: [100, 150, 200, 250, 300] },
        { ctxK: 50, highWaterK: 0, breakpoints: [100, 150, 200, 250, 300] },
        { ctxK: 120, highWaterK: 0, breakpoints: [100, 150, 200, 250, 300] },
        { ctxK: 220, highWaterK: 150, breakpoints: [100, 150, 200, 250, 300] },
        { ctxK: 320, highWaterK: 300, breakpoints: [100, 150, 200, 250, 300] },
      ],
    },
  ];
}

// withStubs — replace every fs write + child_process spawn function with
// a throwing stub. Returns a restore handle.
function withStubs(label) {
  const fsBefore = {
    writeFileSync: fs.writeFileSync,
    appendFileSync: fs.appendFileSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    rmdirSync: fs.rmdirSync,
    rmSync: fs.rmSync,
    chmodSync: fs.chmodSync,
    copyFileSync: fs.copyFileSync,
  };
  const cpBefore = {
    spawn: child_process.spawn,
    spawnSync: child_process.spawnSync,
    exec: child_process.exec,
    execFile: child_process.execFile,
    execSync: child_process.execSync,
    execFileSync: child_process.execFileSync,
    fork: child_process.fork,
  };
  const trap = (op) => () => {
    throw new Error(`gate(${label}) called ${op} — must be pure`);
  };
  fs.writeFileSync = trap("fs.writeFileSync");
  fs.appendFileSync = trap("fs.appendFileSync");
  fs.mkdirSync = trap("fs.mkdirSync");
  fs.renameSync = trap("fs.renameSync");
  fs.unlinkSync = trap("fs.unlinkSync");
  fs.rmdirSync = trap("fs.rmdirSync");
  fs.rmSync = trap("fs.rmSync");
  fs.chmodSync = trap("fs.chmodSync");
  fs.copyFileSync = trap("fs.copyFileSync");
  child_process.spawn = trap("child_process.spawn");
  child_process.spawnSync = trap("child_process.spawnSync");
  child_process.exec = trap("child_process.exec");
  child_process.execFile = trap("child_process.execFile");
  child_process.execSync = trap("child_process.execSync");
  child_process.execFileSync = trap("child_process.execFileSync");
  child_process.fork = trap("child_process.fork");
  return () => {
    Object.assign(fs, fsBefore);
    Object.assign(child_process, cpBefore);
  };
}

// Also detect reads — fs.readFileSync, fs.existsSync, fs.readdirSync,
// fs.statSync. A pure gate must not touch disk at all.
function withReadStubs(label) {
  const before = {
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
  };
  const trap = (op) => () => {
    throw new Error(`gate(${label}) called ${op} — must be pure`);
  };
  fs.readFileSync = trap("fs.readFileSync");
  fs.readdirSync = trap("fs.readdirSync");
  fs.existsSync = trap("fs.existsSync");
  fs.statSync = trap("fs.statSync");
  fs.lstatSync = trap("fs.lstatSync");
  fs.realpathSync = trap("fs.realpathSync");
  return () => Object.assign(fs, before);
}

const REGISTRY = loadRegistry();

for (const entry of REGISTRY) {
  test(`gate purity: ${entry.name} — no writes/spawns`, () => {
    assert.equal(
      typeof entry.mod.gate,
      "function",
      `${entry.name} must export gate(ctx)`,
    );
    const restoreWrite = withStubs(entry.name);
    try {
      for (const ctx of entry.ctxs) {
        // Calling must not throw from a stub; result type unconstrained.
        entry.mod.gate(ctx);
      }
    } finally {
      restoreWrite();
    }
  });

  test(`gate purity: ${entry.name} — no reads`, () => {
    const restoreRead = withReadStubs(entry.name);
    try {
      for (const ctx of entry.ctxs) {
        entry.mod.gate(ctx);
      }
    } finally {
      restoreRead();
    }
  });

  test(`gate purity: ${entry.name} — no process.env mutation`, () => {
    const snapshot = JSON.stringify(process.env);
    for (const ctx of entry.ctxs) {
      entry.mod.gate(ctx);
    }
    assert.equal(
      JSON.stringify(process.env),
      snapshot,
      `${entry.name}.gate mutated process.env`,
    );
  });
}

test("registry covers expected modules", () => {
  const names = REGISTRY.map((e) => e.name).sort();
  assert.deepEqual(names, [
    "posttool/cap-nudge",
    "posttool/ctx-breakpoint",
  ]);
});
