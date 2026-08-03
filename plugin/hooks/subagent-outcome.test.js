#!/usr/bin/env node
// SubagentStop outcome ledger (native-work-routing §14.4).
//
// Most of this file is about what the hook must NOT write. The event it
// listens to carries no status of any kind, so every field beyond the
// identifiers is a chance to record a claim the payload does not support
// — and the one that matters, "the worker succeeded", is the claim the
// whole feature would be evaluated on.
//
// Run: node --test hooks/subagent-outcome.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "subagent-outcome.js");
const { buildRow, SCHEMA_VERSION } = require("./subagent-outcome.js");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-subagent-outcome-"));
  const ledger = path.join(dir, "subagent-outcomes.jsonl");
  return {
    dir,
    ledger,
    env: { TKR_STATE_DIR: dir, TKR_SUBAGENT_OUTCOMES_PATH: ledger },
    rows() {
      if (!fs.existsSync(ledger)) return [];
      return fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    },
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function stopEvent(overrides) {
  return {
    hook_event_name: "SubagentStop",
    session_id: "sess-outcome",
    prompt_id: "pr-1",
    agent_id: "ag-1",
    agent_type: "tkr:explore-haiku",
    transcript_path: "/home/user/.claude/projects/proj/sess-outcome.jsonl",
    last_assistant_message: "I found the retry budget in internal/http/retry.go:42.",
    ...overrides,
  };
}

function run(fx, event, extraEnv) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, ...fx.env, ...(extraEnv || {}) },
  });
  assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  assert.strictEqual(res.stdout, "{}", "hook must emit an empty response");
  return fx.rows();
}

// ── What it records ─────────────────────────────────────────────────────────

test("a stop event produces one row with the payload's identifiers", () => {
  const fx = fixture();
  try {
    const rows = run(fx, stopEvent());
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(r.event, "subagent-stop");
    assert.strictEqual(r.schema_version, SCHEMA_VERSION);
    assert.strictEqual(r.prompt_id, "pr-1");
    assert.strictEqual(r.agent_id, "ag-1");
    assert.strictEqual(r.agent_type, "tkr:explore-haiku");
    assert.ok(r.at, "expected an ISO timestamp");
  } finally {
    fx.cleanup();
  }
});

test("the session id comes from the transcript path, like every other hook", () => {
  // getSessionID prefers the transcript UUID because it is the most
  // stable id Claude Code emits. Drift here means a spawn row and its own
  // outcome row disagree about which session they belong to, and the join
  // silently reports every outcome unjoined.
  const fx = fixture();
  const uuid = "0f9c1a2b-3d4e-5f60-8712-93a4b5c6d7e8";
  try {
    const rows = run(fx, stopEvent({
      session_id: "ignored-when-a-transcript-exists",
      transcript_path: `/p/${uuid}.jsonl`,
    }));
    assert.strictEqual(rows[0].session_id, uuid);
  } finally {
    fx.cleanup();
  }
});

// ── What it must never record ───────────────────────────────────────────────

test("a stop is recorded as stopped, never as completed or successful", () => {
  const fx = fixture();
  try {
    const rows = run(fx, stopEvent());
    assert.strictEqual(rows[0].completion, "stopped");
    assert.strictEqual(rows[0].verification, "not_observed");
    const text = JSON.stringify(rows[0]);
    for (const forbidden of ["completed", "success", "passed"]) {
      assert.ok(
        !text.includes(forbidden),
        `row asserts ${forbidden}, which the SubagentStop payload cannot support: ${text}`,
      );
    }
  } finally {
    fx.cleanup();
  }
});

test("the worker's output and transcript path stay out of the ledger", () => {
  // A local ledger is a poor place to accumulate transcript text, and
  // neither field is needed to answer whether a plan produced a worker
  // that ran. Identifiers and categories only.
  const fx = fixture();
  try {
    const rows = run(fx, stopEvent());
    const text = JSON.stringify(rows[0]);
    assert.ok(!text.includes("retry budget"), `last_assistant_message leaked: ${text}`);
    assert.ok(!("last_assistant_message" in rows[0]));
    assert.ok(!("transcript_path" in rows[0]));
    assert.ok(!text.includes("/home/user/.claude"), `a filesystem path leaked: ${text}`);
  } finally {
    fx.cleanup();
  }
});

test("oversized payload fields are clamped", () => {
  const fx = fixture();
  try {
    const rows = run(fx, stopEvent({ agent_type: "x".repeat(5000) }));
    assert.ok(
      rows[0].agent_type.length <= 256,
      `agent_type not clamped: ${rows[0].agent_type.length}`,
    );
  } finally {
    fx.cleanup();
  }
});

