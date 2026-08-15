// Bundled-skill payload measurement + gate policy (INV-095).
//
// Claude Code ships "bundled" skills inside the CLI binary and extracts
// their reference trees to <tmp>/claude/bundled-skills/<ccver>/<hash>/<skill>/.
// On invocation the ENTIRE tree (minus some language-specific subtrees)
// is injected as a user-role text block — NOT as the Skill tool_result,
// which is ~27 chars. That block never passes through PostToolUse, so
// no tkr filter can see it, and it lands in the cached prefix where it
// is re-read every subsequent turn.
//
// Measured case: `claude-api`, verified against the transcript block
// byte for byte. The 65-file tree is 867,776 bytes; 32 files shipped
// (all 26 of shared/, all 6 of typescript/ — the detected language) and
// 33 files did not (the other seven languages, 238,495 bytes). Each
// shipped file arrived WHOLE and contiguous, wrapped as
// `<doc path="...">` — nothing is chunked or truncated on this path.
// The `args` reach the payload only as a trailing "## User Request"
// line; they scope nothing.
//
// So the tree bounds the FILE-BODY portion, and only that. The payload
// also carries ~70K chars that are not in the extracted tree at all:
// SKILL.md itself (which ships inside the CLI binary, not on disk),
// trailing usage guidance, and the per-file wrappers. Here the 238K of
// skipped languages more than covered it — 699,096 chars injected
// against an 867,776-byte tree — but that is arithmetic, not a
// guarantee. Do not describe the tree as an upper bound on the payload.
//
// See costRange() for why this module never reports a point estimate.
//
// This module answers two questions and nothing else:
//   1. How big is the tree behind skill X?  (I/O section)
//   2. Given that size, what should the hook do?  (pure section)
//
// The gate is threshold-based, not name-based: `claude-api` is merely
// the skill that trips it today.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { stateDir } = require("./state-dir");

const BUNDLE_ROOT = ["claude", "bundled-skills"];
const CACHE_FILE = "skill-bundles.json";
const CACHE_SCHEMA = 2; // v2: entries carry raw bytes alongside tokens (#218)
// A miss is cached ONLY for namespaced skills (tkr:*, blueprint:*), so
// plugin skills don't pay a temp-dir walk on every dispatch. A colon-less
// name never trusts a negative entry — see looksBundled() and bundleFor().
// Short TTL so a CLI upgrade that adds a bundle is picked up the same day
// rather than never.
const MISS_TTL_MS = 60 * 60 * 1000;
const DEFAULT_THRESHOLD_TOKENS = 25_000;
// Redirect index is itself context. Cap it and say so when truncating —
// a silent cap reads as "that's the whole tree" when it isn't.
const MAX_INDEX_ROWS = 24;
// #263 — binary-scrape manifest: what the installed CLI would extract,
// known ahead of the FIRST invocation (the one bundleFor cannot see).
// Written out of the hot path by the scraper; read-only here.
const MANIFEST_FILE = "skill-manifest.json";
const MANIFEST_SCHEMA = 1;

// ---------------------------------------------------------------------
// Pure section — no I/O, no env mutation. Safe to unit-test directly.
// ---------------------------------------------------------------------

// off | warn | ask | deny.
//
// Default is `ask`, set from measurement rather than taste: across 314
// sessions / 156 measured Skill payloads the gate fires on 5 of them
// (3.2%), all one skill. Five prompts in 314 sessions is a targeted
// interruption, not prompt fatigue — and `warn` gives the user no
// decision point at all, since `systemMessage` renders only after the
// hook has already returned and the payload lands regardless.
//
// An ABSENT setting means `ask`; a MALFORMED one degrades to `warn` —
// the weakest acting mode, not the strongest. A typo must never
// interrupt a call, and it must never be the reason one was blocked.
// (Same split as work routing: absent means advisory, malformed
// degrades explicitly.)
const DEFAULT_MODE = "ask";
const MODES = ["off", "warn", "ask", "deny"];

