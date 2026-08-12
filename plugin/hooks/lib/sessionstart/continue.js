// PlaybookV2 L0R — /continue advisory.
//
// Two-tier behavior:
//   1. FILE PATH — if .tkr/handoffs/*.md exists in projectPath, emit a
//      "fresh" (<24h) / "stale" (24h-3d) / "multi" / "many-old" advisory
//      pointing at /continue. Cheap: file read by Claude is ~1-2K tok
//      vs $10 cache rebuild on raw resume.
//   2. JSONL FALLBACK — when no usable file, fall back to the original
//      L0R heuristic: prior session cum_cw > 200K AND away_summary
//      present (~/.tkr/last-session-cw.json, 5min TTL). Cache miss →
//      spawn detached `tkr continue scan-prior` for next session
//      (`tkr resume-coach scan-prior` also accepted as 30d alias).
//
// Gated by TKR_PLAYBOOK_L0R_DISABLED, TKR_PLAYBOOK_EXTENSIONS_DISABLED,
// TKR_PLAYBOOK_DISABLED.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { readLastSessionCWCache } = require("./last-session-cw");
const { tkrSpawnArgv } = require("../tkr-bin");

const L0R_CW_THRESHOLD = 200000;
const FRESH_HANDOFF_MS = 24 * 60 * 60 * 1000; // 24h
const STALE_HANDOFF_MS = 3 * 24 * 60 * 60 * 1000; // 3d
// HAND-005 auto-continue gate. Window is deliberately short: it exists to
// recognize "the handoff this user wrote seconds ago, then cleared", not
// "a handoff exists".
const AUTO_CONTINUE_MAX_AGE_MS = 10 * 60 * 1000; // 10min
const AUTO_CONTINUE_MAX_BYTES = 24 * 1024;

// #262: a plain cwd-relative `.tkr/handoffs` lands in the WORKTREE's own
// tree when this runs inside a git worktree, invisible to /continue run
// from the main checkout — the writer (write-continue-here.sh) and this
// reader must resolve the same directory or they silently drift.
// Priority: TKR_HANDOFFS_DIR (checked first, always wins) > main-checkout
// root, derived from `git rev-parse --git-common-dir` (its parent is the
// main worktree root — `--show-toplevel` is wrong here, it returns the
// worktree itself) > today's cwd-relative fallback, used whenever there is
// no git repo or the git call fails for any reason. Cached per resolved
// base for the life of the process — this is hook-resident code and a git
// shell-out on every SessionStart/hook fire is not free.
const _mainRootCache = new Map();

function resolveMainRoot(base) {
  if (_mainRootCache.has(base)) return _mainRootCache.get(base);
  let root = null;
  try {
    // Deny-by-default on GIT_*, mirroring internal/gitcmd's policy. This is
    // hook-resident code, and git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
    // into every hook it runs — git prefers those over the repository named by
    // `cwd`, so an un-scrubbed call here would resolve handoffs against
    // whatever repo the ambient environment points at. GIT_EXEC_PATH is the
    // sole allowlist entry; GIT_TERMINAL_PROMPT=0 is always pinned so a
    // credential prompt can never hang a SessionStart hook.
    const gitEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith("GIT_") || k === "GIT_EXEC_PATH") gitEnv[k] = v;
    }
    gitEnv.GIT_TERMINAL_PROMPT = "0";
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      {
        cwd: base,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv,
      },
    ).trim();
    if (commonDir) {
      const absCommonDir = path.isAbsolute(commonDir)
        ? commonDir
        : path.resolve(base, commonDir);
      root = path.dirname(absCommonDir);
    }
  } catch {
    root = null;
  }
  _mainRootCache.set(base, root);
  return root;
}

function handoffsDir(projectPath) {
  const base = projectPath || process.cwd();
  if (process.env.TKR_HANDOFFS_DIR) {
    return process.env.TKR_HANDOFFS_DIR;
  }
  const mainRoot = resolveMainRoot(base);
  return path.join(mainRoot || base, ".tkr", "handoffs");
}

// Scan .tkr/handoffs/ for V2-format session handoffs. Returns array of
// { path, mtimeMs, ageMs } sorted newest-first, or [] if none.
function readV2Handoffs(projectPath) {
  try {
    const dir = handoffsDir(projectPath);
    const entries = fs.readdirSync(dir);
    const now = Date.now();
    const files = [];
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      try {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        files.push({ path: full, name, mtimeMs: st.mtimeMs, ageMs: now - st.mtimeMs });
      } catch {}
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  } catch {
    return [];
  }
}

