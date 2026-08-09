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
const CACHE_SCHEMA = 1;
// A miss is cached too, so plugin skills (tkr:*, blueprint:*) don't pay a
// temp-dir walk on every dispatch. Short TTL so a CLI upgrade that adds a
// bundle is picked up the same day rather than never.
const MISS_TTL_MS = 60 * 60 * 1000;
const DEFAULT_THRESHOLD_TOKENS = 25_000;
// Redirect index is itself context. Cap it and say so when truncating —
// a silent cap reads as "that's the whole tree" when it isn't.
const MAX_INDEX_ROWS = 24;

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

// bytes/4 is tkr's canonical token estimator (internal/tracking/tracker.go:586).
// On this content class it is wrong in both directions at once, and the
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
// The estimator itself is not corrected here — one sample is not a
// calibration, and EstimateTokens has bench baselines downstream. That
// is its own investigation.
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
function costSentence(bundle) {
  const r = costRange(bundle.tokens);
  return (
    `${r.text} (${bundle.files}-file tree; estimated, not measured — ` +
    `bytes/4 to bytes/2.75, and dense technical text lands near the high end)`
  );
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
  return (
    `tkr: "${skill}" auto-invoked — injecting an estimated ${r.text} ` +
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

// <tmp>/claude/bundled-skills/<ccver>/<hash>/<skill>. Several CLI
// versions coexist; prefer the newest directory that actually contains
// this skill rather than trusting a version string we may not have been
// handed on stdin.
function resolveBundleDir(skill, rootOverride) {
  const root = rootOverride || bundleRootDir();
  let best = null;
  let bestMtime = -1;
  let versions;
  try {
    versions = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const v of versions) {
    let hashes;
    try {
      hashes = fs.readdirSync(path.join(root, v));
    } catch {
      continue;
    }
    for (const h of hashes) {
      const cand = path.join(root, v, h, skill);
      let st;
      try {
        st = fs.statSync(cand);
      } catch {
        continue;
      }
      if (st.isDirectory() && st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = cand;
      }
    }
  }
  return best;
}

// stat only — never reads file contents. Token estimate is bytes/4,
// the same approximation used everywhere else in tkr.
function measureBundle(dir) {
  const index = [];
  let tokens = 0;
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
      files += 1;
      index.push([r, t]);
    }
  };
  walk(dir, "");
  index.sort((a, b) => b[1] - a[1]);
  return { dir, tokens, files, index };
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

// Returns { dir, tokens, files, index } or null when the skill has no
// bundled tree. Cached both ways — see MISS_TTL_MS on why the negative
// entry expires and the positive one does not.
function bundleFor(skill, opts) {
  const o = opts || {};
  const now = typeof o.now === "number" ? o.now : Date.now();
  const cache = readCache();
  const hit = cache.entries[skill];
  if (hit) {
    if (hit.dir === null && now - hit.ts < MISS_TTL_MS) return null;
    // A positive entry is only trusted while the directory it named still
    // exists; a CLI upgrade relocates it under a new version+hash.
    if (hit.dir && fs.existsSync(hit.dir)) {
      return { dir: hit.dir, tokens: hit.tokens, files: hit.files, index: hit.index || [] };
    }
  }
  const dir = resolveBundleDir(skill, o.root);
  if (!dir) {
    cache.entries[skill] = { dir: null, ts: now };
    writeCache(cache);
    return null;
  }
  const m = measureBundle(dir);
  cache.entries[skill] = { dir: m.dir, tokens: m.tokens, files: m.files, index: m.index, ts: now };
  writeCache(cache);
  return m;
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
  DEFAULT_MODE,
  DEFAULT_THRESHOLD_TOKENS,
  DENSE_CHARS_PER_TOKEN,
  MISS_TTL_MS,
  MAX_INDEX_ROWS,
};
