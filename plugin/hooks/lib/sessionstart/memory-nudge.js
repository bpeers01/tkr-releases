// INV-016: SessionStart memory-health nudge.
// Classify project memory dir pre-turn-1 and build a one-line notice when
// dead/oversized/stale candidates (or an oversized index) exist.
// Gated by cfg.memory.session_start_nudge (default on); deduped 24h via
// $TKR_STATE_DIR/memory-nudge-state.json.
//
// #357 (sibling of #349): this used to go out via `process.stderr.write`
// on a hook that exits 0, which reaches only the debug log — never the
// transcript, never the user (see hooks/CLAUDE.md Hook contract, Stderr
// bullet) — and it burned the 24h dedup regardless, so an undelivered
// nudge also suppressed the NEXT day's delivered one. `loadMemoryNudge`
// below only BUILDS the message; the caller (hooks/session-start.js)
// plumbs it into the HAND-008 `systemMessage` channel and calls
// `recordMemoryNudge()` only once the message is actually assembled into
// that channel, so the dedup state can never say "already nudged" for a
// nudge nobody saw.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

function pathToClaudeSlug(p) {
  return String(p).replace(/[\\/:]/g, "-");
}

// gate(ctx) — pure config decision (Phase 2b contract).
// Note: this is the config-level gate only. The full emit path also
// applies a 24h cooldown and a memory-audit check which are intrinsic
// I/O and live in loadMemoryNudge.
//   ctx.cfg: parsed config (or {})
function gate(ctx) {
  const v = ctx && ctx.cfg && ctx.cfg.memory
    ? ctx.cfg.memory.session_start_nudge
    : undefined;
  return v === undefined || v === null || v === true;
}

function readConfigFromDisk() {
  try {
    const configPath = path.join(stateDir(), "config.json");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {}
  return {};
}

function shouldNudgeMemory() {
  return gate({ cfg: readConfigFromDisk() });
}

function memoryNudgeCooldownActive() {
  try {
    const statePath = path.join(stateDir(), "memory-nudge-state.json");
    if (!fs.existsSync(statePath)) return false;
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const last = Number(s.last_nudge_ms || 0);
    return last > 0 && Date.now() - last < 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

function recordMemoryNudge() {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const statePath = path.join(dir, "memory-nudge-state.json");
    fs.writeFileSync(statePath, JSON.stringify({ last_nudge_ms: Date.now() }));
  } catch {}
}

// loadMemoryNudge builds the nudge message (or "" when nothing applies).
// Pure with respect to delivery: it never writes stdout/stderr and never
// calls recordMemoryNudge — the caller decides whether/where the message
// is delivered and records the dedup state only once it has been.
function loadMemoryNudge(projectDir) {
  if (!shouldNudgeMemory()) return "";
  if (memoryNudgeCooldownActive()) return "";

  let memoryHealth;
  try {
    memoryHealth = require("../../memory-health.js");
  } catch {
    return "";
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const slug = pathToClaudeSlug(projectDir);
  const memDir = path.join(home, ".claude", "projects", slug, "memory");
  if (!fs.existsSync(memDir)) return "";

  const r = memoryHealth.auditMemDir(memDir);
  if (!r) return "";

  const parts = [];
  if (r.dead) parts.push(`${r.dead} dead`);
  if (r.oversized) parts.push(`${r.oversized} oversized`);
  if (r.stale) parts.push(`${r.stale} stale`);
  const indexWarn = r.index && r.index.warn;
  if (indexWarn) parts.push("index bloated");

  if (parts.length === 0) return "";

  const short = slug.split("-").slice(-1)[0];
  return `[memory] ${short}: ${parts.join(", ")} → tkr memory audit --fix`;
}

module.exports = {
  gate,
  pathToClaudeSlug,
  shouldNudgeMemory,
  memoryNudgeCooldownActive,
  recordMemoryNudge,
  loadMemoryNudge,
};