// ── Robustness ──────────────────────────────────────────────────────────────

test("a duplicate stop writes a second row; dedup is the reader's job", () => {
  // Deliberate: the hook cannot know whether it is a re-fire or a second
  // agent, and suppressing here would need a read of the ledger on every
  // stop. The idempotency key is applied at read time — see
  // dedupeOutcomes in cmd/tkr/cmd_route_funnel.go — where it also
  // survives a crashed hook and a duplicated plugin registration.
  const fx = fixture();
  try {
    run(fx, stopEvent());
    const rows = run(fx, stopEvent());
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].agent_id, rows[1].agent_id);
  } finally {
    fx.cleanup();
  }
});

test("malformed stdin is a no-op, not a crash", () => {
  const fx = fixture();
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: "{not json",
      encoding: "utf8",
      env: { ...process.env, ...fx.env },
    });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, "{}");
    assert.deepStrictEqual(fx.rows(), []);
  } finally {
    fx.cleanup();
  }
});

test("an event from another hook is ignored", () => {
  const fx = fixture();
  try {
    const rows = run(fx, stopEvent({ hook_event_name: "Stop" }));
    assert.deepStrictEqual(rows, []);
  } finally {
    fx.cleanup();
  }
});

test("a payload with no hook_event_name is still accepted", () => {
  // Synthesized test stdin and older Claude Code builds both omit it.
  // Refusing those would make the hook untestable and silently inert on
  // exactly the installs least likely to notice.
  const fx = fixture();
  try {
    const e = stopEvent();
    delete e.hook_event_name;
    assert.strictEqual(run(fx, e).length, 1);
  } finally {
    fx.cleanup();
  }
});

for (const killSwitch of ["TKR_HOOKS_DISABLED", "TKR_SUBAGENT_OUTCOMES_DISABLED"]) {
  test(`${killSwitch}=1 writes nothing`, () => {
    const fx = fixture();
    try {
      const rows = run(fx, stopEvent(), { [killSwitch]: "1" });
      assert.deepStrictEqual(rows, []);
    } finally {
      fx.cleanup();
    }
  });
}

