// hooks/lib/skill-scrape.js
//
// #263 — static scrape of the installed Claude Code binary's bundled
// skill set. Writes skill-manifest.json (contract + consumer:
// manifestEntryFor() in ./skill-bundle.js), so that a FIRST invocation
// of a colon-less skill — the one case bundleFor() is structurally
// blind to, because extraction happens at skill-LOAD time, strictly
// after the PreToolUse gate has already decided — can still quote a
// real (scraped, not measured) size instead of going ungated.
//
// This module is read-only with respect to the CLI binary: the file is
// read into one Buffer and pattern-matched as bytes/text. It is NEVER
// executed. Recipe verified against the installed CC 2.1.227 binary
// (292,227,232 bytes, Bun single-file executable, one enormous
// minified-JS line) in a prior scrape session; see the "Repeatable-
// scraper anchors" section carried into this file's comments below.
//
// Repeatable-scraper anchors (verified recipe, CC 2.1.227) — REVISED
// after a real-binary validation pass (v1 of this module guessed
// bare-identifier `files:` shapes that do not occur in the real
// bundle; every tree-bearing site came back hasTree:false). The real
// shapes all route through an esbuild-style lazy module loader +
// export-binding pair:
//
//   function LOADER(){return Promise.resolve().then(() => (INIT(),EXPORTS))}
//   var EXPORTS={};dt(EXPORTS,{PROP:()=>VAR,...});var VAR;
//   var INIT=v(()=>{...; VAR={"path":CONTENT_IDENT,...}});
//
// and the register-fn call site's `files:` value references PROP, not
// VAR, directly:
//
//   1. Enumeration: the register function is aliased via
//      `registerBundledSkill:()=>ALIAS` — ALIAS is minifier-chosen and
//      MUST be derived per-binary, never hardcoded. Call sites are
//      `ALIAS({name:...})`.
//   2. userInvocable: `userInvocable:(!0|!1)` inside the object
//      literal; absent means true (`e.userInvocable??!0`). isHidden is
//      fully derived and carries no independent signal.
//   3. `files:` shapes, in the order this module tries them:
//      a. STANDARD: `()=>LOADER().then((e)=>e.PROP)` or the
//         index-by-loop-var form `()=>LOADER().then((n)=>n.PROP[e])`
//         (the kinds-loop case, point 5 below).
//      b. TRANSFORM: `()=>LOADER().then(FN)` — FN is a bare identifier
//         (not an arrow). FN's own function body is scanned for the
//         first `.PROP` access (e.g. claude-api's `Njv` reads
//         `e.SKILL_FILES`) to recover PROP, then resolution proceeds
//         as (a).
//      c. COMPOSITE: `async()=>{let[{PROP_A:x},{PROP_B:y}]=await
//         Promise.all([Promise.resolve().then(()=>(INIT_A(),EXPORTS_A)),
//         Promise.resolve().then(()=>(INIT_B(),EXPORTS_B))]);...}` —
//         each destructured PROP is resolved against its own inline
//         (INIT,EXPORTS) pair (no named LOADER function exists for
//         these), and the resulting byte counts are summed
//         (run-skill-generator: TEMPLATE_MD + RUN_EXAMPLE_FILES).
//      d. RUNTIME FETCH: none of the above match, or none of them
//         yield any ALL_CAPS-shaped `.PROP`/`{PROP:` reference at all
//         (e.g. artifact-capabilities touches only lowercase
//         properties). This is the ONLY shape allowed to report
//         hasTree:false with resolved:true — every other resolution
//         failure is a residual (resolved:false, complete:false).
//   4. PROP -> VAR: `dt(EXPORTS,{PROP:()=>VAR,...})` is searched first
//      (brace-matched, so multiple bindings on one line resolve to the
//      right VAR); if EXPORTS cannot be identified, a globally-unique
//      `PROP:()=>VAR` binding is accepted as a fallback. VAR is then
//      resolved, searching FORWARD from the `dt(EXPORTS,{...})` binding
//      offset (never from the call site — this repo's tree can sit
//      megabytes away from its call site, and forward-from-binding is
//      where the observed init-function body always places the actual
//      assignment):
//        - `VAR={...}` object literal -> the path table itself
//          (brace-matched, `"path":CONTENT_IDENT` pairs, also handling
//          the `wrapper(CONTENT_IDENT)` call form some entries use).
//        - `VAR="..."` / `` VAR=`...` `` literal -> decode
//          escape-aware (`\uXXXX` incl. surrogate pairs, `\x##`,
//          single-char escapes) and UTF-8 byte-count directly.
//        - `VAR=IDENT2` (bare identifier, not a call) -> up to two
//          levels of ident-alias chasing (run-skill-generator's
//          `TEMPLATE_MD:()=>hzv` where `hzv=$wh`).
//        - `VAR=someFn(...)` (call expression) -> the first template
//          literal >=500 bytes found after that call is used as a
//          content-source fallback.
//      Each `"path":CONTENT_IDENT` table entry is resolved the same
//      way (literal / alias / call-assigned), independent of the outer
//      VAR resolution's search origin.
//   5. Template loop (the `artifact-*` kinds): a call site whose name
//      is a template literal with exactly one interpolation
//      (`` `artifact-${e}` ``) and whose `files:` value indexes PROP by
//      that same loop variable (`n.SKILL_FILES[e]`). Once PROP -> VAR
//      resolves to an object literal, this module reads the kind names
//      directly off VAR's own top-level keys (each key's value is
//      itself a nested `"path":CONTENT_IDENT` table) rather than
//      separately locating the kind-name array — structurally
//      equivalent and one fewer anchor to keep in sync.
//
// Ambiguities carried forward from the verified scrape, NOT resolved
// by this module:
//   - claude-api measured ~869,864B here vs a prior transcript-verified
//     867,776B (+0.24%) — attributed to the SKILL_MODEL_VARS runtime
//     substitution (`tGl`) possibly having been measured
//     post-substitution in the prior figure. Not adjudicated; this
//     module reports what it tallies from the table, nothing more.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { stateDir } = require("./state-dir");
const { MANIFEST_FILE, MANIFEST_SCHEMA } = require("./skill-bundle");

