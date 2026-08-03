#!/usr/bin/env node
// hooks/team-push.js — SessionEnd → debounced team telemetry push.
//
// Enterprise-collection-architecture proposal §3. This shim does the
// minimum: gate on the kill switch, then hand everything to the Go
// binary detached (`tkr team push --auto`), which owns config
// gating, enrollment, the daily debounce marker, the actual push,
// and logging to <UserConfigDir>/tkr/team-push.log.
//
// Invariants:
//   - Never blocks hook exit (detached spawn, immediate exit 0).
//   - Never writes to stdout/stderr — a broken collector must not
//     surface into anyone's session.
//   - `tkr team push --auto` is itself a silent no-op unless the
//     managed [team] config (or an existing enrollment) is present,
//     so installing this hook on an unconfigured machine does
//     nothing at all.
//
// Kill switches: TKR_TEAM_DISABLE=1 here (cheapest exit) and again
// in the Go side (covers direct invocation).

"use strict";

const { spawnBounded } = require("./lib/spawn-bounded");

function main() {
  if (process.env.TKR_TEAM_DISABLE === "1") return;
  try {
    const child = spawnBounded(
      "tkr",
      ["team", "push", "--auto"],
      { detached: true, stdio: "ignore", windowsHide: true },
      120_000,
    );
    if (child && child.unref) child.unref();
  } catch {
    // Best-effort by contract.
  }
}

main();
process.exit(0);
