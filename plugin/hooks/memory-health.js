#!/usr/bin/env node
// tkr Stop hook — post-session memory health check.
// Scans ~/.claude/projects/*/memory/ for dead/oversized/stale files.
// Silent when clean; emits a `systemMessage` JSON response when candidates
// found.
//
// #349: the summary used to go to `process.stderr.write` on a hook that
// exits 0, which reaches the debug log and never the user — so no warning
// this hook produced was ever seen without `--debug`. It goes out as
// `systemMessage` now: rendered to the user, never entered into model
// context (same channel as hooks/session-start.js and hooks/skill-invoked.js).
//
// Wave 4 (CR-07): previously this hook used synchronous `fs.readFileSync(0)`
// for stdin AND walked every project under ~/.claude/projects on every
// Stop event. Combined that pinned the session teardown to seconds on
// a long-lived user. Now:
//   - stdin is not read at all — the hook needs nothing from the payload
//   - scan is scoped to CLAUDE_PROJECT_DIR when set; full walk only as
//     opt-in via TKR_MEMORY_HEALTH_FULL_SCAN=1
//   - whole-hook wall-clock budget enforced; if exceeded the partial
//     summary is still emitted, never blocks the Stop event

const fs = require("fs");
const path = require("path");
const { hooksDisabled } = require("./lib/stdin-with-timeout");

const SIZE_THRESHOLD = 1500;
// STALE_DAYS is the threshold for an entry that declares no provenance. It
// stays 21 so every file written before provenance existed keeps the category
// it had yesterday.
const STALE_DAYS = 21;
// Per-provenance thresholds. This table and STALE_DAYS_BY_PROVENANCE's twin in
// internal/cmd/memory.go are parallel ports with no shared constant — the Go
// CLI and this Stop hook classify the same directories and must agree. Change
// one, change the other; hooks/memory-health.test.js and
// internal/cmd/memory_test.go assert the same cases against both so a one-sided
// edit fails on the side that was not edited.
//
// The ordering is a claim about acquisition cost, not truth: a correction the
// user typed cost them an interruption; an inference the agent drew about
// itself cost nothing and is the cheapest thing here to regenerate. The
// numbers are calibrated, not measured — the ordering is what is asserted.
const STALE_DAYS_BY_PROVENANCE = {
  "user-corrected": 180,
  "user-stated": 120,
  observed: 45,
  inferred: 7,
};
// A `created:` value: calendar date, optional clock. The clock is matched so
// RFC3339 is not rejected outright, then discarded — thresholds count days.
// Anything unmatched falls back to mtime rather than reading as ancient.
const CREATED_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
// MEMORY.md hard caps from Claude Code source (src/memdir/memdir.ts:35,38):
//   MAX_ENTRYPOINT_LINES = 200, MAX_ENTRYPOINT_BYTES = 25_000.
// Past either cap, the index is truncated mid-load.
const INDEX_LINE_CAP = 200;
const INDEX_CHAR_CAP = 25000;
// MAX_MEMORY_FILES = 200 from src/memdir/memoryScan.ts:21. Scan caps the
// header list at 200 newest files; older files become invisible to the
// per-turn selector. Warn when approaching the cap.
const MAX_MEMORY_FILES_WARN = 180;
// Memory selector (src/memdir/findRelevantMemories.ts) picks up to 5
// memories per turn by frontmatter description. Empty/short/generic
// descriptions degrade selector accuracy.
const MIN_DESCRIPTION_LENGTH = 20;
const GENERIC_DESCRIPTIONS = new Set([
  "memory",
  "memory file",
  "notes",
  "note",
  "memo",
  "todo",
  "tbd",
]);
const REQUIRED_FRONTMATTER_FIELDS = ["name", "description", "type"];

const DEAD_KEYWORDS = ["fully shipped", "complete and pushed"];
// RESOLVED only matches as a dead marker when uppercase at the start of a line.
const DEAD_RESOLVED_RE = /^\**RESOLVED\b/m;
const DEAD_PHASE_RE = /phase\s+\d+(\.\d+)?\s+(is\s+)?(fully\s+)?(complete|done)\b/i;
const DEAD_PCT_RE = /\b100%\s+(shipped|complete|done)/i;
// INV-014: additional shipped-work phrasings.
const DEAD_FULLY_LIVE_RE = /\bfully\s+(live|deployed|rolled\s+out)\b/i;
const DEAD_AUDIT_RE = /\baudit\s+complete\b/i;
const DEAD_ALL_FIXED_RE = /\ball\s+\d+\s+\w+\s+(fixed|resolved|addressed)\b/i;
// Uppercase COMPLETE as a status-line marker — only near top of file (see classify).
const DEAD_COMPLETE_UC_RE = /\bCOMPLETE\b/;
const FORWARD_KEYWORDS = ["awaiting", "pending", "blocked", "next is", "next:"];
// TODO only counts when it's an action item (TODO: or TODO <word>), not a file ref (TODO.md).
const TODO_RE = /\bTODO\s*:|TODO\s+[^.\s]/;
const PLAN_REF_RE = /PLAN-\d+/;