const MIN_BINARY_BYTES = 50 * 1024 * 1024;
// Fallback threshold for the call-assigned-var content probe (point 4).
const CALL_ASSIGNED_MIN_BYTES = 500;

// ---------------------------------------------------------------------
// locateBinary
// ---------------------------------------------------------------------

// Never throws. Priority: env override (verbatim, for tests) -> first
// `where`/`which claude` hit that stats as a file >= MIN_BINARY_BYTES
// -> null.
function locateBinary(env) {
  const e = env || {};
  if (typeof e.TKR_CC_BINARY === "string" && e.TKR_CC_BINARY.length > 0) {
    return e.TKR_CC_BINARY;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  let out;
  try {
    out = execFileSync(finder, ["claude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      // Without this the scrape allocates a console per call. It runs from
      // a DETACHED session-start rescrape, so there is no console to
      // inherit and Windows makes a new visible one that steals focus —
      // multiplied by every concurrent session. Observed as a window
      // reading `[error 0x800700e8 when launching 'where claude']`, whose
      // ERROR_NO_DATA also made this return null, silently degrading the
      // #263 first-invocation gate to ungated.
      windowsHide: true,
      // Merge caller-supplied env (tests scrub PATH to force a miss)
      // over the real process env so ordinary callers passing
      // process.env verbatim are unaffected.
      env: { ...process.env, ...e },
    });
  } catch {
    return null;
  }
  const candidates = String(out)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const cand of candidates) {
    try {
      const st = fs.statSync(cand);
      if (st.isFile() && st.size >= MIN_BINARY_BYTES) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Pure-ish text scanning helpers (operate on the decoded source text)
// ---------------------------------------------------------------------

// True JS-source-aware "skip a string/template literal" — src[i] must
// be a quote char. Returns the index just past the closing quote.
// Template literals (`) are scanned for nested ${...} expressions,
// which themselves may contain further strings; those are balanced
// too, so a `}` inside a nested string never closes the interpolation
// early.
function skipStringLiteral(src, i) {
  const quote = src[i];
  i++;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        const cc = src[i];
        if (cc === "{") {
          depth++;
          i++;
        } else if (cc === "}") {
          depth--;
          i++;
        } else if (cc === '"' || cc === "'" || cc === "`") {
          i = skipStringLiteral(src, i);
        } else {
          i++;
        }
      }
      continue;
    }
    i++;
  }
  return i;
}

// src[openIdx] must be '{'. Returns the index of the matching '}', or
// -1 if unbalanced before EOF. String/template contents are never
// mistaken for structural braces.
function matchBraces(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Extracts the source text of one property value starting right after
// its `key:`, up to (not including) the next top-level comma or the
// enclosing close. Balances (), {}, [] and skips string/template
// literals so a comma inside any of those never ends the value early.
function extractValue(src, start) {
  let i = start;
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "}" || c === "]") {
      if (depth === 0) break;
      depth--;
      i++;
      continue;
    }
    if (c === "," && depth === 0) break;
    i++;
  }
  return src.slice(start, i);
}

