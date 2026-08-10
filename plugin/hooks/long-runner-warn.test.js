// Wave 8 — long-runner-warn.js test cases.
// Run: node --test hooks/long-runner-warn.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "long-runner-warn.js");
const lib = require("./long-runner-warn.js");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkr-l4-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(payload, env = {}) {
  return withTempDir((dir) => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, TKR_STATE_DIR: dir, ...env },
      encoding: "utf8",
    });
    let ledger = [];
    const lp = path.join(dir, "playbook-events.jsonl");
    if (fs.existsSync(lp)) {
      ledger = fs.readFileSync(lp, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    }
    return { res, ledger, dir };
  });
}

// ---- Pattern matching ----

test("matchPattern recognizes terraform apply", () => {
  const m = lib.matchPattern("terraform apply -auto-approve");
  assert.ok(m, "expected match");
  assert.strictEqual(m.name, "terraform_apply");
});

test("matchPattern recognizes gh run watch", () => {
  const m = lib.matchPattern("gh run watch 12345");
  assert.ok(m);
  assert.strictEqual(m.name, "gh_watch");
});

test("matchPattern recognizes gh pr checks --watch", () => {
  const m = lib.matchPattern("gh pr checks --watch");
  assert.ok(m);
  assert.strictEqual(m.name, "gh_watch");
});

test("matchPattern recognizes npm run dev/start/watch", () => {
  for (const cmd of ["npm run dev", "npm run start", "npm run watch"]) {
    const m = lib.matchPattern(cmd);
    assert.ok(m, `expected match for ${cmd}`);
    assert.strictEqual(m.name, "npm_long");
  }
});

test("matchPattern recognizes tsc --watch / tsc -w", () => {
  for (const cmd of ["tsc --watch", "tsc -w", "npx tsc -w --noEmit"]) {
    const m = lib.matchPattern(cmd);
    assert.ok(m, `expected match for ${cmd}`);
    assert.strictEqual(m.name, "tsc_watch");
  }
});

test("matchPattern recognizes pytest --watch", () => {
  const m = lib.matchPattern("pytest tests/ --watch");
  assert.ok(m);
  assert.strictEqual(m.name, "pytest_watch");
});

test("matchPattern recognizes tail -f", () => {
  const m = lib.matchPattern("tail -f /var/log/app.log");
  assert.ok(m);
  assert.strictEqual(m.name, "tail_follow");
});

test("matchPattern recognizes docker logs -f", () => {
  for (const cmd of ["docker logs -f my-container", "docker log -f svc"]) {
    const m = lib.matchPattern(cmd);
    assert.ok(m, `expected match for ${cmd}`);
    assert.strictEqual(m.name, "docker_logs_follow");
  }
});

test("matchPattern returns null for non-matching commands", () => {
  for (const cmd of ["ls -la", "git status", "go test ./...", "npm install", "echo hi"]) {
    assert.strictEqual(lib.matchPattern(cmd), null, `false positive on: ${cmd}`);
  }
});

test("matchPattern returns null on null/empty input", () => {
  assert.strictEqual(lib.matchPattern(null), null);
  assert.strictEqual(lib.matchPattern(""), null);
  assert.strictEqual(lib.matchPattern(undefined), null);
});

// ---- INV-104: segment splitting ----

test("splitSegments splits on &&, ||, |, ; and newline", () => {
  assert.deepStrictEqual(lib.splitSegments("a && b || c | d ; e\nf"), [
    "a", "b", "c", "d", "e", "f",
  ]);
});

test("splitSegments keeps separators inside quotes intact", () => {
  assert.deepStrictEqual(lib.splitSegments(`grep "a|b" x && echo 'c;d'`), [
    `grep "a|b" x`,
    `echo 'c;d'`,
  ]);
});

test("splitSegments does not split a lone & (2>&1, background)", () => {
  assert.deepStrictEqual(lib.splitSegments("go test ./... 2>&1"), ["go test ./... 2>&1"]);
  assert.deepStrictEqual(lib.splitSegments("sleep 5 &"), ["sleep 5 &"]);
});

