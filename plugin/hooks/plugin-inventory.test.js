// PLUGIN-INV guard: the skills inventory must be internally consistent in
// BOTH tiers, in the repo layout AND after the install-time flatten
// (skills-advanced/* → skills/, PUBLIC-008 / ADR-0022). Guards the
// caveman failure classes: duplicate skill registrations inflating the
// always-on token cost (#721) and SKILL.md paths that only resolve in one
// of the two layouts, failing silently in the other (#755).

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const TIERS = ["skills", "skills-advanced"];

function skillDirs(tier) {
  const dir = path.join(repoRoot, tier);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function frontmatter(tier, name) {
  const raw = fs.readFileSync(
    path.join(repoRoot, tier, name, "SKILL.md"),
    "utf8",
  );
  // \r?\n: a Windows checkout with core.autocrlf materializes CRLF and
  // the strict \n pattern reads every SKILL.md as frontmatter-less —
  // green on CI (LF), red on every Windows dev machine.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return { raw, fm: m ? m[1] : "" };
}

test("PLUGIN-INV: every skill dir has SKILL.md with matching name and a description", () => {
  const problems = [];
  for (const tier of TIERS) {
    for (const name of skillDirs(tier)) {
      const skillPath = path.join(repoRoot, tier, name, "SKILL.md");
      if (!fs.existsSync(skillPath)) {
        problems.push(`${tier}/${name}: missing SKILL.md`);
        continue;
      }
      const { fm } = frontmatter(tier, name);
      const nameLine = fm.match(/^name:\s*(\S+)\s*$/m);
      if (!nameLine) {
        problems.push(`${tier}/${name}: no frontmatter name`);
      } else if (nameLine[1] !== name) {
        problems.push(
          `${tier}/${name}: frontmatter name "${nameLine[1]}" != directory name`,
        );
      }
      if (!/^description:\s*\S/m.test(fm)) {
        problems.push(`${tier}/${name}: empty or missing description`);
      }
    }
  }
  assert.deepStrictEqual(problems, [], problems.join("; "));
});

// The description is pinned into every session's system prompt for any
// registered, model-invocable skill — a per-session token tax on every
// user (skills/CLAUDE.md caps it at ~25 tokens / ~100 chars; caveman
// #727 showed always-on injection overhead silently eating all savings).
// 120 chars is the enforced hard ceiling; the soft target stays ~100.
const DESCRIPTION_HARD_CAP = 120;

test("PLUGIN-INV: pinned skill descriptions stay under the hard cap", () => {
  const over = [];
  for (const tier of TIERS) {
    for (const name of skillDirs(tier)) {
      const { fm } = frontmatter(tier, name);
      const m = fm.match(/^description:\s*(.+)$/m);
      if (!m) continue; // absence is caught by the frontmatter test above
      const len = m[1].trim().length;
      if (len > DESCRIPTION_HARD_CAP) {
        over.push(`${tier}/${name}: ${len} chars`);
      }
    }
  }
  assert.deepStrictEqual(
    over,
    [],
    `description tax over the ${DESCRIPTION_HARD_CAP}-char hard cap (~100 target): ${over.join("; ")}`,
  );
});

test("PLUGIN-INV: no duplicate skill names across tiers (flatten would double-register)", () => {
  const core = new Set(skillDirs("skills"));
  const dups = skillDirs("skills-advanced").filter((n) => core.has(n));
  assert.deepStrictEqual(
    dups,
    [],
    `skills present in both tiers — install-time flatten overwrites/duplicates: ${dups.join(", ")}`,
  );
});

// SKILL.md bodies reference runtime paths under ${CLAUDE_PLUGIN_ROOT}.
// Two invariants: (1) a reference into skills/<n>/... must have its
// backing file in the repo (in skills/<n> or, for advanced skills, at the
// pre-flatten skills-advanced/<n> location); (2) a reference into
// scripts/... must have the script in the repo — release bundling keeps
// scripts/ with the advanced tier, so a missing file means the skill
// fails in EVERY layout, silently.
test("PLUGIN-INV: every ${CLAUDE_PLUGIN_ROOT} reference in SKILL.md has a backing file", () => {
  const problems = [];
  for (const tier of TIERS) {
    for (const name of skillDirs(tier)) {
      const { raw } = frontmatter(tier, name);
      for (const m of raw.matchAll(
        /\$\{CLAUDE_PLUGIN_ROOT\}\/((?:skills|scripts|adapters|hooks)\/[^"'\s`)]+)/g,
      )) {
        const ref = m[1];
        const candidates = [path.join(repoRoot, ref)];
        // Advanced skills cite their own post-flatten skills/<n>/ path;
        // the repo copy lives at skills-advanced/<n>/ (PUBLIC-008).
        if (ref.startsWith("skills/")) {
          candidates.push(
            path.join(repoRoot, "skills-advanced", ref.slice("skills/".length)),
          );
        }
        if (!candidates.some((c) => fs.existsSync(c))) {
          problems.push(`${tier}/${name}: ${ref} does not exist in the repo`);
        }
      }
    }
  }
  assert.deepStrictEqual(problems, [], problems.join("; "));
});

// #402: a SKILL.md must invoke its OWN nested backing scripts through
// `bash`, never directly.
//
// Every .sh in the repo is tracked 100644 under core.fileMode=false, so a
// shipped script is executable only if install.sh chmods it — and that
// chmod reaches exactly one directory level (scripts/, adapters/, hooks/).
// `skills/<name>/scripts/` is two levels down and is never reached, so a
// direct invocation dies with `permission denied` on every normal install.
//
// The failure is silent to the user, which is what makes it worth a test
// rather than a code review: the skill reports its steps, the writer never
// runs, and the next session's /continue falls back to JSONL exactly as if
// no handoff had been written. Observed live on macOS (#402).
//
// Scope is deliberately the skill's own scripts/ dir. A reference to the
// top-level scripts/ (delegate.sh, manage-queue.sh) is fine — install.sh
// does chmod those — so the check resolves each reference against the
// skill directory and ignores anything that is not there.
test("SKILL.md invokes its own nested scripts through bash (#402)", () => {
  const problems = [];
  for (const tier of TIERS) {
    for (const name of skillDirs(tier)) {
      const skillDir = path.join(repoRoot, tier, name);
      const md = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      const body = fs.readFileSync(md, "utf8");

      for (const [, span] of body.matchAll(/`([^`\n]+)`/g)) {
        const tokens = span.trim().split(/\s+/);
        // A single token is a reference ("Backed by `scripts/prune.sh`"),
        // not a command line. Arguments or a redirect make it an
        // invocation.
        if (tokens.length < 2) continue;
        const first = tokens[0].replace(/^\.\//, "");
        if (!first.endsWith(".sh")) continue;
        // Only this skill's own nested scripts are at risk.
        const owned = path.join(skillDir, first);
        if (!fs.existsSync(owned)) continue;
        problems.push(
          `${tier}/${name}: SKILL.md invokes \`${span.trim()}\` directly — ` +
            `install.sh never chmods ${tier}/${name}/${first} (one level deep), ` +
            `so this is 'permission denied' on a real install. Use \`bash ${span.trim()}\`.`,
        );
      }
    }
  }
  assert.deepStrictEqual(problems, [], problems.join("; "));
});
