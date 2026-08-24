// Tests for the `tkr signals --statusline-fields` cache parser in
// hooks/statusline.sh.
//
// `tkr signals --statusline-fields` single-quotes every string value
// (cmd/tkr/cmd_signals.go shellQuote). The parser must strip those quotes:
// `declare "$word"` performs no quote removal on an expanded word, so an
// unstripped empty field arrives as the 2-character value `''` — truthy to
// `[ -n ... ]` — and every equality test against an unquoted literal fails.
// That silently produced a hollow `RT:` badge and a permanently dead `DELEG`
// badge.
//
// Strategy: extract the parser block VERBATIM from statusline.sh between the
// SIGFIELDS_PARSE sentinels, so the test can never drift from the script
// it is testing. Skips on hosts without bash.
//
// Run: node --test hooks/statusline-sigfields.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { bashPath, logInterpreter } = require("./lib/bash-interpreter");

const BASH = bashPath();
const HAVE_BASH = !!BASH;
const SCRIPT = path.join(__dirname, "statusline.sh");

logInterpreter("statusline-sigfields");

// Pull the real block out of the real script — no mirrored copy to keep in
// lockstep.
function extractParser() {
  // CRLF-normalize: see extractBlock in statusline-model-persist.test.js
  // — on an autocrlf Windows checkout the strict pattern never matches
  // and bash trips over stray \r in the extracted block.
  const src = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
  const m = src.match(
    /^\s*# >>> SIGFIELDS_PARSE.*?\n([\s\S]*?)^\s*# <<< SIGFIELDS_PARSE/m,
  );
  assert.ok(m, "SIGFIELDS_PARSE sentinels not found in statusline.sh");
  return m[1];
}