function gateMode(env) {
  const e = env || {};
  if (e.TKR_HOOKS_DISABLED === "1") return "off";
  if (e.TKR_SKILL_GATE_DISABLED === "1") return "off";
  const raw = String(e.TKR_SKILL_GATE == null ? "" : e.TKR_SKILL_GATE)
    .trim()
    .toLowerCase();
  if (raw === "") return DEFAULT_MODE;
  if (MODES.includes(raw)) return raw;
  return "warn";
}

function thresholdTokens(env) {
  const raw = Number((env || {}).TKR_SKILL_GATE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_TOKENS;
}

// ctx: { env, source, bundleTokens }
// Returns { mode, action, threshold } where action is none|warn|ask|deny.
function gate(ctx) {
  const c = ctx || {};
  const mode = gateMode(c.env);
  const threshold = thresholdTokens(c.env);
  const out = { mode, action: "none", threshold };
  if (mode === "off") return out;
  // No bundle (plugin skill, or CLI that doesn't extract one) — nothing
  // measurable, nothing to say.
  if (typeof c.bundleTokens !== "number" || c.bundleTokens <= 0) return out;
  if (c.bundleTokens < threshold) return out;
  // An explicit `/claude-api` is the user asking for the full reference.
  // Gating that would break the escape hatch the denial itself points at.
  if (c.source === "manual") return out;
  // Every remaining mode names its own action.
  out.action = mode;
  return out;
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtK(n) {
  return `${Math.round(n / 1000)}K`;
}

// bytes/4 is this file's stored-size divisor — deliberately the low end of the
// range below, NOT tkr's canonical estimator, which #218 calibrated to
// bytes/2.4 (internal/tracking/tracker.go, EstimateTokens).
// On this content class bytes/4 is wrong in both directions at once, and the
// two errors do not cancel:
//
//   - the TREE overstates the PAYLOAD — language subtrees are skipped
//     at injection time (33 of 65 files, 27% of the measured claude-api
//     tree by bytes), partly offset by ~70K chars of framing that is not
//     in the tree at all;
//   - bytes/4 UNDERSTATES the tokens — model ids, JSON, code fences and
//     hyphenated identifiers tokenize nearer 2.75 chars/token. Measured
//     directly, without going through the tree: the injected block was
//     699,096 chars and was charged ~253,800 tokens, i.e. 2.754
//     chars/token, so bytes/4 predicted ~45% fewer tokens than the API
//     billed.
//
// Reporting a single number would be false precision in whichever
// direction happened to dominate. So the gate reports a RANGE: the tree
// at 4 chars/token as the low end, the same tree at 2.75 as the high
// end. The measured claude-api injection (~250K) sits inside it.
//
// That investigation ran (#218): tracking.EstimateTokens is now calibrated
// to 2.4 bytes/token from 315 transcript-attributed blocks, and the
// skill-bundle content class itself measured 2.73 (n=4, p25-p75 2.70-2.76)
// — so 2.75 here is class-backed, no longer a single sample. This file's
// stored tokens deliberately stay bytes/4: they are the range's low end by
// construction (see measureBundle).
const DENSE_CHARS_PER_TOKEN = 2.75;

function costRange(treeTokens) {
  const lo = treeTokens;
  const hi = Math.round((treeTokens * 4) / DENSE_CHARS_PER_TOKEN);
  return { lo, hi, text: `~${fmtK(lo)}-${fmtK(hi)} tokens` };
}

// The on-disk index, capped. Shared by the deny and ask texts: both are
// only actionable if the reader can see which file holds what.
function indexLines(bundle) {
  const rows = (bundle.index || []).slice(0, MAX_INDEX_ROWS);
  const hidden = (bundle.index || []).length - rows.length;
  const lines = rows.map(([rel, tok]) => `  ${String(tok).padStart(7)}t  ${rel}`);
  if (hidden > 0) {
    lines.push(`  ... ${hidden} smaller files not listed (full tree at the path above)`);
  }
  return lines;
}

// One sentence, used wherever the cost is stated. Says "estimate" out
// loud, because both bounds are modelled and neither was measured on
// this particular skill.
//
// When the resolved tree came from an older CLI version than the newest
// one present on disk (#219 — several versions coexist in the bundle
// root, and the hook is never told which one is about to load), the
// measurement is stale by construction: append a visible note rather
// than presenting it as current.
function costSentence(bundle) {
  const r = costRange(bundle.tokens);
  let sentence =
    `${r.text} (${bundle.files}-file tree; estimated, not measured — ` +
    `bytes/4 to bytes/2.75, and dense technical text lands near the high end)`;
  if (bundle.crossVersion) {
    sentence += `; measured from CLI ${bundle.version}, not the newest version present — treat as a lower bound`;
  }
  return sentence;
}

// The text handed back on a deny. Must be actionable on its own: the
// model has no other way to learn the tree exists or where it lives.
function buildRedirect(skill, bundle) {
  const lines = [
    `tkr gate: "${skill}" auto-invocation blocked — it would inject`,
    `${costSentence(bundle)}`,
    `as one un-filterable block that stays in the cached prefix for the rest of`,
    `the session. The skill's args do not scope that payload. Files ship whole,`,
    `never chunked; language subtrees may be skipped, shared/ never is.`,
    ``,
    `Read only the file you need, directly:`,
    `  ${bundle.dir}`,
    ``,
    ...indexLines(bundle),
    ``,
    `Use tkr_read (mode=map first if unsure) or Grep across that directory.`,
    `If the whole reference really is needed, the USER can invoke it`,
    `explicitly as /${skill} — a manual invocation is never gated.`,
    `Kill switch: TKR_SKILL_GATE=off`,
  ];
  return lines.join("\n");
}

// Ask-mode text — the default. Goes to `permissionDecisionReason`, so it
// is read by the human deciding and by the model if the human declines.
// It therefore carries the same on-disk index as the deny text: a "no"
// must leave the model able to act, not merely blocked.
function buildAskReason(skill, bundle) {
  const lines = [
    `tkr gate: "${skill}" was auto-invoked (you did not type it). Its bundled`,
    `reference tree is ${costSentence(bundle)},`,
    `injected as one un-filterable block that then stays in the cached prefix`,
    `for the rest of the session. The skill's args do not scope it.`,
    ``,
    `  Deny  — read only what is needed from the tree on disk:`,
    `          ${bundle.dir}`,
    `  Allow — the whole tree lands.`,
    ``,
    ...indexLines(bundle),
    ``,
    `Stop being asked: TKR_SKILL_GATE=warn (notify only) or =off (silent).`,
    `TKR_SKILL_GATE=deny blocks without asking. /${skill} is never gated.`,
  ];
  return lines.join("\n");
}

// Warn-mode text. Goes to `systemMessage`, which renders to the user and
// costs zero model context — the payload is landing anyway, so spending
// tokens to narrate it would make the problem worse.
function buildWarning(skill, bundle, threshold) {
  const r = costRange(bundle.tokens);
  const staleNote = bundle.crossVersion ? ` (measured from CLI ${bundle.version}, not the newest present)` : "";
  return (
    `tkr: "${skill}" auto-invoked — injecting an estimated ${r.text}${staleNote} ` +
    `(${bundle.files}-file tree, threshold ${fmt(threshold)}). ` +
    `Not filterable, stays in the cached prefix. ` +
    `TKR_SKILL_GATE=ask to be asked first, =deny to block; /${skill} always passes.`
  );
}

// ---------------------------------------------------------------------
// I/O section
// ---------------------------------------------------------------------

function bundleRootDir() {
  return path.join(os.tmpdir(), ...BUNDLE_ROOT);
}

// True if `dir` (or any subdirectory) contains at least one file.
// Content gets pruned out from under these trees while the directory
// itself lingers (9 of 13 claude-api dirs observed empty on one box);
// an empty directory must never be treated as a resolved bundle — see
// resolveBundleDir (#219).
function dirHasFile(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of ents) {
    if (e.isFile()) return true;
    if (e.isDirectory() && dirHasFile(path.join(dir, e.name))) return true;
  }
  return false;
}

// Numeric dot-separated compare ("2.1.9" < "2.1.10"); a non-numeric
// segment sorts as -1 (below any real release) rather than throwing.
function compareVersions(a, b) {
  const pa = String(a).split(".").map((p) => (Number.isFinite(Number(p)) && p !== "" ? Number(p) : -1));
  const pb = String(b).split(".").map((p) => (Number.isFinite(Number(p)) && p !== "" ? Number(p) : -1));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// The highest-semver version directory present under root, regardless
// of whether it contains THIS skill. Used to flag a resolved bundle as
// cross-version when it came from an older one (#219) — the hook is
// never told which CLI version is about to load, so this is the best
// available proxy for "is this measurement stale".
function newestVersionPresent(root) {
  let versions;
  try {
    versions = fs.readdirSync(root);
  } catch {
    return null;
  }
  let best = null;
  for (const v of versions) {
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

// <tmp>/claude/bundled-skills/<ccver>/<hash>/<skill>. Several CLI
// versions coexist. Two rules, in order (#219):
//   1. Prefer the highest-semver version that has a NON-EMPTY tree for
//      this skill, falling back to older versions when the newest one
//      has none. An empty directory (content pruned, directory left
//      behind) is never a match — walking mtime alone let a stale empty
//      dir win the "newest wins" race and report a silent zero.
//   2. Within one version, several hash dirs can coexist (a re-extract
//      of the same version); the newest-mtime non-empty one wins.
// Returns { dir, version } or null.
function resolveBundleDir(skill, rootOverride) {
  const root = rootOverride || bundleRootDir();
  let versions;
  try {
    versions = fs.readdirSync(root);
  } catch {
    return null;
  }
  versions.sort((a, b) => compareVersions(b, a));
  for (const v of versions) {
    let hashes;
    try {
      hashes = fs.readdirSync(path.join(root, v));
    } catch {
      continue;
    }
    let best = null;
    let bestMtime = -1;
    for (const h of hashes) {
      const cand = path.join(root, v, h, skill);
      let st;
      try {
        st = fs.statSync(cand);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.mtimeMs <= bestMtime) continue;
      if (!dirHasFile(cand)) continue;
      bestMtime = st.mtimeMs;
      best = cand;
    }
    if (best) return { dir: best, version: v };
  }
  return null;
}

// stat only — never reads file contents. Token estimate stays bytes/4 —
// deliberately NOT the calibrated 2.4 divisor tracking.EstimateTokens now
// uses (#218): costRange() reconstructs bytes from these tokens (t*4) for
// its dense upper end, and the ask/deny texts present [bytes/4, bytes/2.75]
// as an explicit range whose low end is bytes/4 by construction. Raw bytes
// are measured alongside so the ledger row is re-derivable under any
// divisor.
function measureBundle(dir) {
  const index = [];
  let tokens = 0;
  let bytes = 0;
  let files = 0;
  const walk = (d, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, r);
        continue;
      }
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const t = Math.floor(st.size / 4);
      tokens += t;
      bytes += st.size;
      files += 1;
      index.push([r, t]);
    }
  };
  walk(dir, "");
  index.sort((a, b) => b[1] - a[1]);
  return { dir, tokens, bytes, files, index };
}

function cachePath() {
  return path.join(stateDir(), CACHE_FILE);
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (raw && raw.schema === CACHE_SCHEMA && raw.entries) return raw;
  } catch {
    /* absent or corrupt — treat as empty */
  }
  return { schema: CACHE_SCHEMA, entries: {} };
}

