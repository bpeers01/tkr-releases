// hooks/lib/skill-scrape.test.js
//
// #263 — tests for the binary-scrape manifest builder. The primary
// fixture is SYNTHETIC but mirrors the REAL module-loader/export-
// binding shapes observed on the installed CC 2.1.227 binary (an
// earlier bare-identifier fixture passed while the real binary failed
// with every tree-bearing skill reporting hasTree:false — this fixture
// exists specifically to close that gap). An optional real-binary
// integration test runs only when explicitly requested
// (TKR_SCRAPE_REAL=1) against an installed CLI.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const scrape = require("./skill-scrape");
const sb = require("./skill-bundle");

// ---------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------

// Real (JS-evaluated) escape sequences -> the DECODED string the
// scraper should compute the UTF-8 byte length of. Buffer.byteLength
// is the independent oracle; the fixture text below embeds the same
// escapes LITERALLY (as raw source characters), which is what the
// scraper actually parses.
const TA1_DECODED = "Hello \u00e9\uD83D\uDE00 world\n"; // \uXXXX + surrogate pair + \n
const TA1_BYTES = Buffer.byteLength(TA1_DECODED, "utf8");

const TB1_DECODED = "\x41\x42\nBC"; // \x## + \n + plain chars
const TB1_BYTES = Buffer.byteLength(TB1_DECODED, "utf8");

const VERIFY_TOTAL_BYTES = TA1_BYTES + TB1_BYTES;

const KA1_DECODED = "dashboard content here";
const KA1_BYTES = Buffer.byteLength(KA1_DECODED, "utf8");
const KA2_DECODED = "report content here";
const KA2_BYTES = Buffer.byteLength(KA2_DECODED, "utf8");

const TRANSFORM_DECODED = "transform content here";
const TRANSFORM_BYTES = Buffer.byteLength(TRANSFORM_DECODED, "utf8");

const TEMPLATE_DECODED = "template content here";
const TEMPLATE_BYTES = Buffer.byteLength(TEMPLATE_DECODED, "utf8");
const RUN_EXAMPLE_DECODED = "run example content here";
const RUN_EXAMPLE_BYTES = Buffer.byteLength(RUN_EXAMPLE_DECODED, "utf8");
const COMPOSITE_TOTAL_BYTES = TEMPLATE_BYTES + RUN_EXAMPLE_BYTES;

// Literal (un-evaluated) escape text for embedding inside the fixture
// buffer's backtick literals — double-backslash so the JS engine
// building THIS test file emits a single literal backslash into the
// fixture string, exactly as it would appear in real minified source.
const TA1_LITERAL = "Hello \\u00e9\\uD83D\\uDE00 world\\n";
const TB1_LITERAL = "\\x41\\x42\\nBC";