// Run the extracted parser against a synthetic cache file and report the
// resulting variable values, one per line, in a form that survives empties.
function runParser(cacheContent, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sigfields-"));
  const cache = path.join(dir, "statusline-signals.cache");
  fs.writeFileSync(cache, cacheContent);
  const reports = names
    .map((n) => `printf '${n}=[%s]\\n' "\${${n}:-}"`)
    .join("\n");
  const script = `
set -u
TKR_SIG_CACHE="$1"
${extractParser()}
${reports}
`;
  try {
    const r = spawnSync(BASH, ["-c", script, "bash", cache], {
      encoding: "utf8",
    });
    assert.strictEqual(r.status, 0, `parser exited ${r.status}: ${r.stderr}`);
    const out = {};
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^(\w+)=\[([\s\S]*)\]$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Exactly what shellQuote emits for the given raw value.
function quoted(name, raw) {
  if (raw === "") return `${name}=''`;
  return `${name}='${raw.split("'").join("'\\''")}'`;
}

test("empty quoted field parses as genuinely empty", { skip: !HAVE_BASH }, () => {
  const out = runParser(quoted("TKR_ROUTE_EFFORT", "") + "\n", [
    "TKR_ROUTE_EFFORT",
  ]);
  assert.strictEqual(
    out.TKR_ROUTE_EFFORT,
    "",
    "an empty field must not arrive as the 2-char literal ''",
  );
});

test("quoted values compare equal to bare literals", { skip: !HAVE_BASH }, () => {
  const cache =
    [
      quoted("TKR_RECOMMEND", "delegate"),
      quoted("TKR_DELEGATE_VIA", "codex"),
      quoted("TKR_ROUTE_CLASS", "repo_wide_refactor"),
      quoted("TKR_ROUTE_EFFORT", "high"),
    ].join("\n") + "\n";
  const out = runParser(cache, [
    "TKR_RECOMMEND",
    "TKR_DELEGATE_VIA",
    "TKR_ROUTE_CLASS",
    "TKR_ROUTE_EFFORT",
  ]);
  assert.strictEqual(out.TKR_RECOMMEND, "delegate");
  assert.strictEqual(out.TKR_DELEGATE_VIA, "codex");
  assert.strictEqual(out.TKR_ROUTE_CLASS, "repo_wide_refactor");
  assert.strictEqual(out.TKR_ROUTE_EFFORT, "high");
});

test("embedded single quotes survive the '\\'' dance", { skip: !HAVE_BASH }, () => {
  const out = runParser(quoted("TKR_REASON", "it's tight") + "\n", [
    "TKR_REASON",
  ]);
  assert.strictEqual(out.TKR_REASON, "it's tight");
});

test("the work badge round-trips, slash and all", { skip: !HAVE_BASH }, () => {
  // WRK bodies carry a "/" separator (SON/M). Nothing in the parser should
  // treat it specially, but the membership check expands a NAME into a glob
  // pattern, and it is worth one assertion that values are not walked
  // through the same path.
  const out = runParser(quoted("TKR_WORK_BADGE", "SON/M") + "\n", [
    "TKR_WORK_BADGE",
  ]);
  assert.strictEqual(out.TKR_WORK_BADGE, "SON/M");
});

test("an absent work badge reads as empty, not as a hollow WRK:", { skip: !HAVE_BASH }, () => {
  const out = runParser(quoted("TKR_WORK_BADGE", "") + "\n", ["TKR_WORK_BADGE"]);
  assert.strictEqual(out.TKR_WORK_BADGE, "");
});

test("a lone single quote round-trips", { skip: !HAVE_BASH }, () => {
  const out = runParser(quoted("TKR_REASON", "'") + "\n", ["TKR_REASON"]);
  assert.strictEqual(out.TKR_REASON, "'");
});

test("unquoted numeric fields are untouched", { skip: !HAVE_BASH }, () => {
  const out = runParser("TKR_TURN_COUNT=42\nTKR_CACHE_BUSTS=0\n", [
    "TKR_TURN_COUNT",
    "TKR_CACHE_BUSTS",
  ]);
  assert.strictEqual(out.TKR_TURN_COUNT, "42");
  assert.strictEqual(out.TKR_CACHE_BUSTS, "0");
});

// Run the parser against raw cache content and report whether a marker file
// was created — i.e. whether anything in the cache executed.
function executes(cacheContent, marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-sigfields-"));
  const cache = path.join(dir, "statusline-signals.cache");
  fs.writeFileSync(cache, cacheContent);
  fs.rmSync(marker, { force: true });
  const script = `
set -u
TKR_SIG_CACHE="$1"
${extractParser()}
`;
  try {
    spawnSync(BASH, ["-c", script, "bash", cache], { encoding: "utf8" });
    return fs.existsSync(marker);
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// SEC: the cache lives in the user-owned state dir, but the parser must still
// never execute its contents — that is the whole reason it is `declare` and
// not `eval`. Dequoting must not reintroduce evaluation.
test("command substitutions are never executed", { skip: !HAVE_BASH }, () => {
  const marker = path.join(os.tmpdir(), `tkr-sigfields-pwned-${process.pid}`);
  fs.rmSync(marker, { force: true });
  const out = runParser(
    quoted("TKR_REASON", `$(touch ${marker})`) +
      "\n" +
      quoted("TKR_DAILY_CLASS", "`touch " + marker + "`") +
      "\n",
    ["TKR_REASON", "TKR_DAILY_CLASS"],
  );
  assert.strictEqual(out.TKR_REASON, `$(touch ${marker})`);
  assert.strictEqual(out.TKR_DAILY_CLASS, "`touch " + marker + "`");
  assert.ok(!fs.existsSync(marker), "parser executed the cache contents");
});

test("non-TKR_ and malformed lines are ignored", { skip: !HAVE_BASH }, () => {
  const out = runParser(
    "PATH='/pwned'\ntkr_lower='x'\nnot a kv line\nTKR_REASON='ok'\n",
    ["TKR_REASON", "PATH"],
  );
  assert.strictEqual(out.TKR_REASON, "ok");
  assert.notStrictEqual(out.PATH, "/pwned");
});

test("CRLF line endings are tolerated", { skip: !HAVE_BASH }, () => {
  const out = runParser("TKR_ROUTE_EFFORT='high'\r\nTKR_TURN_COUNT=7\r\n", [
    "TKR_ROUTE_EFFORT",
    "TKR_TURN_COUNT",
  ]);
  assert.strictEqual(out.TKR_ROUTE_EFFORT, "high");
  assert.strictEqual(out.TKR_TURN_COUNT, "7");
});

test("a final line without a trailing newline is still parsed", { skip: !HAVE_BASH }, () => {
  const out = runParser("TKR_ROUTE_EFFORT='low'", ["TKR_ROUTE_EFFORT"]);
  assert.strictEqual(out.TKR_ROUTE_EFFORT, "low");
});

// SEC: hostile NAMES, not just hostile values. A trailing-`*` glob validates
// only the first character after the prefix, so `TKR_X[$(cmd)]=v` passed it —
// and bash evaluates an array subscript, command substitutions and all, while
// processing the assignment. `declare` then ran the command; redirecting its
// stderr does not help, because evaluation precedes rejection. Reproduced
// executing on bash 5.2.21 against both the original parser and the first
// version of this fix.
test("hostile variable names never execute", { skip: !HAVE_BASH }, (t) => {
  const marker = path.join(os.tmpdir(), `tkr-sigfields-name-${process.pid}`);
  const q = (s) => s.replace(/MARKER/g, marker);
  const cases = [
    ["array subscript with $()", q("TKR_X[$(touch MARKER)]=value")],
    ["array subscript with backticks", q("TKR_X[`touch MARKER`]=value")],
    ["array subscript, allowlisted base name", q("TKR_REASON[$(touch MARKER)]=v")],
    ["arithmetic subscript with $()", q("TKR_X[1+$(touch MARKER)]=v")],
    ["associative subscript", q('TKR_X["$(touch MARKER)"]=v')],
    ["$() in the bare name", q("TKR_$(touch MARKER)=v")],
    ["backticks in the bare name", q("TKR_`touch MARKER`=v")],
    ["semicolon then a command", q("TKR_X;touch MARKER=v")],
    ["space then a command", q("TKR_X touch MARKER=v")],
    ["newline-free compound", q("TKR_X=1 touch MARKER")],
  ];
  for (const [label, line] of cases) {
    t.assert.strictEqual(
      executes(line + "\n", marker),
      false,
      `parser executed the cache: ${label} — ${line}`,
    );
  }
});

test("hostile and unknown names are not assigned", { skip: !HAVE_BASH }, () => {
  const out = runParser(
    [
      "TKR_X[0]=subscripted", // valid subscript, still not a field
      "TKR_lower_case=x", // wrong case
      "TKR_=empty", // empty suffix
      "TKR_HAS-DASH=x", // non-identifier character
      "TKR_STATE_DIR=/evil", // script INPUT, read after this loop
      "TKR_SESSION_ID=evil", // script INPUT, exported to subprocesses
      "TKR_SIG_ALLOW= TKR_STATE_DIR ", // must not widen its own allowlist
      "TKR_NOT_A_FIELD=x", // well-formed but never emitted
      "TKR_REASON='ok'", // the control: this one must land
    ].join("\n") + "\n",
    [
      "TKR_REASON",
      "TKR_STATE_DIR",
      "TKR_SESSION_ID",
      "TKR_NOT_A_FIELD",
      "TKR_LOWER_CASE",
    ],
  );
  assert.strictEqual(out.TKR_REASON, "ok", "allowlisted field must still land");
  assert.notStrictEqual(out.TKR_STATE_DIR, "/evil");
  assert.notStrictEqual(out.TKR_SESSION_ID, "evil");
  assert.strictEqual(out.TKR_NOT_A_FIELD, "");
  assert.strictEqual(out.TKR_LOWER_CASE, "");
});

// The allowlist is only safe to hardcode because Go CI fails when
// printStatuslineFields gains a field that is missing from it
// (TestStatuslineFields_EmittedNamesAreAllowlisted). Assert the shell side of
// that contract is present and parseable, so the Go test cannot be silently
// pointed at nothing.
test("the allowlist is present and well-formed", { skip: !HAVE_BASH }, () => {
  const block = extractParser();
  const names = new Set();
  for (const m of block.matchAll(/TKR_SIG_ALLOW="[^"]*"/g)) {
    for (const n of m[0].matchAll(/\bTKR_[A-Z0-9_]+\b/g)) {
      if (n[0] !== "TKR_SIG_ALLOW") names.add(n[0]);
    }
  }
  assert.ok(names.size >= 30, `expected a populated allowlist, got ${names.size}`);
  for (const required of ["TKR_ROUTE_EFFORT", "TKR_RECOMMEND", "TKR_TURN_COUNT"]) {
    assert.ok(names.has(required), `allowlist is missing ${required}`);
  }
  assert.ok(!names.has("TKR_STATE_DIR"), "TKR_STATE_DIR must never be allowlisted");
  assert.ok(!names.has("TKR_SESSION_ID"), "TKR_SESSION_ID must never be allowlisted");
});