function writeCache(cache) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cache));
  } catch {
    /* best-effort: a cold cache costs latency, never correctness */
  }
}

// version is undefined for a pre-#219 cache entry (schema unchanged —
// this is an additive field, not a bump) or a rootOverride/root layout
// this hook couldn't parse; either way "unknown version" must never
// read as "cross-version", so an undefined version reports false.
function crossVersionFor(version, rootOverride) {
  if (!version) return false;
  const newest = newestVersionPresent(rootOverride || bundleRootDir());
  if (!newest) return false;
  return compareVersions(version, newest) < 0;
}

// A guess, deliberately: plugin and user skills are namespaced
// (`tkr:handoff`, `blueprint:design`) and structurally cannot be in the
// CLI's compiled-in set, so a colon is a reliable NEGATIVE. A colon-less
// name is merely POSSIBLY bundled. Being wrong costs one extra walk of
// the bundle root per dispatch (measured 1.9ms p50 / 3.2ms max against
// 17 version dirs) and never a wrong gate decision.
function looksBundled(skill) {
  return typeof skill === "string" && skill.length > 0 && !skill.includes(":");
}

// Returns { dir, tokens, files, index, version, crossVersion } or null
// when the skill has no bundled tree. A positive result is cached; a
// miss is cached only for namespaced skills (see MISS_TTL_MS). A
// colon-less name neither trusts nor writes a negative entry: this hook
// runs BEFORE the tool, and a bundled skill extracts its own tree at
// skill-load time, so the miss the FIRST invocation records would
// otherwise mask the tree that same invocation puts on disk — leaving
// the gate blind for MISS_TTL_MS of dispatches instead of exactly one
// (#219). crossVersion is recomputed on every call (one extra
// readdirSync of the bundle root, not a tree walk) rather than cached,
// because a version can be extracted after this skill's entry was
// written, at which point a cached answer would go stale silently.
function bundleFor(skill, opts) {
  const o = opts || {};
  const now = typeof o.now === "number" ? o.now : Date.now();
  const cache = readCache();
  const hit = cache.entries[skill];
  if (hit) {
    if (hit.dir === null && !looksBundled(skill) && now - hit.ts < MISS_TTL_MS) return null;
    // A positive entry is only trusted while the directory it named still
    // exists; a CLI upgrade relocates it under a new version+hash.
    if (hit.dir && fs.existsSync(hit.dir)) {
      return {
        dir: hit.dir,
        tokens: hit.tokens,
        bytes: hit.bytes,
        files: hit.files,
        index: hit.index || [],
        version: hit.version,
        crossVersion: crossVersionFor(hit.version, o.root),
      };
    }
  }
  const resolved = resolveBundleDir(skill, o.root);
  if (!resolved) {
    if (!looksBundled(skill)) {
      cache.entries[skill] = { dir: null, ts: now };
      writeCache(cache);
    }
    return null;
  }
  const m = measureBundle(resolved.dir);
  cache.entries[skill] = {
    dir: m.dir,
    tokens: m.tokens,
    bytes: m.bytes,
    files: m.files,
    index: m.index,
    version: resolved.version,
    ts: now,
  };
  writeCache(cache);
  return { ...m, version: resolved.version, crossVersion: crossVersionFor(resolved.version, o.root) };
}

