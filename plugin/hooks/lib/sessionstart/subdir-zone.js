// Subdir-aware SessionStart context (Item 8c).
//
// When the session starts inside a subdirectory of the repo (cwd !==
// project root), inject:
//   1. A short summary of the nearest CLAUDE.md files walking up from
//      cwd to project root. (Claude Code itself already loads these as
//      additive context; this nudge just makes the chain visible.)
//   2. The matching zone from .tkr/zones.toml (commands like test /
//      lint / build / fmt scoped to the current subtree).
//
// Limitation acknowledged: the `tkr-hint: cd <subdir>` first-prompt
// feature mentioned in the proposal is NOT implementable from
// SessionStart — the hook fires before the first user message arrives.
// See docs/proposals/2026-05-21-anthropic-large-repo-gap-closure.md
// item 8c; revisit if the hook contract changes.
//
// Reads .tkr/zones.toml directly in JS with a tiny line-based parser
// (the schema is flat: [[zone]] blocks with `key = "string"` fields).
// No external TOML dependency.

const fs = require("fs");
const path = require("path");

const MAX_PARENTS_WALKED = 8; // safety cap when walking cwd → repo root

/**
 * loadZones(repoRoot) — parse .tkr/zones.toml and return an array of
 * { pathPrefix, test, lint, build, fmt } entries. Empty array on
 * missing/unreadable/malformed file.
 */
function loadZones(repoRoot) {
  if (!repoRoot) return [];
  const file = path.join(repoRoot, ".tkr", "zones.toml");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseZonesToml(text);
}

/**
 * parseZonesToml(text) — minimal parser for the zones schema. Only
 * recognizes `[[zone]]` table-array headers and `key = "value"` pairs
 * (double-quoted strings, no escapes beyond \\ and \"). Comments
 * starting with # are stripped. Anything outside a [[zone]] block is
 * ignored.
 *
 * Exported for unit testing.
 */
