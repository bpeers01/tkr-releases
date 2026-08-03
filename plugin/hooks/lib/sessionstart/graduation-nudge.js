// Suggest→rewrite graduation prompt (#52).
//
// In suggest mode tkr never substitutes a command, so the upgrade to rewrite
// mode has to be the user's decision — made against their own measured
// savings rather than a pitch. `tkr gain --suggest --graduation` owns every
// part of that decision: it prints one line only when the evidence clears the
// bar, and marks itself fired as it prints, so this module holds no state and
// cannot turn into a nag.
//
// Silent by construction — empty stdout is the overwhelmingly common case
// (wrong mode, already prompted, not enough evidence, savings not positive).
// Suppress ahead of time with TKR_SUGGEST_NO_GRADUATION=1 or by setting
// hooks.graduation_prompted = true.

const { spawnSync } = require("child_process");

// Cap the injected line so a pathological config can't push an unbounded
// string into the session prefix.
const MAX_LINE = 400;

// Required prefix of the graduation line. Plugin hooks ship with the repo but
// the binary is installed separately, so a user can easily run a tkr that
// predates --graduation. Older binaries ignore unknown gain flags and print
// the full savings report instead — without this check that whole table would
// be injected into the session prefix on every single session start.
const EXPECTED_PREFIX = "tkr: suggest mode";

function loadGraduationNudge() {
  if (process.env.TKR_SUGGEST_NO_GRADUATION === "1") return "";
  try {
    const res = spawnSync("tkr", ["gain", "--suggest", "--graduation"], {
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (res.error || res.signal || (typeof res.status === "number" && res.status !== 0)) {
      return "";
    }
    const line = (res.stdout || "").trim();
    if (!line || !line.startsWith(EXPECTED_PREFIX)) return "";
    // One line only — never a report.
    if (line.includes("\n")) return "";
    return `\n\n${line.slice(0, MAX_LINE)}`;
  } catch {
    return "";
  }
}

module.exports = { loadGraduationNudge, MAX_LINE, EXPECTED_PREFIX };