test("splitSegments returns [] for empty/non-string input", () => {
  for (const v of ["", null, undefined, 42]) {
    assert.deepStrictEqual(lib.splitSegments(v), []);
  }
});

test("INV-104: a bounded `tail -2` plus a later `rm -f` is not tail -f", () => {
  // The live command from the filing: `.*` bridged these two segments.
  const cmd = `cd "C:/Users/x/proj" && git worktree list | tail -2 && git worktree prune && rm -f /tmp/msg.txt`;
  assert.strictEqual(lib.matchPattern(cmd), null, "must not match across segments");
});

test("INV-104: a real long-runner inside a compound command still matches", () => {
  const m = lib.matchPattern(`cd /srv/app && tail -f /var/log/app.log`);
  assert.ok(m, "expected match");
  assert.strictEqual(m.name, "tail_follow");
  assert.strictEqual(m.segment, "tail -f /var/log/app.log");
});

test("INV-104: the hint quotes the matched segment, not the head of the line", () => {
  const cmd = `cd "C:/Users/x/proj" && npm run dev`;
  const m = lib.matchPattern(cmd);
  const hint = lib.formatHint(m, cmd);
  assert.ok(hint.includes("npm run dev"), `hint should name the watcher: ${hint}`);
  assert.ok(!hint.includes("cd "), `hint must not name the cd: ${hint}`);
});

test("INV-104: telemetry command_signature is the matched segment", () => {
  const { res, ledger } = runHook({
    tool_name: "Bash",
    tool_input: { command: `cd /srv && tail -f /var/log/app.log` },
    session_id: "sid-inv104",
  });
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(ledger[0].trigger_state.matched_pattern, "tail_follow");
  assert.strictEqual(ledger[0].trigger_state.command_signature, "tail -f /var/log/app.log");
});

test("stripQuoted blanks quoted interiors but keeps unquoted flags", () => {
  assert.strictEqual(lib.stripQuoted(`node -e 'tail -2 rm -f'`), `node -e ''`);
  assert.strictEqual(lib.stripQuoted(`tail -f "my log.txt"`), `tail -f ""`);
});

test("INV-104: a shell snippet inside a quoted argument is not a watcher", () => {
  // Reproduced live while fixing INV-104: this exact call tripped the
  // installed hook. Both `tail` and `-f` live inside one quoted argument,
  // so segmentation alone does not separate them.
  const cmd = `node -e 'const c = "git worktree list | tail -2 && rm -f /tmp/m.txt";'`;
  assert.strictEqual(lib.matchPattern(cmd), null);
});

test("INV-104: a watcher with a quoted path argument still matches", () => {
  const m = lib.matchPattern(`tail -f "/var/log/my app.log"`);
  assert.ok(m, "quoting the path must not suppress a real match");
  assert.strictEqual(m.name, "tail_follow");
});

test("pattern precedence survives segmentation — earlier L4_PATTERNS entry wins", () => {
  // tail_follow is declared before docker_logs_follow; a command carrying
  // both must report the earlier one regardless of segment order.
  const m = lib.matchPattern("docker logs -f svc && tail -f a.log");
  assert.strictEqual(m.name, "tail_follow");
});

// ---- Hint formatting ----

test("formatHint includes command signature", () => {
  const m = lib.matchPattern("terraform apply -auto-approve");
  const hint = lib.formatHint(m, "terraform apply -auto-approve");
  assert.ok(hint.includes("terraform apply"));
  assert.ok(hint.includes("L4 long-runner"));
});

test("formatHint differentiates minutes vs unbounded duration class", () => {
  const tf = lib.formatHint(lib.matchPattern("terraform apply"), "terraform apply");
  const tail = lib.formatHint(lib.matchPattern("tail -f x.log"), "tail -f x.log");
  assert.ok(tf.includes("background-and-poll"));
  assert.ok(tail.includes("unbounded"));
});

