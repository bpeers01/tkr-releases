// Exploration pattern detection.
// Tracks consecutive Read/Glob/Grep/Agent(Explore) calls via state file.
// After EXPLORE_NUDGE_THRESHOLD consecutive exploration calls, appends a
// search-first nudge to the tool response. Resets on Bash calls.

const fs = require("fs");
const path = require("path");
const { stateDir } = require("../state-dir");
const { tkrSpawnSync } = require("./tkr-spawn");

const EXPLORE_TOOLS = new Set(["Read", "Glob", "Grep"]);
const EXPLORE_NUDGE_THRESHOLD = 3;
const EXPLORE_NUDGE_TEXT =
  "\n\n" +
  fs
    .readFileSync(
      path.join(__dirname, "..", "..", "data", "posttool", "explore-nudge.md"),
      "utf8",
    )
    .replace(/\n+$/, "");

function exploreNudgePath() {
  return path.join(stateDir(), "explore-nudge.json");
}

// SRCH-011: one durable adoption row per native read-burst (the moment
// the nudge fires = the detector saying "this exploration could have
// been one tkr_search"). Same store the Go MCP handlers append
// tkr_search/tkr_graph rows to; `tkr top --json` reads the ratio.
// Best-effort, rotation-capped like all hot-path JSONL writers.
function recordReadBurst() {
  try {
    const { rotateIfLarge } = require("../rotate-jsonl");
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "search-adoption.jsonl");
    rotateIfLarge(p, 2 * 1024 * 1024);
    const row = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      kind: "native_read_burst",
      sid: process.env.TKR_SESSION_ID || undefined,
    };
    fs.appendFileSync(p, JSON.stringify(row) + "\n");
  } catch {
    // telemetry never blocks the hook
  }
}

function readExploreState() {
  try {
    return JSON.parse(fs.readFileSync(exploreNudgePath(), "utf8"));
  } catch {
    return { count: 0, nudged: false };
  }
}

function writeExploreState(state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(exploreNudgePath(), JSON.stringify(state));
  } catch {
    // Best-effort
  }
}

function isExploreAgent(event) {
  if (event.tool_name !== "Agent") return false;
  const desc = event.tool_input?.description || "";
  return /explore/i.test(desc);
}

// Derive a search query from recent exploration tool inputs.
function deriveSearchQuery(queries) {
  if (!queries || queries.length === 0) return null;
  // Take unique, non-trivial terms from recent queries
  const seen = new Set();
  const terms = [];
  for (const q of queries) {
    const cleaned = q.replace(/[*?{}()\[\]\\\/]/g, " ").trim();
    if (cleaned.length < 3 || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    terms.push(cleaned);
  }
  if (terms.length === 0) return null;
  // Join last 3 terms — enough context without noise
  return terms.slice(-3).join(" ");
}

// Run a quick tkr search and return compact human output.
// H-14: tkrSpawnSync = spawnSync + SIGKILL + 10MB maxBuffer (no shell).
function runQuickSearch(query) {
  try {
    const result = tkrSpawnSync(
      ["search", query, "--human", "--compact", "-k", "3"],
      { timeout: 3000 },
    );
    return (result || "").trim();
  } catch {
    return null;
  }
}

function checkExplorationPattern(event) {
  const toolName = event.tool_name || "";

  // Bash call (including tkr search) → reset counter
  if (toolName === "Bash") {
    writeExploreState({ count: 0, nudged: false, queries: [] });
    return null;
  }

  // Not an exploration tool → ignore (don't reset — other tools like Edit are neutral)
  if (!EXPLORE_TOOLS.has(toolName) && !isExploreAgent(event)) return null;

  // Increment exploration counter, track query context
  const state = readExploreState();
  state.count++;
  if (!state.queries) state.queries = [];

  // Capture what the agent was looking for
  const input = event.tool_input || {};
  if (input.pattern) state.queries.push(input.pattern);
  if (input.query) state.queries.push(input.query);
  if (input.file_path) {
    const basename = input.file_path.split(/[/\\]/).pop();
    if (basename) state.queries.push(basename);
  }

  if (state.count >= EXPLORE_NUDGE_THRESHOLD && !state.nudged) {
    state.nudged = true;
    writeExploreState(state);
    recordReadBurst();

    // Build nudge text — include active search results if we can derive a query
    let nudgeText = EXPLORE_NUDGE_TEXT;
    const derivedQuery = deriveSearchQuery(state.queries);
    if (derivedQuery) {
      const searchResults = runQuickSearch(derivedQuery);
      if (searchResults) {
        nudgeText += "\n\n> tkr auto-search for \"" + derivedQuery + "\":\n" + searchResults;
      }
    }

    // Append nudge to tool response
    const response = event.tool_response || {};
    const existing = response.stdout || response.output || "";
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          ...response,
          ...(response.stdout != null
            ? { stdout: existing + nudgeText }
            : { output: existing + nudgeText }),
        },
      },
    };
  }

  writeExploreState(state);
  return null;
}

module.exports = {
  checkExplorationPattern,
  EXPLORE_NUDGE_THRESHOLD,
  EXPLORE_TOOLS,
};