function utf8LenForCodepoint(cp) {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

// Decodes the RAW text between quotes/backticks of a JS string or
// template literal (escape sequences still literal, e.g. the two
// characters `\` `n`) and returns the UTF-8 byte length of the decoded
// content. Handles \uXXXX (incl. \u{X...} and surrogate pairs -> one
// 4-byte codepoint), \x##, and single-character escapes (\n \t \r \\
// \' \" \` \0 etc, each one decoded ASCII byte). `${...}` template
// interpolations are skipped structurally (their runtime value is not
// literal text and is not counted) — see also the composite-var
// residual noted in the header comment.
function decodedByteLength(raw) {
  let bytes = 0;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c === "$" && raw[i + 1] === "{") {
      // Skip the interpolation expression structurally; do not count
      // its literal characters as content bytes.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const cc = raw[i];
        if (cc === "{") {
          depth++;
          i++;
        } else if (cc === "}") {
          depth--;
          i++;
        } else if (cc === '"' || cc === "'" || cc === "`") {
          i = skipStringLiteral(raw, i);
        } else {
          i++;
        }
      }
      continue;
    }
    if (c === "\\") {
      const next = raw[i + 1];
      if (next === "u") {
        if (raw[i + 2] === "{") {
          const close = raw.indexOf("}", i + 3);
          if (close === -1) {
            bytes += 1;
            i += 2;
            continue;
          }
          const cp = parseInt(raw.slice(i + 3, close), 16);
          bytes += Number.isFinite(cp) ? utf8LenForCodepoint(cp) : 1;
          i = close + 1;
          continue;
        }
        const hex = raw.slice(i + 2, i + 6);
        const cu = parseInt(hex, 16);
        if (
          cu >= 0xd800 &&
          cu <= 0xdbff &&
          raw[i + 6] === "\\" &&
          raw[i + 7] === "u"
        ) {
          const hex2 = raw.slice(i + 8, i + 12);
          const cu2 = parseInt(hex2, 16);
          if (cu2 >= 0xdc00 && cu2 <= 0xdfff) {
            const cp = (cu - 0xd800) * 0x400 + (cu2 - 0xdc00) + 0x10000;
            bytes += utf8LenForCodepoint(cp); // always 4
            i += 12;
            continue;
          }
        }
        bytes += Number.isFinite(cu) ? utf8LenForCodepoint(cu) : 1;
        i += 6;
        continue;
      }
      if (next === "x") {
        const cp = parseInt(raw.slice(i + 2, i + 4), 16);
        bytes += Number.isFinite(cp) ? utf8LenForCodepoint(cp) : 1;
        i += 4;
        continue;
      }
      // Single-character escape (\n \t \r \\ \' \" \` \0 \b \f ...):
      // the decoded value is always one ASCII byte.
      bytes += 1;
      i += 2;
      continue;
    }
    const cp = raw.codePointAt(i);
    bytes += utf8LenForCodepoint(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return bytes;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// regex.exec, but starting the search at `fromOffset` instead of 0.
// Always forces the global flag so `lastIndex` is honored.
function execFrom(src, pattern, fromOffset) {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  re.lastIndex = fromOffset;
  return re.exec(src);
}

// Resolves a VAR to either a table object literal or a byte length,
// searching FORWARD from `fromOffset` (the export-binding site, per
// the observed layout: the init function's assignment always follows
// its own `dt(EXPORTS,{...})` declaration, however far that pair sits
// from the register call site). Handles up to two levels of bare
// ident-to-ident aliasing (recipe point 4); an alias target is looked
// up from the START of the file, since the alias itself may point
// backward past `fromOffset` (observed in run-skill-generator).
// Returns { isTable:true, objText } | { isTable:false, bytes } | null.
function resolveVarContentOrTable(src, varIdent, fromOffset, depth) {
  // `{` belongs in the preceding-char class: a table assigned as the
  // FIRST statement of an init body (`v(()=>{TFILES={...}})`) is
  // preceded by `{`, and without it the table is invisible and the row
  // silently degrades to approxBytes:null.
  const tableRe = new RegExp("(?:^|[;,(={\\s])" + escapeRegExp(varIdent) + "\\s*=\\s*\\{");
  const tm = execFrom(src, tableRe, fromOffset);
  if (tm) {
    // The regex ends with the table's own `\{`; index it from the match
    // END. indexOf("{", tm.index) would find the PRECEDING-class brace
    // when the assignment opens an init body (`v(()=>{TFILES={...`),
    // brace-matching the whole body instead of the table.
    const openIdx = tm.index + tm[0].length - 1;
    const closeIdx = matchBraces(src, openIdx);
    if (closeIdx !== -1) {
      return { isTable: true, objText: src.slice(openIdx, closeIdx + 1) };
    }
  }
  if (depth >= 2) return null;

  const litRe = new RegExp("(?:^|[;,(={\\s])" + escapeRegExp(varIdent) + "\\s*=\\s*(\"|'|`)");
  const lm = execFrom(src, litRe, fromOffset);
  if (lm) {
    const quoteIdx = lm.index + lm[0].length - 1;
    const end = skipStringLiteral(src, quoteIdx);
    const raw = src.slice(quoteIdx + 1, end - 1);
    return { isTable: false, bytes: decodedByteLength(raw) };
  }

  const aliasRe = new RegExp(
    "(?:^|[;,(={\\s])" + escapeRegExp(varIdent) + "\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*[,;})]",
  );
  const am = execFrom(src, aliasRe, fromOffset);
  if (am) {
    // The alias target's own definition may sit anywhere, including
    // before fromOffset — search the whole file for it.
    return resolveVarContentOrTable(src, am[1], 0, depth + 1);
  }

  const callRe = new RegExp(
    "(?:^|[;,(={\\s])" + escapeRegExp(varIdent) + "\\s*=\\s*([A-Za-z_$][\\w$]*)\\(",
  );
  const cm = execFrom(src, callRe, fromOffset);
  if (cm) {
    // Recipe point 4, verbatim: for a call-assigned var (`VFv=Qyh()`)
    // the content lives after the CALLEE'S DEFINITION, never after the
    // assignment. The assignments sit in one cluster right before the
    // table (`xUv=S_h(),HUv=E_h(),...`), so probing forward from there
    // reads a NEIGHBOR'S content — observed as design-sync tallying 2x
    // (22 probes all landing on the same post-table literals) and
    // dataviz undercounting. Probe from the definition nearest the
    // assignment; the old post-assignment probe survives only as a
    // last resort when no definition is found at all.
    const defIdx = findCalleeDef(src, cm[1], cm.index);
    const probeFrom = defIdx !== null ? defIdx : cm.index + cm[0].length;
    let i = probeFrom;
    const n = src.length;
    const window = Math.min(n, i + 200000); // bounded probe
    while (i < window) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        const end = skipStringLiteral(src, i);
        const raw = src.slice(i + 1, end - 1);
        const len = decodedByteLength(raw);
        if (len >= CALL_ASSIGNED_MIN_BYTES) return { isTable: false, bytes: len };
        i = end;
        continue;
      }
      i++;
    }
  }
  return null;
}