// ---- End-to-end hook invocations ----

test("hook fires on matching Bash command + emits L4 event", () => {
  const { res, ledger } = runHook({
    tool_name: "Bash",
    tool_input: { command: "terraform apply -auto-approve" },
    session_id: "sid-fire-1",
  });
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.ok(out.hookSpecificOutput, "expected hookSpecificOutput");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("L4 long-runner"));
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(ledger[0].layer, "L4");
  assert.strictEqual(ledger[0].event, "fired");
  assert.strictEqual(ledger[0].trigger_state.matched_pattern, "terraform_apply");
});

test("hook silent on non-Bash tools", () => {
  const { res, ledger } = runHook({
    tool_name: "Edit",
    tool_input: { file_path: "x.go" },
    session_id: "sid-edit",
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook silent on non-matching Bash command", () => {
  const { res, ledger } = runHook({
    tool_name: "Bash",
    tool_input: { command: "go test ./..." },
    session_id: "sid-go",
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook respects TKR_PLAYBOOK_L4_DISABLED kill switch", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
      session_id: "sid-kill-1",
    },
    { TKR_PLAYBOOK_L4_DISABLED: "1" },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook respects TKR_PLAYBOOK_EXTENSIONS_DISABLED kill switch", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
      session_id: "sid-kill-2",
    },
    { TKR_PLAYBOOK_EXTENSIONS_DISABLED: "1" },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook respects global TKR_PLAYBOOK_DISABLED kill switch", () => {
  const { res, ledger } = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
      session_id: "sid-kill-3",
    },
    { TKR_PLAYBOOK_DISABLED: "1" },
  );
  assert.strictEqual(res.stdout.trim(), "{}");
  assert.strictEqual(ledger.length, 0);
});

test("hook tolerates malformed stdin", () => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: "{not json",
    env: { ...process.env, TKR_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "x-")) },
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), "{}");
});

// ---- Anti-spam ----

test("per-signature dedup: same pattern second time stays silent", () => {
  withTempDir((dir) => {
    const env = { ...process.env, TKR_STATE_DIR: dir };
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "terraform apply" },
      session_id: "sid-dedup",
    };
    const a = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, encoding: "utf8" });
    assert.notStrictEqual(a.stdout.trim(), "{}", "first fire expected");

    const b = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, encoding: "utf8" });
    assert.strictEqual(b.stdout.trim(), "{}", "second fire same signature must be silent");

    const ledger = fs
      .readFileSync(path.join(dir, "playbook-events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    assert.strictEqual(ledger.length, 1, "exactly one ledger event");
  });
});

test("session fire cap = 3 across distinct signatures", () => {
  withTempDir((dir) => {
    const env = { ...process.env, TKR_STATE_DIR: dir };
    const sid = "sid-cap";
    const cmds = [
      "terraform apply",
      "tail -f a.log",
      "npm run dev",
      "docker logs -f svc",
    ];
    let fires = 0;
    for (const cmd of cmds) {
      const res = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd }, session_id: sid }),
        env,
        encoding: "utf8",
      });
      if (res.stdout.trim() !== "{}") fires++;
    }
    assert.strictEqual(fires, lib.L4_FIRE_CAP, `expected ${lib.L4_FIRE_CAP} fires, got ${fires}`);
  });
});

test("per-session isolation — two sessions have independent fire caps", () => {
  withTempDir((dir) => {
    const env = { ...process.env, TKR_STATE_DIR: dir };
    const a = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "terraform apply" }, session_id: "sid-A" }),
      env,
      encoding: "utf8",
    });
    const b = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "terraform apply" }, session_id: "sid-B" }),
      env,
      encoding: "utf8",
    });
    assert.notStrictEqual(a.stdout.trim(), "{}", "session A should fire");
    assert.notStrictEqual(b.stdout.trim(), "{}", "session B should fire independently");
  });
});
