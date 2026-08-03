#!/usr/bin/env node
// tkr InstructionsLoaded hook — telemetry only.
//
// Fires when CLAUDE.md or .claude/rules/*.md loads (session_start,
// nested_traversal, path_glob_match, include, compact). No decision
// control — appends one JSONL row to ~/.tkr/instructions-load.jsonl per
// load event. Consumed by `pd-audit` to measure actual load patterns.
//
// Output contract: empty `{}` on stdout. Hook is async/observability.
//
// Wave 4 (CR-06): stdin reads via shared timeout helper so a stalled
// Claude Code write doesn't hang the hook forever. (M-11): log file is
// rotated at 10 MB before each append. (M-12): TKR_HOOKS_DISABLED=1
// short-circuits the hook to a no-op.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { rotateIfLarge } = require("./lib/rotate-jsonl");
const { stateDir } = require("./lib/state-dir");

const TKR_STATE_DIR = stateDir();

const LOG_PATH = path.join(TKR_STATE_DIR, "instructions-load.jsonl");
const DEBUG_LOG = path.join(TKR_STATE_DIR, "instructions-loaded-debug.log");

function debugLog(msg) {
  if (process.env.TKR_INSTRUCTIONS_DEBUG !== "1") return;
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function main() {
  if (hooksDisabled()) {
    process.stdout.write("{}");
    return;
  }
  readStdinWithTimeout(2000)
    .then((raw) => {
      let input = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        debugLog("bad JSON on stdin");
        process.stdout.write("{}");
        return;
      }

      const row = {
        ts: new Date().toISOString(),
        session_id: input.session_id || "",
        cwd: input.cwd || "",
        file_path: input.file_path || "",
        memory_type: input.memory_type || "",
        load_reason: input.load_reason || "",
        globs: Array.isArray(input.globs) ? input.globs : [],
        trigger_file_path: input.trigger_file_path || "",
        parent_file_path: input.parent_file_path || "",
      };

      try {
        fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
        rotateIfLarge(LOG_PATH);
        fs.appendFileSync(LOG_PATH, JSON.stringify(row) + "\n");
      } catch (err) {
        debugLog(`append failed: ${err.message}`);
      }

      process.stdout.write("{}");
    })
    .catch(() => {
      debugLog("stdin timeout/error");
      process.stdout.write("{}");
    });
}

main();
