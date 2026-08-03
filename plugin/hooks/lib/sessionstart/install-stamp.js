// Write <UserConfigDir>/tkr/install.stamp if absent. Idempotent.
// Best-effort: any error is swallowed and logged to debug only.
//
// Called from session-start.js on every startup event so marketplace
// users (who have no shell installer to run `tkr init`) still receive a
// stamp — tagged method="marketplace" — on the first SessionStart after
// installing the plugin. The (~minutes-hours) imprecision vs actual
// install time is documented and accepted (Plan 0.5, ADR-007).
//
// Kill switch: TKR_INSTALL_STAMP_DISABLED=1 skips this module entirely.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// resolveStampPath mirrors Go's os.UserConfigDir() cross-platform:
//   Windows: %APPDATA%
//   macOS:   ~/Library/Application Support
//   Linux:   $XDG_CONFIG_HOME or ~/.config
function resolveStampPath() {
  let base;
  if (process.platform === "win32") {
    base = process.env.APPDATA;
  } else if (process.platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  }
  if (!base) {
    throw new Error("install-stamp: cannot resolve UserConfigDir");
  }
  return path.join(base, "tkr", "install.stamp");
}

// ensureInstallStamp writes the stamp if absent. Uses 'wx' (O_EXCL) so
// concurrent calls are race-safe: the loser gets EEXIST and exits
// silently. Any other error is swallowed per best-effort contract.
function ensureInstallStamp() {
  if (process.env.TKR_INSTALL_STAMP_DISABLED === "1") {
    return;
  }
  try {
    const stampPath =
      process.env.TKR_INSTALL_STAMP_PATH || resolveStampPath();
    if (fs.existsSync(stampPath)) {
      return;
    }
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    const stamp = {
      installed_at: new Date().toISOString(),
      installer_version: process.env.TKR_VERSION || "unknown",
      method: "marketplace",
    };
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic, no overwrite on race.
    fs.writeFileSync(stampPath, JSON.stringify(stamp) + "\n", { flag: "wx" });
  } catch (_) {
    // Best-effort: never surface errors to the hook caller.
  }
}

module.exports = { ensureInstallStamp, resolveStampPath };
