// hooks/lib/stdin-with-timeout.js
//
// Wave 4 (CR-06): JS hooks have no stdin-timeout. If Claude Code stalls
// mid-write to a hook's stdin, the hook hangs forever — and a hung
// UserPromptSubmit/Stop hook freezes the whole session.
//
// readStdinWithTimeout(timeoutMs) returns a Promise<string> that
// resolves with collected stdin bytes or rejects on timeout. The hook
// can then JSON.parse, react, and finish — even if the bytes are
// incomplete.
//
// Usage:
//   const { readStdinWithTimeout } = require("./lib/stdin-with-timeout");
//   readStdinWithTimeout(5000).then(parseAndAct).catch(() => process.exit(0));
//
// Master kill switch (M-12): when TKR_HOOKS_DISABLED=1 is set, the helper
// resolves immediately with "" so every hook entrypoint that imports it
// can early-return to a no-op. Use it as the first line of your hook
// handler.

"use strict";

const DEFAULT_TIMEOUT_MS = 5000;

function readStdinWithTimeout(timeoutMs) {
  return new Promise((resolve, reject) => {
    // M-12 master kill switch — short-circuit before any I/O.
    if (process.env.TKR_HOOKS_DISABLED === "1") {
      resolve("");
      return;
    }

    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;

    let buf = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("stdin-timeout"));
    }, ms);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(buf);
    });
    process.stdin.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error("stdin-error"));
    });
  });
}

// hooksDisabled is a convenience helper for the master kill switch. Use
// at the very top of a hook entrypoint so we never pay the import cost
// for downstream modules when hooks are off.
function hooksDisabled() {
  return process.env.TKR_HOOKS_DISABLED === "1";
}

module.exports = { readStdinWithTimeout, hooksDisabled, DEFAULT_TIMEOUT_MS };