function buildFixture({ withBroken } = {}) {
  const parts = [];
  parts.push('var junk0="noise";');
  parts.push('VERSION:"2.1.227";');
  parts.push("var wiring={registerBundledSkill:()=>Zq,other:()=>Xy};");

  // SKILL.md-only site, userInvocable default-true path exercised via
  // explicit !0.
  parts.push(
    'Zq({name:"batch",menuDescription:"m",description:"d",isEnabled:m,userInvocable:!0,async getPromptForCommand(){return[]}})',
  );

  // SKILL.md-only site, userInvocable:!1.
  parts.push(
    'Zq({name:"keybindings-help",menuDescription:"m",description:"d",isEnabled:m,userInvocable:!1,async getPromptForCommand(){return[]}})',
  );

  // --- STANDARD shape: real binary's `()=>LOADER().then((e)=>e.PROP)` ---
  // via `function LOADER(){return Promise.resolve().then(()=>(INIT(),EXPORTS))}`
  // + `var EXPORTS={};dt(EXPORTS,{PROP:()=>VAR,...})` + `var INIT=v(()=>{VAR={...}})`.
  parts.push("var VERIFY_EXPORTS={};");
  parts.push("dt(VERIFY_EXPORTS,{SKILL_MD:()=>VMD,SKILL_FILES:()=>VFILES});");
  parts.push("var VMD,VFILES;");
  parts.push(
    `var VERIFY_INIT=v(()=>{VMD=VmdContent;VFILES={"examples/cli.md":Ta1,"examples/server.md":Tb1}});`,
  );
  parts.push("function VERIFY_LOADER(){return Promise.resolve().then(() => (VERIFY_INIT(),VERIFY_EXPORTS))}");
  parts.push("var Ta1=`" + TA1_LITERAL + "`;");
  parts.push("var Tb1=`" + TB1_LITERAL + "`;");
  parts.push(
    'Zq({name:"verify",menuDescription:"m",description:"d",isEnabled:m,userInvocable:!0,files:()=>VERIFY_LOADER().then((e)=>e.SKILL_FILES),async getPromptForCommand(){return[]}})',
  );

  // --- RUNTIME FETCH shape: lowercase-only async body, no ALL_CAPS
  // export property anywhere -> hasTree:false, resolved:true.
  parts.push(
    'Zq({name:"artifact-capabilities",menuDescription:"m",description:"d",isEnabled:m,userInvocable:!0,files:async()=>{try{let o=await fetchRuntimeCapabilities();if(o===null)return{};return o.defs}catch{return{}}},async getPromptForCommand(){return[]}})',
  );

  // --- KINDS-LOOP shape: template name + `LOADER().then((n)=>n.PROP[e])`,
  // PROP resolves to a table keyed by kind with nested per-kind tables.
  parts.push("var KIND_EXPORTS={};");
  parts.push("dt(KIND_EXPORTS,{SKILL_MD:()=>KMD,SKILL_FILES:()=>KFILES});");
  parts.push("var KMD,KFILES;");
  parts.push(
    'var KIND_INIT=v(()=>{KFILES={dashboard:{"a.html":Ka1},report:{"b.html":Ka2}}});',
  );
  parts.push("function KIND_LOADER(){return Promise.resolve().then(() => (KIND_INIT(),KIND_EXPORTS))}");
  parts.push("var Ka1=`" + KA1_DECODED + "`;");
  parts.push("var Ka2=`" + KA2_DECODED + "`;");
  parts.push(
    "Zq({name:`artifact-${e}`,menuDescription:t,description:r,isEnabled:upn,userInvocable:!0,files:()=>KIND_LOADER().then((n)=>n.SKILL_FILES[e]),async getPromptForCommand(n){return[]}})",
  );

  // --- TRANSFORM shape: real binary's claude-api `()=>LOADER().then(FN)`
  // where FN is a bare ident whose body reads `e.SKILL_FILES`.
  parts.push("var TRANS_EXPORTS={};");
  parts.push("dt(TRANS_EXPORTS,{SKILL_FILES:()=>TFILES});");
  parts.push("var TFILES;");
  parts.push('var TRANS_INIT=v(()=>{TFILES={"a.md":Tc1}});');
  parts.push("function TRANS_LOADER(){return Promise.resolve().then(() => (TRANS_INIT(),TRANS_EXPORTS))}");
  parts.push("var Tc1=`" + TRANSFORM_DECODED + "`;");
  parts.push(
    "function TRANSFORM_FN(e){let t={};for(let[r,n]of Object.entries(e.SKILL_FILES))t[r]=n;return t}",
  );
  parts.push(
    'Zq({name:"claude-api-like",menuDescription:"m",description:"d",isEnabled:m,userInvocable:!0,files:()=>TRANS_LOADER().then(TRANSFORM_FN),async getPromptForCommand(){return[]}})',
  );

  // --- COMPOSITE shape: real binary's run-skill-generator
  // `async()=>{let[{PROP_A:x},{PROP_B:y}]=await Promise.all([...,...])}`,
  // summing two independently-exported resources. PROP_A resolves
  // through a one-level bare-ident alias chain (hzv=$wh in the real
  // binary; hzvAlias=WhAlias here).
  parts.push("var CompA={};dt(CompA,{TEMPLATE_MD:()=>hzvAlias});");
  parts.push("var mzvAlias,hzvAlias;");
  parts.push("var InitA=v(()=>{hzvAlias=WhAlias});");
  parts.push("var WhAlias=`" + TEMPLATE_DECODED + "`;");
  parts.push("var CompB={};dt(CompB,{RUN_EXAMPLE_FILES:()=>czvAlias});");
  parts.push("var czvAlias;");
  parts.push('var InitB=v(()=>{czvAlias={"examples/run.md":Rc1}});');
  parts.push("var Rc1=`" + RUN_EXAMPLE_DECODED + "`;");
  parts.push(
    'Zq({name:"run-skill-generator",menuDescription:"m",description:"d",isEnabled:m,userInvocable:!0,files:async()=>{let[{TEMPLATE_MD:e},{RUN_EXAMPLE_FILES:t}]=await Promise.all([Promise.resolve().then(() => (InitA(),CompA)),Promise.resolve().then(() => (InitB(),CompB))]);return{TEMPLATE_MD:e,RUN_EXAMPLE_FILES:t}},async getPromptForCommand(){return[]}})',
  );

  if (withBroken) {
    parts.push("var BROKEN_EXPORTS={};dt(BROKEN_EXPORTS,{SKILL_FILES:()=>BFILES});");
    parts.push("var BFILES;");
    parts.push('var BROKEN_INIT=v(()=>{BFILES={"missing.md":NoSuchVarAnywhere}});');
    parts.push("function BROKEN_LOADER(){return Promise.resolve().then(() => (BROKEN_INIT(),BROKEN_EXPORTS))}");
    parts.push(
      'Zq({name:"broken-skill",menuDescription:"m",description:"d",isEnabled:m,userInvocable:!0,files:()=>BROKEN_LOADER().then((e)=>e.SKILL_FILES),async getPromptForCommand(){return[]}})',
    );
  }

  return parts.join("");
}