function parseZonesToml(text) {
  const zones = [];
  let cur = null;
  const lines = String(text).split(/\r?\n/);
  const flush = () => {
    if (cur && cur.pathPrefix !== undefined) {
      cur.pathPrefix = normalizePrefix(cur.pathPrefix);
      zones.push(cur);
    }
    cur = null;
  };
  for (let raw of lines) {
    // Strip comments outside strings — naive but safe enough for our
    // string-only schema.
    const hashIdx = indexOfHashOutsideString(raw);
    if (hashIdx >= 0) raw = raw.slice(0, hashIdx);
    const line = raw.trim();
    if (!line) continue;
    if (line === "[[zone]]") {
      flush();
      cur = { pathPrefix: "", test: "", lint: "", build: "", fmt: "" };
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([a-z_][a-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    switch (key) {
      case "path_prefix": cur.pathPrefix = val; break;
      case "test":  cur.test  = val; break;
      case "lint":  cur.lint  = val; break;
      case "build": cur.build = val; break;
      case "fmt":   cur.fmt   = val; break;
      // Unknown keys ignored.
    }
  }
  flush();
  return zones;
}

function indexOfHashOutsideString(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && (i === 0 || s[i - 1] !== "\\")) inStr = !inStr;
    else if (c === "#" && !inStr) return i;
  }
  return -1;
}

function normalizePrefix(p) {
  p = String(p || "").trim().replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/") p = "";
  return p;
}

/**
 * resolveZone(zones, repoRoot, cwd) — deepest-matching zone wins;
 * returns null when nothing matches (including no root-fallback entry).
 */
function resolveZone(zones, repoRoot, cwd) {
  const rel = repoRelative(repoRoot, cwd);
  if (rel === null) return null; // cwd outside repo

  // Sort deepest first.
  const sorted = zones.slice().sort((a, b) => {
    const ad = (a.pathPrefix.match(/\//g) || []).length;
    const bd = (b.pathPrefix.match(/\//g) || []).length;
    if (ad !== bd) return bd - ad;
    return a.pathPrefix < b.pathPrefix ? -1 : 1;
  });

  for (const z of sorted) {
    if (zoneMatches(z.pathPrefix, rel)) return z;
  }
  return null;
}

function zoneMatches(prefix, rel) {
  if (prefix === "") return rel === "";
  if (rel === prefix) return true;
  return rel.startsWith(prefix + "/");
}

/**
 * repoRelative(root, cwd) — forward-slash relative path, "" for root,
 * null for outside-repo.
 */
function repoRelative(root, cwd) {
  if (!root || !cwd) return null;
  const absRoot = path.resolve(root);
  const absCwd = path.resolve(cwd);
  let rel = path.relative(absRoot, absCwd);
  if (rel === "" || rel === ".") return "";
  if (rel.startsWith("..")) return null;
  return rel.split(path.sep).join("/");
}

/**
 * walkClaudeMdChain(repoRoot, cwd) — returns paths of CLAUDE.md files
 * walking from cwd UP to repoRoot (inclusive). Stops at repoRoot or
 * after MAX_PARENTS_WALKED iterations. Order: nearest-first (cwd's
 * CLAUDE.md before its parent's, etc.).
 */
function walkClaudeMdChain(repoRoot, cwd) {
  const out = [];
  if (!repoRoot || !cwd) return out;
  const absRoot = path.resolve(repoRoot);
  let dir = path.resolve(cwd);
  let steps = 0;
  while (steps++ < MAX_PARENTS_WALKED) {
    const candidate = path.join(dir, "CLAUDE.md");
    try {
      if (fs.existsSync(candidate)) out.push(candidate);
    } catch {}
    if (dir === absRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * buildSubdirZoneSection({ repoRoot, cwd }) — returns "" when there's
 * nothing to inject (cwd === repoRoot, or no zone matches, or repoRoot
 * unknown). Otherwise returns a markdown section to append to the
 * SessionStart guidance block.
 */
function buildSubdirZoneSection(opts) {
  const repoRoot = opts && opts.repoRoot;
  const cwd = (opts && opts.cwd) || process.cwd();
  if (!repoRoot) return "";

  const absRoot = path.resolve(repoRoot);
  const absCwd = path.resolve(cwd);
  if (absRoot === absCwd) return ""; // at repo root — nothing to add

  const chain = walkClaudeMdChain(repoRoot, cwd);
  const zones = loadZones(repoRoot);
  const zone = resolveZone(zones, repoRoot, cwd);

  // If neither chain nor zone has anything to say, stay silent.
  if (chain.length === 0 && !zone) return "";

  const rel = repoRelative(repoRoot, cwd) || "(root)";
  const lines = [];
  lines.push("");
  lines.push("");
  lines.push("## tkr subdir context");
  lines.push("");
  lines.push(`Session cwd is **${rel}** (not repo root). Claude Code`);
  lines.push("auto-loads zone-scoped CLAUDE.md files additively — chain below.");

  if (chain.length > 0) {
    lines.push("");
    lines.push("**CLAUDE.md chain (nearest → root):**");
    for (const f of chain) {
      const r = path.relative(absRoot, f).split(path.sep).join("/");
      lines.push(`- \`${r}\``);
    }
  }

  if (zone) {
    lines.push("");
    const label = zone.pathPrefix === "" ? "(root)" : zone.pathPrefix;
    lines.push(`**Zone-scoped commands (\`${label}\`):**`);
    if (zone.test)  lines.push(`- test: \`${zone.test}\``);
    if (zone.lint)  lines.push(`- lint: \`${zone.lint}\``);
    if (zone.build) lines.push(`- build: \`${zone.build}\``);
    if (zone.fmt)   lines.push(`- fmt: \`${zone.fmt}\``);
    lines.push("");
    lines.push("Run zone commands rather than repo-wide equivalents — narrower scope,");
    lines.push("faster feedback, fewer unrelated failures.");
  }

  return lines.join("\n");
}

module.exports = {
  buildSubdirZoneSection,
  // Exported for tests.
  parseZonesToml,
  resolveZone,
  walkClaudeMdChain,
  loadZones,
  repoRelative,
  zoneMatches,
  normalizePrefix,
};
