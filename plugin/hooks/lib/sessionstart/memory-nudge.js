// INV-016: SessionStart memory-health nudge.
// Classify project memory dir pre-turn-1 and emit a one-line stderr notice
// when dead/oversized/stale candidates (or an oversized index) exist.
// Gated by cfg.memory.session_start_nudge (default on); deduped 24h via
// $TKR_STATE_DIR/memory-nudge-state.json.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

function pathToClaudeSlug(p) {
  return String(p).replace(/[\\/:]/g, "-");
}

// gate(ctx) — pure config decision (Phase 2b contract).
// Note: this is the config-level gate only. The full emit path also
// applies a 24h cooldown and a memory-audit check which are intrinsic
// I/O and live in emitMemoryNudge.
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

function emitMemoryNudge(projectDir) {
  if (!shouldNudgeMemory()) return;
  if (memoryNudgeCooldownActive()) return;

  let memoryHealth;
  try {
    memoryHealth = require("../../memory-health.js");
  } catch {
    return;
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const slug = pathToClaudeSlug(projectDir);
  const memDir = path.join(home, ".claude", "projects", slug, "memory");
  if (!fs.existsSync(memDir)) return;

  const r = memoryHealth.auditMemDir(memDir);
  if (!r) return;

  const parts = [];
  if (r.dead) parts.push(`${r.dead} dead`);
  if (r.oversized) parts.push(`${r.oversized} oversized`);
  if (r.stale) parts.push(`${r.stale} stale`);
  const indexWarn = r.index && r.index.warn;
  if (indexWarn) parts.push("index bloated");

  if (parts.length === 0) return;

  const short = slug.split("-").slice(-1)[0];
  process.stderr.write(
    `[memory] ${short}: ${parts.join(", ")} → tkr memory audit --fix\n`
  );
  recordMemoryNudge();
}

module.exports = {
  gate,
  pathToClaudeSlug,
  shouldNudgeMemory,
  memoryNudgeCooldownActive,
  recordMemoryNudge,
  emitMemoryNudge,
};