function spawnContinueScan(sid, projectPath) {
  try {
    const { spawn } = require("child_process");
    const args = ["continue", "scan-prior", "--cwd", projectPath || "."];
    if (sid) {
      args.push("--exclude-sid", sid);
    }
    const { cmd, argv } = tkrSpawnArgv(args);
    const child = spawn(cmd, argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort
  }
}

function emitFiredEvent(layer, triggerState, sid) {
  try {
    const emit = require("../playbook-emit");
    emit.emitEvent(layer, "fired", triggerState, null, sid);
  } catch {}
}

function jsonlFallbackAdvisory(sid, projectPath) {
  const cache = readLastSessionCWCache();
  if (!cache) {
    // Cold cache — schedule refresh for next session, silent now.
    spawnContinueScan(sid, projectPath);
    return "";
  }
  if (cache.stale) {
    spawnContinueScan(sid, projectPath);
  }
  const c = cache.payload;
  const cumCW = Number(c.prior_cum_cw || 0);
  const awaySeen =
    c.away_summary_seen === true || (c.away_summary || "").length > 0;
  if (!awaySeen || cumCW < L0R_CW_THRESHOLD) return "";

  emitFiredEvent(
    "L0R",
    {
      path: "jsonl_fallback",
      prior_session_cw: cumCW,
      prior_session_id: c.prior_session_id || "",
      away_summary_seen: true,
      advisory_shown: true,
    },
    sid,
  );

  const cumK = Math.round(cumCW / 1000);
  const priorShort = (c.prior_session_id || "").slice(0, 8);
  return (
    `\n**[continue]** prior session ${priorShort} ended at cum_cw ${cumK}K ` +
    `with away_summary present (no .continue-here.md) — run /continue to ` +
    `build a compact carry-over, then /clear to reset prefix cache cheaply.`
  );
}

// HAND-005 — on a session started by /clear, inject the carry-over body
// instead of advice about it, removing the /continue keystroke. The
// /clear keystroke itself is not automatable from any hook (see TODO
// HAND-005 for the full negative result); this closes the half that is.
//
// Returns { context, systemMessage }, or null to fall through to the
// advisory. Every rejection path is a fallthrough, never an error: the
// advisory is always a correct output, so there is no failure mode worth
// surfacing.
//
// HAND-008 — `context` goes to the model and `systemMessage` to the user,
// and the split is the point. This path used to return context alone, so a
// fire was invisible to the human: the ledger recorded `advisory_shown:
// false` and the user, seeing nothing, typed the `/continue` this feature
// exists to remove. The body is NOT repeated to the user — they wrote it
// minutes ago and it is already in the model's context; only the fact, the
// path, and the age are.
function autoContinueBlock(files, sid, source) {
  if (source !== "clear") return null;
  if (process.env.TKR_AUTO_CONTINUE_DISABLED === "1") return null;

  // Exactly one handoff inside the window. NOT one file total — projects
  // accumulate handoffs, so a total-count gate never fires. Two writes
  // inside 10 minutes is genuine ambiguity about which the user meant.
  const recent = files.filter((f) => f.ageMs < AUTO_CONTINUE_MAX_AGE_MS);
  if (recent.length !== 1) return null;

  const target = recent[0];
  let body;
  let bytes;
  try {
    bytes = fs.statSync(target.path).size;
    if (bytes > AUTO_CONTINUE_MAX_BYTES) return null;
    body = fs.readFileSync(target.path, "utf8");
  } catch {
    return null;
  }
  if (!body.trim()) return null;

  const relPath = path.relative(projectPath_(), target.path);
  const ageMin = Math.max(1, Math.round(target.ageMs / 60000));
  const veryOld = files.filter((f) => f.ageMs > 7 * 24 * 60 * 60 * 1000).length;
  const oldSuffix = veryOld > 0
    ? ` (${veryOld} handoffs older than 7d — run \`/handoff prune\` to clean up)`
    : "";

  emitFiredEvent(
    "L0R",
    {
      path: "v2_auto_continue",
      file_age_min: ageMin,
      file_bytes: bytes,
      v2_file_count: files.length,
      advisory_shown: false,
      auto_injected: true,
    },
    sid,
  );

  return {
    context:
      `\n**[continue — auto-loaded]** This session started from \`/clear\` and ` +
      `\`${relPath}\` was written ${ageMin}m ago, so its carry-over is inlined ` +
      `below. Do not run \`/continue\`; it is already here.${oldSuffix}\n\n` +
      `**Do not act on it yet.** Carry-over names a Next Action. The user has ` +
      `not asked for anything in this session — confirm before executing any ` +
      `of it.\n\n` +
      `<tkr-carryover path="${relPath}">\n${body.trimEnd()}\n</tkr-carryover>\n`,
    systemMessage: autoContinueNotice(relPath, bytes, ageMin, veryOld),
  };
}

// The user-facing half of an auto-continue fire. One line, because it is
// competing with the session banner for a glance. Age is included so a
// wrong-file load is catchable before the user acts on it — the 10-minute
// window can select a handoff they have already forgotten writing. The
// prune hint rides here rather than only in the model's copy: pruning is a
// user action, and the model cannot take it.
function autoContinueNotice(relPath, bytes, ageMin, veryOld) {
  const kb = (bytes / 1024).toFixed(1);
  const prune =
    veryOld > 0 ? ` · ${veryOld} handoffs >7d, run /handoff prune` : "";
  return (
    `[tkr] carry-over auto-loaded from ${relPath} (${kb}KB, ${ageMin}m old) ` +
    `— already in context, no /continue needed${prune}`
  );
}

function v2HandoffAdvisory(files, sid) {
  // Prefer the newest non-stale file (>3d files ignored).
  const usable = files.filter((f) => f.ageMs < STALE_HANDOFF_MS);
  if (usable.length === 0) return null;

  const newest = usable[0];
  const veryOld = files.filter((f) => f.ageMs > 7 * 24 * 60 * 60 * 1000).length;
  const oldSuffix = veryOld > 0
    ? ` (${veryOld} older than 7d — run /handoff prune to clean up)`
    : "";

  if (usable.length === 1) {
    const fresh = newest.ageMs < FRESH_HANDOFF_MS;
    const relPath = path.relative(projectPath_(), newest.path);
    if (fresh) {
      const ageH = Math.max(1, Math.round(newest.ageMs / (60 * 60 * 1000)));
      emitFiredEvent(
        "L0R",
        {
          path: "v2_fresh",
          file_age_h: ageH,
          v2_file_count: files.length,
          advisory_shown: true,
        },
        sid,
      );
      return (
        `\n**[continue]** fresh handoff at \`${relPath}\` (${ageH}h ago) — ` +
        `run /continue to load. Cheap (~1-2K tok) vs raw resume rebuild.${oldSuffix}`
      );
    }
    const ageD = Math.max(1, Math.round(newest.ageMs / (24 * 60 * 60 * 1000)));
    emitFiredEvent(
      "L0R",
      {
        path: "v2_stale",
        file_age_d: ageD,
        v2_file_count: files.length,
        advisory_shown: true,
      },
      sid,
    );
    return (
      `\n**[continue]** handoff at \`${relPath}\` is ${ageD}d old — ` +
      `run /continue if still relevant; confirm before acting on Next Action.${oldSuffix}`
    );
  }
  // Multiple files.
  emitFiredEvent(
    "L0R",
    {
      path: "v2_multi",
      v2_file_count: usable.length,
      advisory_shown: true,
    },
    sid,
  );
  return (
    `\n**[continue]** ${usable.length} handoffs found in \`.tkr/handoffs/\` — ` +
    `run /continue to discover, or /continue <prefix> to pick.${oldSuffix}`
  );
}

// Stash projectPath so v2HandoffAdvisory can render relative paths
// without re-threading it. Set once per call to loadContinueAdvisory.
let _projectPath = "";
function projectPath_() { return _projectPath || "."; }

// Returns { context, systemMessage }. `systemMessage` is non-empty on
// exactly one path (HAND-005 auto-continue); every other path renders its
// own text into `context`, which the user sees by way of the model.
function loadContinue(sid, projectPath, source) {
  const none = { context: "", systemMessage: "" };
  if (process.env.TKR_PLAYBOOK_L0R_DISABLED === "1") return none;
  if (process.env.TKR_PLAYBOOK_EXTENSIONS_DISABLED === "1") return none;
  if (process.env.TKR_PLAYBOOK_DISABLED === "1") return none;

  _projectPath = projectPath || process.cwd();

  // Session-keyed handoffs under .tkr/handoffs/.
  const v2Files = readV2Handoffs(projectPath);
  if (v2Files.length > 0) {
    // HAND-005: on /clear with one just-written handoff, inline it.
    const injected = autoContinueBlock(v2Files, sid, source);
    if (injected) return injected;
    const advisory = v2HandoffAdvisory(v2Files, sid);
    if (advisory) return { context: advisory, systemMessage: "" };
    // All files >3d old — fall through to JSONL fallback.
  }

  return {
    context: jsonlFallbackAdvisory(sid, projectPath),
    systemMessage: "",
  };
}

// Context-only view. Kept because it is the shape every caller and test
// used before HAND-008, and because a caller that cannot render a user
// message has no use for the other half.
function loadContinueAdvisory(sid, projectPath, source) {
  return loadContinue(sid, projectPath, source).context;
}

module.exports = {
  L0R_CW_THRESHOLD,
  FRESH_HANDOFF_MS,
  STALE_HANDOFF_MS,
  AUTO_CONTINUE_MAX_AGE_MS,
  AUTO_CONTINUE_MAX_BYTES,
  handoffsDir,
  readV2Handoffs,
  autoContinueBlock,
  autoContinueNotice,
  spawnContinueScan,
  loadContinue,
  loadContinueAdvisory,
  // Back-compat alias for the prior resume-coach symbol name.
  // Remove after one minor version + 30d (target: 2026-06-17).
  loadResumeCoachAdvisory: loadContinueAdvisory,
  spawnResumeCoachScan: spawnContinueScan,
};