// #263 — consult the scrape manifest for a colon-less name whose bundle
// resolution came up null: the one case bundleFor is structurally blind to
// (first invocation on this box — extraction happens at skill-LOAD time,
// after this hook has decided). Pure lookup: returns the scraped row as-is;
// hasTree/threshold policy belongs to the gate wiring. Every failure means
// null — absent, corrupt, wrong schema, incomplete scrape, a binary that
// changed since the scrape (or one we cannot stat), or a version dir newer
// than the scraped ccVersion already extracted on disk. Null always
// degrades to pre-manifest behavior (first invocation ungated), never to a
// block.
function manifestEntryFor(skill, opts) {
  if (!looksBundled(skill)) return null;
  const o = opts || {};
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(stateDir(), MANIFEST_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!m || m.schema !== MANIFEST_SCHEMA || m.complete !== true || !Array.isArray(m.skills)) {
    return null;
  }
  // The manifest describes ONE exact binary. A size or mtime mismatch —
  // or a binary we cannot stat — means a different CLI than the one
  // scraped, so its sizes are fiction.
  if (typeof m.binaryPath !== "string" || m.binaryPath === "") return null;
  let st;
  try {
    st = fs.statSync(m.binaryPath);
  } catch {
    return null;
  }
  if (st.size !== m.binarySize || Math.floor(st.mtimeMs) !== m.binaryMtimeMs) return null;
  // Zero-cost cross-check: an extracted version dir newer than the scraped
  // version means the CLI moved on even if the path we stat'd did not.
  const newest = newestVersionPresent(o.root || bundleRootDir());
  if (newest && typeof m.ccVersion === "string" && compareVersions(newest, m.ccVersion) > 0) {
    return null;
  }
  const row = m.skills.find((s) => s && s.name === skill);
  return row || null;
}

