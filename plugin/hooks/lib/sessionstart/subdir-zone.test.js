// Tests for hooks/lib/sessionstart/subdir-zone.js
// Run with: node --test hooks/lib/sessionstart/subdir-zone.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  parseZonesToml,
  resolveZone,
  walkClaudeMdChain,
  buildSubdirZoneSection,
  loadZones,
  normalizePrefix,
  zoneMatches,
} = require("./subdir-zone");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("parseZonesToml — basic", () => {
  const z = parseZonesToml(`
[[zone]]
path_prefix = "internal/graph"
test = "go test ./internal/graph/..."
fmt = "gofmt -w internal/graph"

[[zone]]
path_prefix = "hooks"
test = "node --test hooks/"
`);
  assert.equal(z.length, 2);
  assert.equal(z[0].pathPrefix, "internal/graph");
  assert.equal(z[0].test, "go test ./internal/graph/...");
  assert.equal(z[0].fmt, "gofmt -w internal/graph");
  assert.equal(z[1].pathPrefix, "hooks");
});

test("parseZonesToml — strips comments and tolerates blank lines", () => {
  const z = parseZonesToml(`
# top-level comment
[[zone]]   # header comment
path_prefix = "x"  # trailing comment
test = "echo hi"

[[zone]]
path_prefix = "y"
`);
  assert.equal(z.length, 2);
  assert.equal(z[0].pathPrefix, "x");
  assert.equal(z[0].test, "echo hi");
});

test("parseZonesToml — preserves # inside string", () => {
  const z = parseZonesToml(`
[[zone]]
path_prefix = "x"
test = "echo '#not-a-comment'"
`);
  assert.equal(z.length, 1);
  assert.equal(z[0].test, "echo '#not-a-comment'");
});

test("parseZonesToml — empty / malformed input", () => {
  assert.deepEqual(parseZonesToml(""), []);
  assert.deepEqual(parseZonesToml("garbage =\nnot toml\n"), []);
});

test("normalizePrefix", () => {
  assert.equal(normalizePrefix("  internal/graph  "), "internal/graph");
  assert.equal(normalizePrefix("internal\\graph"), "internal/graph");
  assert.equal(normalizePrefix("./internal/graph/"), "internal/graph");
  assert.equal(normalizePrefix(""), "");
  assert.equal(normalizePrefix("/"), "");
});

test("zoneMatches", () => {
  assert.equal(zoneMatches("", ""), true);
  assert.equal(zoneMatches("", "internal/graph"), false);
  assert.equal(zoneMatches("internal/graph", "internal/graph"), true);
  assert.equal(zoneMatches("internal/graph", "internal/graph/store"), true);
  assert.equal(zoneMatches("internal/graph", "internal/graphic"), false);
});

test("resolveZone — deepest match wins", () => {
  const zones = [
    { pathPrefix: "internal",        test: "outer" },
    { pathPrefix: "internal/graph",  test: "inner" },
    { pathPrefix: "",                test: "root" },
  ];
  const root = mkTmp("zonetest-");
  try {
    fs.mkdirSync(path.join(root, "internal", "graph", "store"), { recursive: true });
    assert.equal(resolveZone(zones, root, path.join(root, "internal", "graph", "store")).test, "inner");
    assert.equal(resolveZone(zones, root, path.join(root, "internal", "filter")).test, "outer");
    assert.equal(resolveZone(zones, root, root).test, "root");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveZone — cwd outside repo returns null", () => {
  const zones = [{ pathPrefix: "", test: "root" }];
  const root = mkTmp("zonetest-root-");
  const other = mkTmp("zonetest-other-");
  try {
    assert.equal(resolveZone(zones, root, other), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("walkClaudeMdChain — collects nearest first", () => {
  const root = mkTmp("zonetest-claude-");
  try {
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "root");
    const sub = path.join(root, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(root, "a", "CLAUDE.md"), "a");
    fs.writeFileSync(path.join(sub, "CLAUDE.md"), "b");
    const chain = walkClaudeMdChain(root, sub);
    assert.equal(chain.length, 3);
    assert.ok(chain[0].endsWith(path.join("a", "b", "CLAUDE.md")));
    assert.ok(chain[1].endsWith(path.join("a", "CLAUDE.md")));
    assert.ok(chain[2].endsWith("CLAUDE.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadZones — missing file returns []", () => {
  const root = mkTmp("zonetest-load-");
  try {
    assert.deepEqual(loadZones(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadZones — reads .tkr/zones.toml", () => {
  const root = mkTmp("zonetest-load2-");
  try {
    fs.mkdirSync(path.join(root, ".tkr"));
    fs.writeFileSync(
      path.join(root, ".tkr", "zones.toml"),
      `[[zone]]\npath_prefix = "x"\ntest = "echo hi"\n`,
    );
    const z = loadZones(root);
    assert.equal(z.length, 1);
    assert.equal(z[0].test, "echo hi");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildSubdirZoneSection — empty when cwd == repoRoot", () => {
  const root = mkTmp("zonetest-sec-root-");
  try {
    fs.mkdirSync(path.join(root, ".tkr"));
    fs.writeFileSync(
      path.join(root, ".tkr", "zones.toml"),
      `[[zone]]\npath_prefix = "internal/graph"\ntest = "go test ./internal/graph/..."\n`,
    );
    const s = buildSubdirZoneSection({ repoRoot: root, cwd: root });
    assert.equal(s, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildSubdirZoneSection — emits chain + zone when in subdir", () => {
  const root = mkTmp("zonetest-sec-sub-");
  try {
    fs.mkdirSync(path.join(root, ".tkr"));
    fs.writeFileSync(
      path.join(root, ".tkr", "zones.toml"),
      `[[zone]]\npath_prefix = "internal/graph"\ntest = "go test ./internal/graph/..."\nfmt = "gofmt -w internal/graph"\n`,
    );
    const sub = path.join(root, "internal", "graph");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "CLAUDE.md"), "graph notes");
    const s = buildSubdirZoneSection({ repoRoot: root, cwd: sub });
    assert.ok(s.includes("tkr subdir context"), `section header missing: ${s}`);
    assert.ok(s.includes("internal/graph"), `subtree label missing: ${s}`);
    assert.ok(s.includes("go test ./internal/graph/..."), `test cmd missing: ${s}`);
    assert.ok(s.includes("CLAUDE.md"), `chain block missing: ${s}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildSubdirZoneSection — silent when no chain and no zone", () => {
  const root = mkTmp("zonetest-sec-silent-");
  try {
    // No zones file, no subdir CLAUDE.md.
    const sub = path.join(root, "untracked");
    fs.mkdirSync(sub, { recursive: true });
    const s = buildSubdirZoneSection({ repoRoot: root, cwd: sub });
    assert.equal(s, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildSubdirZoneSection — handles missing repoRoot gracefully", () => {
  assert.equal(buildSubdirZoneSection({ repoRoot: "", cwd: "/tmp" }), "");
  assert.equal(buildSubdirZoneSection({}), "");
});
