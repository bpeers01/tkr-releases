// Delegation budget warning + PlaybookV2 L0 pinned-budget warning.
//
// getBudgetWarning — read delegation-ledger and warn when today's count
//   crosses 80% of configured max_daily per priority adapter.
// loadPinnedBudgetWarning — read pre-computed pinned-budget cache and
//   warn when pinned context exceeds budget. Hot path; never spawns
//   ctx-audit. Gated by TKR_PLAYBOOK_L0_DISABLED.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");

function getBudgetWarning() {
  try {
    const dir = stateDir();
    const ledgerPath = path.join(dir, "delegation-ledger.jsonl");
    const configPath = path.join(dir, "config.json");
    if (!fs.existsSync(ledgerPath) || !fs.existsSync(configPath)) return "";

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const profiles = config.delegation?.profiles || {};
    const priority = config.delegation?.adapter_priority || [];
    if (priority.length === 0) return "";

    const today = new Date().toISOString().slice(0, 10);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
    const todayEntries = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.ts?.startsWith(today) && e.outcome !== "skipped");

    const warnings = [];
    for (const name of priority) {
      const prof = profiles[name];
      if (!prof || !prof.max_daily || prof.max_daily <= 0) continue;
      const count = todayEntries.filter((e) => e.profile === name).length;
      const pct = Math.floor((count * 100) / prof.max_daily);
      if (pct >= 80) {
        warnings.push(`${name}: ${count}/${prof.max_daily} (${pct}%)`);
      }
    }

    if (warnings.length === 0) return "";
    return `\n**Delegation budget warning:** ${warnings.join(", ")}. Cascade will auto-fallback when exceeded.`;
  } catch {
    return "";
  }
}

function loadPinnedBudgetWarning(sid) {
  if (process.env.TKR_PLAYBOOK_L0_DISABLED === "1") return "";
  if (process.env.TKR_PLAYBOOK_DISABLED === "1") return "";
  try {
    const p = path.join(stateDir(), "pinned-budget.json");
    if (!fs.existsSync(p)) return "";
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    const actual = Number(c.actual_tok || 0);
    const budget = Number(c.budget_tok || 0);
    if (!actual || !budget || actual <= budget) return "";

    try {
      const emit = require("../playbook-emit");
      emit.emitEvent(
        "L0",
        "fired",
        {
          pinned_actual_tok: actual,
          pinned_budget_tok: budget,
          delta_tok: actual - budget,
          biggest_offender: c.biggest_offender || "",
        },
        null,
        sid,
      );
    } catch {}

    const biggest = c.biggest_offender ? `; biggest=${c.biggest_offender}` : "";
    return (
      `\n**[L0 pinned-budget]** actual=${actual}tok > budget=${budget}tok ` +
      `(delta=${actual - budget}tok)${biggest}; consider pruning before next /clear ` +
      `(see \`tkr signals pinned-budget --human\`).`
    );
  } catch {
    return "";
  }
}

module.exports = { getBudgetWarning, loadPinnedBudgetWarning };