// Definition site of a (minified) content function, nearest to nearIdx
// so a repeated minified name in another module scope never wins.
// Covers `function NAME(`, `NAME=function`, `NAME=(` / `NAME=()=>`,
// and wrapper forms with any callback argument — the observed real
// shape is a CommonJS factory: `NAME=ee(function(mod,exp){exp.exports=
// \`CONTENT\`...})`, whose content is exactly the first big literal
// after the definition (recipe point 4).
function findCalleeDef(src, callee, nearIdx) {
  const re = new RegExp(
    "function\\s+" +
      escapeRegExp(callee) +
      "\\s*\\(|(?:^|[;,({=\\s])" +
      escapeRegExp(callee) +
      "\\s*=\\s*(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*\\()",
    "g",
  );
  let best = null;
  for (const m of src.matchAll(re)) {
    if (best === null || Math.abs(m.index - nearIdx) < Math.abs(best - nearIdx)) {
      best = m.index;
    }
  }
  return best;
}

// Parses one `"path":VALUE` or `key:VALUE` table entry's VALUE token,
// resolving either a bare identifier or the `wrapper(VAR)` call form
// down to the inner identifier, then resolves that identifier's byte
// length. Returns null when unresolved (residual). Entry-level content
// idents are searched from the start of the file — they are
// content-only leaves (never module-export bindings), so there is no
// "far away module" concern the way there is for the outer VAR.
function resolveEntryBytes(src, valueText) {
  const trimmed = valueText.trim();
  let ident = null;
  const bareMatch = /^[A-Za-z_$][\w$]*$/.exec(trimmed);
  if (bareMatch) {
    ident = trimmed;
  } else {
    const wrapMatch = /^[A-Za-z_$][\w$]*\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(
      trimmed,
    );
    if (wrapMatch) ident = wrapMatch[1];
  }
  if (!ident) return null;
  const resolved = resolveVarContentOrTable(src, ident, 0, 0);
  if (!resolved) return null;
  if (resolved.isTable) return null; // a leaf entry resolving to a table is unexpected
  return resolved.bytes;
}

// ---------------------------------------------------------------------
// files: shape recognition + PROP -> VAR module-export resolution
// ---------------------------------------------------------------------

// function LOADER(){return Promise.resolve().then(() => (INIT(),EXPORTS))}
function findLoaderDef(src, loaderIdent) {
  const re = new RegExp(
    "function\\s+" +
      escapeRegExp(loaderIdent) +
      "\\s*\\(\\)\\s*\\{\\s*return\\s+Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\(\\)\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\)\\s*\\}",
  );
  const m = re.exec(src);
  if (m) return { init: m[1], exportsObj: m[2] };
  // Rare arrow-function form of the same loader shape.
  const re2 = new RegExp(
    "(?:^|[;,(={\\s])" +
      escapeRegExp(loaderIdent) +
      "\\s*=\\s*\\(\\)\\s*=>\\s*Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\(\\)\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\)",
  );
  const m2 = re2.exec(src);
  if (m2) return { init: m2[1], exportsObj: m2[2] };
  return null;
}