function writeFixtureBinary(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-skill-scrape-"));
  const file = path.join(dir, "claude-fixture.bin");
  fs.writeFileSync(file, Buffer.from(text, "latin1"));
  return { dir, file };
}

// ---------------------------------------------------------------------
// scrapeManifest — clean fixture
// ---------------------------------------------------------------------

test("scrapeManifest: enumerates names, resolves userInvocable, hasTree, approxBytes, and reports complete:true on a clean fixture", () => {
  const { dir, file } = writeFixtureBinary(buildFixture());
  try {
    const manifest = scrape.scrapeManifest(file);

    assert.equal(manifest.schema, sb.MANIFEST_SCHEMA);
    assert.equal(manifest.ccVersion, "2.1.227");
    assert.equal(manifest.binaryPath, file);
    const st = fs.statSync(file);
    assert.equal(manifest.binarySize, st.size);
    assert.equal(manifest.binaryMtimeMs, Math.floor(st.mtimeMs));
    assert.equal(manifest.complete, true);

    const byName = Object.fromEntries(manifest.skills.map((s) => [s.name, s]));

    assert.equal(byName.batch.hasTree, false);
    assert.equal(byName.batch.approxBytes, null);
    assert.equal(byName.batch.userInvocable, true);

    assert.equal(byName["keybindings-help"].hasTree, false);
    assert.equal(byName["keybindings-help"].userInvocable, false);

    assert.equal(byName.verify.hasTree, true);
    assert.equal(byName.verify.approxBytes, VERIFY_TOTAL_BYTES);
    assert.equal(byName.verify.userInvocable, true);

    assert.equal(byName["artifact-capabilities"].hasTree, false);
    assert.equal(byName["artifact-capabilities"].approxBytes, null);

    assert.equal(byName["artifact-dashboard"].hasTree, true);
    assert.equal(byName["artifact-dashboard"].approxBytes, KA1_BYTES);
    assert.equal(byName["artifact-report"].hasTree, true);
    assert.equal(byName["artifact-report"].approxBytes, KA2_BYTES);

    assert.equal(byName["claude-api-like"].hasTree, true);
    assert.equal(byName["claude-api-like"].approxBytes, TRANSFORM_BYTES);

    assert.equal(byName["run-skill-generator"].hasTree, true);
    assert.equal(byName["run-skill-generator"].approxBytes, COMPOSITE_TOTAL_BYTES);

    assert.equal(manifest.skills.length, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// scrapeManifest — one unresolvable table var
// ---------------------------------------------------------------------

test("scrapeManifest: an unresolvable table var yields complete:false while other rows stay resolved", () => {
  const { dir, file } = writeFixtureBinary(buildFixture({ withBroken: true }));
  try {
    const manifest = scrape.scrapeManifest(file);
    assert.equal(manifest.complete, false);

    const byName = Object.fromEntries(manifest.skills.map((s) => [s.name, s]));
    assert.ok(byName["broken-skill"]);
    assert.equal(byName["broken-skill"].hasTree, true);
    assert.equal(byName["broken-skill"].approxBytes, null);

    // Other rows are unaffected by the one residual.
    assert.equal(byName.verify.approxBytes, VERIFY_TOTAL_BYTES);
    assert.equal(byName["artifact-dashboard"].approxBytes, KA1_BYTES);
    assert.equal(byName["run-skill-generator"].approxBytes, COMPOSITE_TOTAL_BYTES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// locateBinary
// ---------------------------------------------------------------------

test("locateBinary: honors TKR_CC_BINARY verbatim", () => {
  const result = scrape.locateBinary({ TKR_CC_BINARY: "C:/wherever/claude.exe" });
  assert.equal(result, "C:/wherever/claude.exe");
});

test("locateBinary: returns null when the finder command can't resolve claude", () => {
  // Scrub PATH so `where`/`which claude` finds nothing; must not throw.
  const result = scrape.locateBinary({ PATH: "", Path: "" });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------
// writeManifest — atomicity + round-trip through skill-bundle's
// manifestEntryFor, proving the two modules agree on the freshness
// contract (binarySize === stat size, binaryMtimeMs === floor(stat mtimeMs)).
// ---------------------------------------------------------------------

test("writeManifest: lands atomically at TKR_STATE_DIR/skill-manifest.json and round-trips through manifestEntryFor", () => {
  const stateDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-state-"));
  const { dir: binDir, file: fakeBinary } = writeFixtureBinary(buildFixture());
  try {
    const manifest = scrape.scrapeManifest(fakeBinary);
    assert.equal(manifest.complete, true);

    scrape.writeManifest(manifest, { TKR_STATE_DIR: stateDirPath });

    const target = path.join(stateDirPath, sb.MANIFEST_FILE);
    assert.ok(fs.existsSync(target));
    const onDisk = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(onDisk.schema, sb.MANIFEST_SCHEMA);
    assert.equal(onDisk.skills.length, manifest.skills.length);

    // No leftover tmp files.
    const leftovers = fs.readdirSync(stateDirPath).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);

    const prevStateDir = process.env.TKR_STATE_DIR;
    process.env.TKR_STATE_DIR = stateDirPath;
    try {
      const entry = sb.manifestEntryFor("batch", { root: path.join(os.tmpdir(), "tkr-skill-scrape-nonexistent-root") });
      assert.ok(entry, "manifestEntryFor should resolve the round-tripped row");
      assert.equal(entry.name, "batch");
      assert.equal(entry.hasTree, false);
    } finally {
      if (prevStateDir === undefined) delete process.env.TKR_STATE_DIR;
      else process.env.TKR_STATE_DIR = prevStateDir;
    }
  } finally {
    fs.rmSync(stateDirPath, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Optional real-binary integration test
// ---------------------------------------------------------------------

test("scrapeManifest: real installed binary (opt-in)", { skip: process.env.TKR_SCRAPE_REAL !== "1" }, (t) => {
  const binaryPath = scrape.locateBinary(process.env);
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    t.skip("no installed claude binary found");
    return;
  }
  const manifest = scrape.scrapeManifest(binaryPath);
  const row = manifest.skills.find((s) => s.name === "claude-api");
  assert.ok(row, "claude-api row should be present");
  assert.equal(row.hasTree, true);
  const expected = 869864;
  const tolerance = expected * 0.01;
  assert.ok(
    Math.abs(row.approxBytes - expected) <= tolerance,
    `claude-api approxBytes ${row.approxBytes} not within 1% of ${expected}`,
  );
});