// Ask text for a FIRST invocation: nothing is on disk yet, so the size is
// the scraper's estimate and there is no file index to offer. Same range
// discipline as every other gate text — never a point estimate.
function buildFirstInvocationAskReason(skill, entry) {
  const r = costRange(Math.floor(entry.approxBytes / 4));
  const lines = [
    `tkr gate: "${skill}" was auto-invoked (you did not type it). This is its`,
    `first invocation on this machine — no reference tree is on disk yet, but`,
    `the CLI-binary scrape manifest says it bundles ~${fmt(entry.approxBytes)} bytes:`,
    `an estimated ${r.text} (scraped, not measured), injected as one`,
    `un-filterable block that then stays in the cached prefix for the rest of`,
    `the session. The skill's args do not scope it.`,
    ``,
    `  Deny  — nothing extracts; proceed without the reference, or the USER`,
    `          can invoke /${skill} explicitly — manual is never gated.`,
    `  Allow — the whole payload lands (and the tree extracts for next time,`,
    `          so later invocations get a measured gate).`,
    ``,
    `Stop being asked: TKR_SKILL_GATE=warn (notify only) or =off (silent).`,
    `TKR_SKILL_GATE=deny blocks without asking.`,
  ];
  return lines.join("\n");
}

// Warn-mode counterpart for a first invocation. Same channel rules as
// buildWarning: goes to `systemMessage`, renders to the user, costs zero
// model context — the payload is landing anyway.
function buildFirstInvocationWarning(skill, entry, threshold) {
  const r = costRange(Math.floor(entry.approxBytes / 4));
  return (
    `tkr: "${skill}" auto-invoked — first invocation on this machine; the ` +
    `CLI-binary scrape manifest estimates ${r.text} ` +
    `(scraped, not measured; threshold ${fmt(threshold)}). Not filterable, ` +
    `stays in the cached prefix. TKR_SKILL_GATE=ask to be asked first, ` +
    `=deny to block; /${skill} always passes.`
  );
}

module.exports = {
  gate,
  gateMode,
  thresholdTokens,
  costRange,
  buildRedirect,
  buildAskReason,
  buildWarning,
  bundleFor,
  resolveBundleDir,
  measureBundle,
  bundleRootDir,
  dirHasFile,
  compareVersions,
  newestVersionPresent,
  looksBundled,
  manifestEntryFor,
  buildFirstInvocationAskReason,
  buildFirstInvocationWarning,
  DEFAULT_MODE,
  DEFAULT_THRESHOLD_TOKENS,
  DENSE_CHARS_PER_TOKEN,
  MISS_TTL_MS,
  MAX_INDEX_ROWS,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
};