// `dt(EXPORTS,{PROP:()=>VAR,...})` -> { varIdent, offset } where offset
// is the START of the dt(...) call, used as the search origin for
// resolving VAR's actual content (always observed to follow this line).
function findExportBinding(src, exportsObjIdent, prop) {
  const re = new RegExp("dt\\(" + escapeRegExp(exportsObjIdent) + "\\s*,\\s*\\{");
  const m = re.exec(src);
  if (!m) return null;
  const openIdx = src.indexOf("{", m.index);
  const closeIdx = matchBraces(src, openIdx);
  if (closeIdx === -1) return null;
  const body = src.slice(openIdx, closeIdx + 1);
  const propRe = new RegExp(escapeRegExp(prop) + "\\s*:\\s*\\(\\)\\s*=>\\s*([A-Za-z_$][\\w$]*)");
  const pm = propRe.exec(body);
  if (!pm) return null;
  return { varIdent: pm[1], offset: m.index };
}

// PROP -> resolved VAR content/table, given an already-known EXPORTS
// object identifier (used directly by the composite shape, which
// inlines its (INIT,EXPORTS) pairs rather than naming a LOADER).
function resolveViaExportsObj(src, exportsObjIdent, prop) {
  const binding = findExportBinding(src, exportsObjIdent, prop);
  let varIdent = null;
  let searchFrom = 0;
  if (binding) {
    varIdent = binding.varIdent;
    searchFrom = binding.offset;
  } else {
    // Fallback: a globally-unique PROP:()=>VAR binding, per the recipe.
    const globalRe = new RegExp(
      escapeRegExp(prop) + "\\s*:\\s*\\(\\)\\s*=>\\s*([A-Za-z_$][\\w$]*)",
      "g",
    );
    const matches = [...src.matchAll(globalRe)];
    if (matches.length === 1) {
      varIdent = matches[0][1];
      searchFrom = matches[0].index;
    }
  }
  if (!varIdent) return null;
  return resolveVarContentOrTable(src, varIdent, searchFrom, 0);
}

// PROP -> resolved VAR content/table, via a named LOADER function.
function resolveExportedTable(src, loaderIdent, prop) {
  const loaderDef = findLoaderDef(src, loaderIdent);
  if (!loaderDef) return null;
  return resolveViaExportsObj(src, loaderDef.exportsObj, prop);
}

// function FN(param){...body...} -> body text (braces included), or null.
function findFunctionBody(src, fnIdent) {
  const re = new RegExp("function\\s+" + escapeRegExp(fnIdent) + "\\s*\\(");
  const m = re.exec(src);
  if (!m) return null;
  const parenOpen = src.indexOf("(", m.index);
  let i = parenOpen;
  let depth = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
    i++;
  }
  const braceOpen = src.indexOf("{", i);
  if (braceOpen === -1) return null;
  const braceClose = matchBraces(src, braceOpen);
  if (braceClose === -1) return null;
  return src.slice(braceOpen, braceClose + 1);
}

// ALL_CAPS-ish `.PROP` dot-accesses found in a text span, in order of
// first appearance, deduplicated.
function findAllCapsDotProps(text) {
  const props = [];
  const seen = new Set();
  const re = /\.([A-Z][A-Z0-9_]{2,})\b/g;
  let m;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      props.push(m[1]);
    }
  }
  return props;
}