function parseFrontmatter(content) {
  const fm = {};
  if (!content.startsWith("---")) return fm;
  const rest = content.slice(3).replace(/^\n/, "");
  const end = rest.indexOf("\n---");
  if (end < 0) return fm;
  for (const line of rest.slice(0, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

function stripFrontmatter(content) {
  if (!content.startsWith("---")) return content;
  const rest = content.slice(3).replace(/^\n/, "");
  const idx = rest.indexOf("\n---");
  if (idx < 0) return content;
  return rest.slice(idx + 4).trim();
}

function hasForwardKeywords(body) {
  const lower = body.toLowerCase();
  for (const kw of FORWARD_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return PLAN_REF_RE.test(body) || TODO_RE.test(body);
}

// Frontmatter quality check — independent of body classification.
// Returns an array of issue tags: 'missing_frontmatter', 'weak_description'.
// A file can have body classification AND frontmatter issues simultaneously.
function checkFrontmatter(fm) {
  const issues = [];
  const missing = REQUIRED_FRONTMATTER_FIELDS.filter(
    (f) => !fm[f] || fm[f].length === 0,
  );
  if (missing.length > 0) {
    issues.push("missing_frontmatter");
    // Skip weak-description check if description is missing entirely;
    // already covered by missing_frontmatter.
    return issues;
  }
  const desc = fm.description.trim().toLowerCase();
  if (
    desc.length < MIN_DESCRIPTION_LENGTH ||
    GENERIC_DESCRIPTIONS.has(desc)
  ) {
    issues.push("weak_description");
  }
  return issues;
}

// parseCreated reads a `created:` frontmatter value as a UTC calendar date.
// Returns null when the value is unusable, which sends the caller back to
// mtime. Deliberately NOT `new Date(v)`: that accepts "2026", "April 14 2026"
// and other things the Go side rejects, and a parser that is lenient on one
// side only is exactly the divergence this pair of files has to avoid.
function parseCreated(v) {
  if (!v) return null;
  const m = CREATED_RE.exec(String(v).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC rolls 2026-02-31 forward into March; Go's time.Parse rejects it.
  // Round-trip the components so both sides call it a bad date.
  if (
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() !== mo - 1 ||
    t.getUTCDate() !== d
  ) {
    return null;
  }
  return t;
}

// staleDaysForProvenance mirrors memStalePolicy.daysFor with overrideAll=false.
// The hook has no --stale flag to honor, so it is always in table mode. An
// unrecognized value is treated exactly like an absent one: a typo must not
// silently buy an entry six months of runway.
function staleDaysForProvenance(provenance) {
  const d = STALE_DAYS_BY_PROVENANCE[provenance];
  return typeof d === "number" ? d : STALE_DAYS;
}

// entryAgeDays mirrors memEntryAgeDays: created: when it is present, usable and
// not in the future; mtime otherwise. Floored to whole days, which is also what
// the Go side does — it used to divide as a float here and truncate there, so
// an entry 21.5 days old was STALE to the hook and GOOD to the CLI.
function entryAgeDays(created, modTime, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (created && created.getTime() <= nowMs) {
    return Math.floor((nowMs - created.getTime()) / 86400000);
  }
  return Math.floor((nowMs - modTime.getTime()) / 86400000);
}

// classify takes the whole frontmatter map rather than just type, mirroring the
// Go classifier's entry struct — it now reads three keys, and threading them
// one argument at a time is how the two ports drift.
function classify(body, fm, chars, modTime, now) {
  const memType = (fm && fm.type) || "";
  const lower = body.toLowerCase();
  const hasFwd = hasForwardKeywords(body);
  if (!hasFwd) {
    for (const kw of DEAD_KEYWORDS) {
      if (lower.includes(kw)) return "DEAD";
    }
    if (DEAD_RESOLVED_RE.test(body)) return "DEAD";
    if (DEAD_PHASE_RE.test(body)) return "DEAD";
    if (DEAD_PCT_RE.test(body)) return "DEAD";
    if (DEAD_FULLY_LIVE_RE.test(body)) return "DEAD";
    if (DEAD_AUDIT_RE.test(body)) return "DEAD";
    if (DEAD_ALL_FIXED_RE.test(body)) return "DEAD";
    if (DEAD_COMPLETE_UC_RE.test(body.slice(0, 500))) return "DEAD";
  }
  // type decides WHETHER an entry ages; provenance only decides how fast. Only
  // type:project ages, so provenance is consulted here and nowhere else — a
  // type:feedback entry marked provenance:inferred is still a standing rule.
  if (memType === "project" && chars > SIZE_THRESHOLD) return "OVERSIZED";
  if (memType === "project") {
    const created = parseCreated(fm && fm.created);
    const ageDays = entryAgeDays(created, modTime, now);
    if (ageDays > staleDaysForProvenance(fm && fm.provenance) && !hasFwd) {
      return "STALE";
    }
  }
  return "GOOD";
}

function auditMemIndex(memDir) {
  try {
    const buf = fs.readFileSync(path.join(memDir, "MEMORY.md"));
    const chars = buf.length;
    let lines = 0;
    for (let i = 0; i < chars; i++) if (buf[i] === 10) lines++;
    if (chars > 0 && buf[chars - 1] !== 10) lines++;
    return { lines, chars, warn: lines > INDEX_LINE_CAP || chars > INDEX_CHAR_CAP };
  } catch {
    return { lines: 0, chars: 0, warn: false };
  }
}

// `now` is injectable for tests only. Provenance adds no per-file I/O to the
// 500ms Stop budget: it is a map lookup and one regex on frontmatter this
// function already read and already parsed.
function auditMemDir(memDir, overBudget, now) {
  let entries;
  try { entries = fs.readdirSync(memDir); } catch { return null; }
  const asOf = now instanceof Date ? now : new Date();

  let dead = 0, oversized = 0, stale = 0, total = 0;
  let missingFrontmatter = 0, weakDescription = 0;
  for (const name of entries) {
    if (overBudget && overBudget()) break;
    if (!name.endsWith(".md") || name === "MEMORY.md") continue;
    total++;
    let content;
    try { content = fs.readFileSync(path.join(memDir, name), "utf8"); } catch { continue; }
    const fm = parseFrontmatter(content);
    const body = stripFrontmatter(content);
    const modTime = fs.statSync(path.join(memDir, name)).mtime;
    const cat = classify(body, fm, content.length, modTime, asOf);
    if (cat === "DEAD") dead++;
    else if (cat === "OVERSIZED") oversized++;
    else if (cat === "STALE") stale++;
    const fmIssues = checkFrontmatter(fm);
    if (fmIssues.includes("missing_frontmatter")) missingFrontmatter++;
    if (fmIssues.includes("weak_description")) weakDescription++;
  }
  const index = auditMemIndex(memDir);
  const fileCountWarn = total > MAX_MEMORY_FILES_WARN;
  return {
    dead, oversized, stale, total,
    missingFrontmatter, weakDescription, fileCountWarn,
    index,
  };
}

// formatProjectWarnings renders one project's audit result as user-facing
// lines. Pure — no I/O, no clock — so the wording is testable without a
// fake HOME, and so the caller decides where the lines go.
function formatProjectWarnings(slug, s) {
  const lines = [];
  const parts = [];
  if (s.dead > 0) parts.push(`dead: ${s.dead}`);
  if (s.oversized > 0) parts.push(`oversized: ${s.oversized}`);
  if (s.stale > 0) parts.push(`stale: ${s.stale}`);
  const n = s.dead + s.oversized + s.stale;
  const short = slug.split("-").slice(-1)[0];
  if (n > 0) {
    lines.push(
      `[memory] ${short}: ${n} candidate${n !== 1 ? "s" : ""} (${parts.join(", ")})`,
      `  → run: tkr memory audit --project ${slug}`,
    );
  }
  if (s.index && s.index.warn) {
    lines.push(
      `[memory] ${short}: MEMORY.md index ${s.index.lines} lines / ${s.index.chars}c — exceeds ${INDEX_LINE_CAP}-line / ${INDEX_CHAR_CAP}c cap (truncated on load)`,
      `  → consolidate detail-heavy entries into topic files; keep index to one line each`,
    );
  }
  const fmParts = [];
  if (s.missingFrontmatter > 0) fmParts.push(`missing-frontmatter: ${s.missingFrontmatter}`);
  if (s.weakDescription > 0) fmParts.push(`weak-description: ${s.weakDescription}`);
  if (fmParts.length > 0) {
    lines.push(
      `[memory] ${short}: ${fmParts.join(", ")} — selector picks memories by description`,
      `  → add name/description/type frontmatter; descriptions ≥${MIN_DESCRIPTION_LENGTH} chars, specific`,
    );
  }
  if (s.fileCountWarn) {
    lines.push(
      `[memory] ${short}: ${s.total} memory files — approaching 200-file cap (older files become invisible to selector)`,
      `  → consolidate or delete dead memories before scan-cap drops oldest`,
    );
  }
  return lines;
}

// Returns the warning lines to show the user; empty array when clean or
// when the scan could not run at all.
function runHealthScan(deadline) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const projectsDir = path.join(home, ".claude", "projects");

  let projectDirs;
  // CR-07: scope to CLAUDE_PROJECT_DIR by default. Full walk only on
  // opt-in via TKR_MEMORY_HEALTH_FULL_SCAN=1.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  const fullScan = process.env.TKR_MEMORY_HEALTH_FULL_SCAN === "1";
  if (projectDir && !fullScan) {
    // Map cwd → ~/.claude/projects slug. CC encodes the project path by
    // replacing path separators and ':' with '-'. We can't fully invert
    // that without seeing the encoder, so we use a substring match: any
    // project dir whose name ends with the cwd basename is treated as a
    // match. Inexact but cheap and good enough for the Stop-hook use.
    const base = path.basename(projectDir);
    try {
      const all = fs.readdirSync(projectsDir);
      projectDirs = all.filter((d) => d.endsWith(base));
    } catch {
      return [];
    }
  } else {
    try {
      projectDirs = fs.readdirSync(projectsDir).filter((d) => {
        try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
    } catch {
      return [];
    }
  }
  // Wall-clock check helper — bail early if past the deadline.
  const overBudget = () => Date.now() > deadline;

  const summaries = [];
  for (const slug of projectDirs) {
    if (overBudget()) break;
    const memDir = path.join(projectsDir, slug, "memory");
    if (!fs.existsSync(memDir)) continue;
    const r = auditMemDir(memDir, overBudget);
    if (!r) continue;
    const hasFiles = r.dead + r.oversized + r.stale > 0;
    const hasIndex = r.index && r.index.warn;
    const hasFrontmatter = r.missingFrontmatter + r.weakDescription > 0;
    const hasFileCount = r.fileCountWarn;
    if (!hasFiles && !hasIndex && !hasFrontmatter && !hasFileCount) continue;
    summaries.push({ slug, ...r });
  }

  const lines = [];
  for (const s of summaries) {
    lines.push(...formatProjectWarnings(s.slug, s));
  }
  return lines;
}

// main is the entrypoint. 500ms wall-clock budget (CR-07). Stop hooks must
// return fast — they run during session teardown and any delay is visible
// to the user.
//
// Stdout stays empty when there is nothing to report: a clean scan is the
// common case and `{}` is what an absent response already means.
function main() {
  if (hooksDisabled()) return;
  const deadline = Date.now() + 500;
  let lines = [];
  try {
    lines = runHealthScan(deadline) || [];
  } catch (err) {
    if (process.env.TKR_MEMORY_HEALTH_DEBUG === "1") {
      process.stderr.write(`[memory] scan failed: ${err.message}\n`);
    }
    return;
  }
  if (lines.length === 0) return;
  process.stdout.write(JSON.stringify({ systemMessage: lines.join("\n") }));
}

if (require.main === module) main();

module.exports = {
  auditMemDir,
  auditMemIndex,
  formatProjectWarnings,
  runHealthScan,
  checkFrontmatter,
  classify,
  parseCreated,
  entryAgeDays,
  staleDaysForProvenance,
  STALE_DAYS,
  STALE_DAYS_BY_PROVENANCE,
  INDEX_LINE_CAP,
  INDEX_CHAR_CAP,
  MAX_MEMORY_FILES_WARN,
  MIN_DESCRIPTION_LENGTH,
  GENERIC_DESCRIPTIONS,
  REQUIRED_FRONTMATTER_FIELDS,
};