test("TKR_ROUTE_DISABLED does NOT suppress the ledger", () => {
  // Unrouted subagents are the control group. Dropping them whenever
  // routing is off would leave a funnel whose denominator moves with the
  // config, so the same measurement would mean two different things
  // before and after a toggle.
  const fx = fixture();
  try {
    const rows = run(fx, stopEvent(), { TKR_ROUTE_DISABLED: "1" });
    assert.strictEqual(rows.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("an unwritable ledger path does not fail the hook", () => {
  const fx = fixture();
  try {
    // Root the ledger under a regular file: every mkdir/open below it
    // fails with ENOTDIR, which mkdirSync(recursive) cannot paper over.
    const blocker = path.join(fx.dir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(stopEvent()),
      encoding: "utf8",
      env: {
        ...process.env,
        ...fx.env,
        TKR_SUBAGENT_OUTCOMES_PATH: path.join(blocker, "nested", "outcomes.jsonl"),
      },
    });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, "{}");
  } finally {
    fx.cleanup();
  }
});

// ── Unit surface ────────────────────────────────────────────────────────────

test("buildRow tolerates a payload with nothing in it", () => {
  const r = buildRow({});
  assert.strictEqual(r.prompt_id, "");
  assert.strictEqual(r.agent_id, "");
  assert.strictEqual(r.agent_type, "");
  assert.strictEqual(r.completion, "stopped");
  assert.strictEqual(r.verification, "not_observed");
});

// ── Self-report parsing (schema v2) ─────────────────────────────────────────
//
// The contract is a fenced `tkr-handoff` block emitted by the worker. Two
// properties matter more than parsing every shape a worker might produce:
// a malformed or absent block must degrade to exactly the v1 behavior, and
// no free text from the worker's message may reach the ledger by any path.

const {
  parseHandoff,
  MAX_DECLARED_COUNT,
} = require("./subagent-outcome.js");

function block(body) {
  return "Some prose about the work.\n\n```tkr-handoff\n" + body + "\n```";
}

test("parseHandoff reads a well-formed block", () => {
  const r = parseHandoff(block("outcome: partial\ngaps: 2\nassumptions: 1"));
  assert.deepStrictEqual(r, { outcome: "partial", gaps: 2, assumptions: 1 });
});

test("parseHandoff returns null when there is no block", () => {
  assert.strictEqual(parseHandoff("I looked at the file and it seemed fine."), null);
  assert.strictEqual(parseHandoff(""), null);
  assert.strictEqual(parseHandoff(undefined), null);
  assert.strictEqual(parseHandoff(null), null);
  assert.strictEqual(parseHandoff({ outcome: "answered" }), null);
});

test("parseHandoff requires outcome — counts alone are not a self-report", () => {
  // A block that declares gaps but never says whether it finished has not
  // made the claim the field exists to capture. Recording the counts alone
  // would imply a completeness statement the worker never wrote.
  assert.strictEqual(parseHandoff(block("gaps: 0\nassumptions: 3")), null);
});

test("parseHandoff rejects an outcome outside the vocabulary", () => {
  assert.strictEqual(parseHandoff(block("outcome: mostly done")), null);
  assert.strictEqual(parseHandoff(block("outcome: SUCCESS")), null);
  // ...but the documented values are accepted case-insensitively, since a
  // worker echoing the template's capitalization is not an error.
  assert.strictEqual(parseHandoff(block("outcome: Answered")).outcome, "answered");
});

test("parseHandoff drops unparseable counts but keeps the outcome", () => {
  // parseInt would read "2 of the callers" as 2 and invent precision the
  // worker never expressed. Strict digits only.
  const r = parseHandoff(block("outcome: answered\ngaps: 2 of the callers\nassumptions: none"));
  assert.deepStrictEqual(r, { outcome: "answered" });
  assert.strictEqual(r.gaps, undefined);
});

test("parseHandoff keeps a declared zero distinct from an absent count", () => {
  const declared = parseHandoff(block("outcome: answered\ngaps: 0"));
  assert.strictEqual(declared.gaps, 0);
  const silent = parseHandoff(block("outcome: answered"));
  assert.strictEqual(silent.gaps, undefined);
  assert.ok(!("gaps" in silent));
});

test("parseHandoff clamps an absurd count", () => {
  const r = parseHandoff(block("outcome: partial\ngaps: 999999999"));
  assert.strictEqual(r.gaps, MAX_DECLARED_COUNT);
});

test("parseHandoff takes the last block when a worker explains the format first", () => {
  const msg =
    block("outcome: answered") +
    "\n\nthat was the template; here is my actual report\n\n" +
    "```tkr-handoff\noutcome: unanswered\ngaps: 4\n```";
  assert.deepStrictEqual(parseHandoff(msg), { outcome: "unanswered", gaps: 4 });
});

test("parseHandoff ignores a block buried beyond the tail scan window", () => {
  // The block is a trailer by contract. A hot-path hook must not scan a
  // runaway message end to end looking for one.
  const msg = block("outcome: answered") + "x".repeat(8192);
  assert.strictEqual(parseHandoff(msg), null);
});

test("buildRow records a self-report without touching verification", () => {
  const r = buildRow(
    stopEvent({ last_assistant_message: block("outcome: partial\ngaps: 2\nassumptions: 1") })
  );
  assert.strictEqual(r.declared_outcome, "partial");
  assert.strictEqual(r.declared_gaps, 2);
  assert.strictEqual(r.declared_assumptions, 1);
  // The load-bearing assertion of this whole file: a worker's claim about
  // itself must not become tkr's verdict about the worker.
  assert.strictEqual(r.verification, "not_observed");
  assert.strictEqual(r.completion, "stopped");
  assert.strictEqual(r.schema_version, SCHEMA_VERSION);
});

test("buildRow omits the declared fields entirely when no block was emitted", () => {
  // A v2 row from a silent worker must be indistinguishable from a v1 row
  // apart from schema_version — absence of a self-report is the default,
  // not a failure state.
  const r = buildRow(stopEvent());
  assert.ok(!("declared_outcome" in r));
  assert.ok(!("declared_gaps" in r));
  assert.ok(!("declared_assumptions" in r));
});

test("a self-report does not smuggle worker prose into the ledger", () => {
  const fx = fixture();
  try {
    // Sentinel deliberately unlike a real provider key — see the note in
    // hooks/lib/rewrite-miss.test.js. The assertion is about the ledger
    // carrying no message text, which any distinctive string proves.
    const secret = "the credential is tkr-test-sentinel-do-not-log and the customer is Initech";
    const msg = secret + "\n\n```tkr-handoff\noutcome: answered\ngaps: 0\n```";
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(stopEvent({ last_assistant_message: msg })),
      encoding: "utf8",
      env: { ...process.env, ...fx.env },
    });
    assert.strictEqual(res.status, 0);
    const rows = fx.rows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].declared_outcome, "answered");
    // Whole-file check, not a field check: the point is that no path
    // through the parser can carry the message text, however it is shaped.
    const raw = fs.readFileSync(fx.ledger, "utf8");
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes("tkr-test-sentinel-do-not-log"));
    assert.ok(!raw.includes("Initech"));
  } finally {
    fx.cleanup();
  }
});