// Classifies a `files:` value's source text into one of the four real
// shapes observed on the installed binary (recipe point 3). Never
// throws; an unrecognized shape falls through to 'runtime'.
function parseFilesShape(valueText) {
  const v = valueText.trim();

  const simple =
    /^\(\)\s*=>\s*([A-Za-z_$][\w$]*)\(\)\s*\.\s*then\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\2\.([A-Z][A-Z0-9_]{2,})(?:\[\s*([A-Za-z_$][\w$]*)\s*\])?\s*\)$/.exec(
      v,
    );
  if (simple) {
    return { kind: "simple", loader: simple[1], prop: simple[3], indexVar: simple[4] || null };
  }

  const transform = /^\(\)\s*=>\s*([A-Za-z_$][\w$]*)\(\)\s*\.\s*then\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(v);
  if (transform) {
    return { kind: "transform", loader: transform[1], transformFn: transform[2] };
  }

  if (/^async\s*\(\)\s*=>\s*\{/.test(v) && v.includes("Promise.all(")) {
    const propRe = /\{\s*([A-Z][A-Z0-9_]{2,})\s*:\s*[A-Za-z_$][\w$]*\s*\}/g;
    const props = [];
    let pm;
    while ((pm = propRe.exec(v))) props.push(pm[1]);
    const pairRe =
      /Promise\.resolve\(\)\.then\(\(\)\s*=>\s*\(\s*([A-Za-z_$][\w$]*)\(\)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g;
    const pairs = [];
    let cm;
    while ((cm = pairRe.exec(v))) pairs.push({ init: cm[1], exportsObj: cm[2] });
    if (props.length > 0 && props.length === pairs.length) {
      return {
        kind: "composite",
        members: props.map((p, idx) => ({ prop: p, exportsObj: pairs[idx].exportsObj })),
      };
    }
  }

  return { kind: "runtime" };
}

// Given the object-literal text of a `TABLE={...}` (braces included),
// parses top-level `"key":value` (or bare-ident key) entries. Returns
// an array of { key, valueText, isNestedObject }.
function parseObjectEntries(objText) {
  const entries = [];
  // objText[0] === '{', objText[last] === '}'
  let i = 1;
  const n = objText.length - 1; // exclude trailing '}'
  while (i < n) {
    // Skip whitespace/commas
    while (i < n && /[\s,]/.test(objText[i])) i++;
    if (i >= n) break;
    let key = null;
    if (objText[i] === '"' || objText[i] === "'" || objText[i] === "`") {
      const end = skipStringLiteral(objText, i);
      key = objText.slice(i + 1, end - 1);
      i = end;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(objText.slice(i));
      if (!m) break;
      key = m[0];
      i += m[0].length;
    }
    while (i < n && /\s/.test(objText[i])) i++;
    if (objText[i] !== ":") break;
    i++;
    while (i < n && /\s/.test(objText[i])) i++;
    const valueText = extractValue(objText, i);
    entries.push({
      key,
      valueText,
      isNestedObject: valueText.trim().startsWith("{"),
    });
    i += valueText.length;
  }
  return entries;
}

// Resolves a flat `"path":VAR` (or wrapper(VAR)) table object's text
// into a total byte tally. Returns { bytes, resolved } where resolved
// is false if any entry could not be resolved (bytes is then the
// partial sum, and the caller must treat this row as a residual).
function resolveFlatTable(src, tableObjText) {
  const entries = parseObjectEntries(tableObjText);
  let bytes = 0;
  let resolved = entries.length > 0;
  for (const e of entries) {
    const b = resolveEntryBytes(src, e.valueText);
    if (b === null) {
      resolved = false;
      continue;
    }
    bytes += b;
  }
  return { bytes, resolved, fileCount: entries.length };
}

// Locates `IDENT={` anywhere in src and returns its full object-literal
// text (braces included), or null.
function findObjectLiteral(src, ident) {
  const re = new RegExp("(?:^|[;,(={\\s])" + escapeRegExp(ident) + "\\s*=\\s*\\{");
  const m = re.exec(src);
  if (!m) return null;
  // Match-end brace, same reasoning as resolveVarContentOrTable.
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchBraces(src, openIdx);
  if (closeIdx === -1) return null;
  return src.slice(openIdx, closeIdx + 1);
}

// Parses one register-fn call site's object-literal text (braces
// included: "{name:...}") into one or more manifest rows. `src` is the
// full decoded binary text (needed to resolve table/var references
// that live outside the call site itself).
//
// Returns an array of { row, resolved } — resolved false means this
// row is a residual (contributes to manifest.complete === false).
function parseCallSite(objText, src) {
  const nameMatch = /^\{\s*name\s*:\s*/.exec(objText);
  if (!nameMatch) return [{ row: null, resolved: false }];
  let i = nameMatch[0].length;
  const c = objText[i];

  let nameKind; // "literal" | "template" | "ident"
  let nameLiteral = null;
  let nameTemplate = null;
  let nameIdent = null;

  if (c === '"' || c === "'" || c === "`") {
    const end = skipStringLiteral(objText, i);
    const raw = objText.slice(i + 1, end - 1);
    if (c === "`" && raw.includes("${")) {
      nameKind = "template";
      nameTemplate = raw;
    } else {
      nameKind = "literal";
      nameLiteral = raw; // plain skill names are ASCII; no escape decode needed
    }
  } else {
    const m = /^[A-Za-z_$][\w$]*/.exec(objText.slice(i));
    if (!m) return [{ row: null, resolved: false }];
    nameKind = "ident";
    nameIdent = m[0];
  }

  const userInvocableMatch = /userInvocable\s*:\s*(!0|!1)/.exec(objText);
  const userInvocable = userInvocableMatch ? userInvocableMatch[1] === "!0" : true;

  const filesIdx = objText.indexOf("files:");
  const gpcIdx = objText.indexOf("getPromptForCommand");

  // No files: property at all -> SKILL.md-only site.
  if (filesIdx === -1) {
    if (nameKind === "ident") {
      const resolvedName = resolveIdentString(src, nameIdent);
      return [
        {
          row: {
            name: resolvedName,
            hasTree: false,
            approxBytes: null,
            userInvocable,
          },
          resolved: resolvedName !== null,
        },
      ];
    }
    if (nameKind === "template") {
      // A SKILL.md-only site cannot be a kinds loop (no table to
      // enumerate kinds from) — unresolved by construction.
      return [{ row: null, resolved: false }];
    }
    return [
      {
        row: { name: nameLiteral, hasTree: false, approxBytes: null, userInvocable },
        resolved: true,
      },
    ];
  }

  // files: present before getPromptForCommand (or getPromptForCommand
  // absent) is the tree-candidate signal; files: appearing AFTER it
  // is not (property order says this is not the tree slot).
  if (gpcIdx !== -1 && filesIdx > gpcIdx) {
    const resolvedName =
      nameKind === "ident" ? resolveIdentString(src, nameIdent) : nameLiteral;
    return [
      {
        row: { name: resolvedName, hasTree: false, approxBytes: null, userInvocable },
        resolved: resolvedName != null,
      },
    ];
  }

  const valueStart = filesIdx + "files:".length;
  const filesValueText = extractValue(objText, valueStart).trim();

  const resolveSimpleName = () => {
    if (nameKind === "ident") return resolveIdentString(src, nameIdent);
    return nameLiteral;
  };

  const shape = parseFilesShape(filesValueText);

  // Kinds-loop case: template name + a `PROP[VAR]` index expression
  // whose VAR matches the template's single interpolation. Requires
  // the 'simple' shape with an indexVar.
  if (nameKind === "template") {
    const interp = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(nameTemplate);
    if (!interp || shape.kind !== "simple" || shape.indexVar !== interp[1]) {
      return [{ row: null, resolved: false }];
    }
    const resolvedVar = resolveExportedTable(src, shape.loader, shape.prop);
    if (!resolvedVar || !resolvedVar.isTable) {
      return [{ row: null, resolved: false }];
    }
    const kindEntries = parseObjectEntries(resolvedVar.objText);
    const templateParts = nameTemplate.split(/\$\{\s*[A-Za-z_$][\w$]*\s*\}/);
    const prefix = templateParts[0] || "";
    const suffix = templateParts[1] || "";
    const out = [];
    for (const ke of kindEntries) {
      const kindName = prefix + ke.key + suffix;
      if (!ke.isNestedObject) {
        out.push({ row: { name: kindName, hasTree: false, approxBytes: null, userInvocable }, resolved: false });
        continue;
      }
      const { bytes, resolved } = resolveFlatTable(src, ke.valueText.trim());
      out.push({
        row: {
          name: kindName,
          hasTree: true,
          approxBytes: resolved ? bytes : null,
          userInvocable,
        },
        resolved,
      });
    }
    return out;
  }

  const name = resolveSimpleName();

  // Runtime fetch: the ONLY shape allowed to report hasTree:false with
  // resolved:true — no ALL_CAPS export property was found anywhere in
  // the files: value (or its transform target's body), so there is
  // nothing that plausibly names an embedded tree.
  if (shape.kind === "runtime") {
    return [{ row: { name, hasTree: false, approxBytes: null, userInvocable }, resolved: name != null }];
  }

  if (shape.kind === "simple") {
    const resolvedVar = resolveExportedTable(src, shape.loader, shape.prop);
    if (!resolvedVar) {
      return [{ row: { name, hasTree: true, approxBytes: null, userInvocable }, resolved: false }];
    }
    if (resolvedVar.isTable) {
      const { bytes, resolved } = resolveFlatTable(src, resolvedVar.objText);
      return [
        {
          row: { name, hasTree: true, approxBytes: resolved ? bytes : null, userInvocable },
          resolved: resolved && name != null,
        },
      ];
    }
    return [{ row: { name, hasTree: true, approxBytes: resolvedVar.bytes, userInvocable }, resolved: name != null }];
  }

  if (shape.kind === "transform") {
    const fnBody = findFunctionBody(src, shape.transformFn);
    const props = fnBody ? findAllCapsDotProps(fnBody) : [];
    if (props.length === 0) {
      // The transform touches nothing ALL_CAPS-shaped -> behaves like
      // a runtime fetch from this module's perspective.
      return [{ row: { name, hasTree: false, approxBytes: null, userInvocable }, resolved: name != null }];
    }
    const resolvedVar = resolveExportedTable(src, shape.loader, props[0]);
    if (!resolvedVar) {
      return [{ row: { name, hasTree: true, approxBytes: null, userInvocable }, resolved: false }];
    }
    if (resolvedVar.isTable) {
      const { bytes, resolved } = resolveFlatTable(src, resolvedVar.objText);
      return [
        {
          row: { name, hasTree: true, approxBytes: resolved ? bytes : null, userInvocable },
          resolved: resolved && name != null,
        },
      ];
    }
    return [{ row: { name, hasTree: true, approxBytes: resolvedVar.bytes, userInvocable }, resolved: name != null }];
  }

  if (shape.kind === "composite") {
    let total = 0;
    let allResolved = name != null;
    for (const member of shape.members) {
      const resolvedVar = resolveViaExportsObj(src, member.exportsObj, member.prop);
      if (!resolvedVar) {
        allResolved = false;
        continue;
      }
      if (resolvedVar.isTable) {
        const { bytes, resolved } = resolveFlatTable(src, resolvedVar.objText);
        if (!resolved) allResolved = false;
        total += bytes;
      } else {
        total += resolvedVar.bytes;
      }
    }
    return [
      {
        row: { name, hasTree: true, approxBytes: allResolved ? total : null, userInvocable },
        resolved: allResolved,
      },
    ];
  }

  // Unreachable: parseFilesShape only returns the four kinds above.
  return [{ row: { name, hasTree: false, approxBytes: null, userInvocable }, resolved: false }];
}

function resolveIdentString(src, ident) {
  const re = new RegExp(
    "(?:^|[;,(={\\s])" + escapeRegExp(ident) + "\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)",
  );
  const m = re.exec(src);
  if (!m) return null;
  const lit = m[1];
  return lit.slice(1, -1);
}

function findRegisterAlias(src) {
  const m = /registerBundledSkill\s*:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/.exec(src);
  return m ? m[1] : null;
}

function findCallSites(src, alias) {
  const marker = alias + "({name:";
  const sites = [];
  let idx = 0;
  while (true) {
    idx = src.indexOf(marker, idx);
    if (idx === -1) break;
    const objStart = idx + alias.length + 1; // position of '{'
    const objEnd = matchBraces(src, objStart);
    if (objEnd === -1) {
      idx += marker.length;
      continue;
    }
    sites.push(src.slice(objStart, objEnd + 1));
    idx = objEnd + 1;
  }
  return sites;
}

function extractVersion(src) {
  const m = /VERSION\s*:\s*"(\d+\.\d+\.\d+)"/.exec(src);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------
// scrapeManifest
// ---------------------------------------------------------------------

// Reads binaryPath into one Buffer (never executes it) and applies the
// recipe above. Returns the manifest object described in
// hooks/CLAUDE.md § skill-manifest.json. complete is true only when
// every register call site parsed AND every tree table byte-tallied
// cleanly; any residual leaves complete:false with the rows that DID
// resolve still present — that is correct partial behavior, not an
// error.
function scrapeManifest(binaryPath) {
  const st = fs.statSync(binaryPath);
  const buf = fs.readFileSync(binaryPath);
  // The minified JS structure (braces, quotes, escape sequences) is
  // pure ASCII regardless of what UTF-8 content the string literals
  // encode; "latin1" gives a 1:1 byte<->char mapping so every index
  // computed here corresponds exactly to a byte offset in the file,
  // and escape sequences (`\uXXXX` etc.) are decoded explicitly by
  // decodedByteLength rather than by the JS engine.
  const src = buf.toString("latin1");

  const ccVersion = extractVersion(src);
  const alias = findRegisterAlias(src);

  const skills = [];
  let complete = alias !== null && ccVersion !== null;

  if (alias) {
    const sites = findCallSites(src, alias);
    if (sites.length === 0) complete = false;
    for (const siteText of sites) {
      const results = parseCallSite(siteText, src);
      for (const r of results) {
        if (!r.resolved) complete = false;
        if (r.row && r.row.name != null) skills.push(r.row);
      }
    }
  }

  return {
    schema: MANIFEST_SCHEMA,
    ccVersion,
    binaryPath,
    binarySize: st.size,
    binaryMtimeMs: Math.floor(st.mtimeMs),
    scrapedAt: new Date().toISOString(),
    complete,
    skills,
  };
}

// ---------------------------------------------------------------------
// writeManifest
// ---------------------------------------------------------------------

// Atomic write (tmp file + renameSync) to <stateDir>/skill-manifest.json.
// Best-effort: any failure is swallowed, matching the rest of this
// hook library (a missed write costs one hour of ungated first
// invocations, never correctness).
function writeManifest(manifest, envOpt) {
  try {
    const dir =
      envOpt && typeof envOpt.TKR_STATE_DIR === "string" && envOpt.TKR_STATE_DIR
        ? envOpt.TKR_STATE_DIR
        : stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, MANIFEST_FILE);
    const tmp = target + `.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    fs.renameSync(tmp, target);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------

function runMain(argv, env) {
  const binaryPath = (argv && argv[2]) || locateBinary(env || process.env);
  if (!binaryPath) {
    process.stderr.write("skill-scrape: no Claude Code binary found\n");
    return;
  }
  let manifest;
  try {
    manifest = scrapeManifest(binaryPath);
  } catch (err) {
    process.stderr.write(`skill-scrape: scrape failed: ${err && err.message}\n`);
    return;
  }
  writeManifest(manifest, env);
  process.stderr.write(
    `skill-scrape: ${manifest.skills.length} skills, complete=${manifest.complete}, ccVersion=${manifest.ccVersion} -> ${path.join(
      (env && env.TKR_STATE_DIR) || stateDir(),
      MANIFEST_FILE,
    )}\n`,
  );
}

if (require.main === module) {
  runMain(process.argv, process.env);
}

module.exports = {
  locateBinary,
  scrapeManifest,
  writeManifest,
  runMain,
  // exported for test-level whitebox checks
  decodedByteLength,
  matchBraces,
  extractValue,
  parseObjectEntries,
  parseFilesShape,
  findLoaderDef,
  findExportBinding,
  resolveExportedTable,
  resolveViaExportsObj,
  resolveVarContentOrTable,
  findFunctionBody,
  findAllCapsDotProps,
};
