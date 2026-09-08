// Stage 4b of #664 node-bootstrap-removal: .claude-plugin/plugin.json must
// carry no "node " invocation anywhere -- hooks or mcpServers -- now that
// bin/tkr-launcher.js is off the hot path (SessionStart --ensure removed,
// mcpServers.tkr repointed at the bare `tkr` binary). A future edit that
// reintroduces a `node ...` command string would silently reopen the
// no-Node-host failure mode ADR-0041 exists to close, with no other signal
// short of a live install on a Node-free host.
//
// `bash ${CLAUDE_PLUGIN_ROOT}/hooks/keepalive/cleanup.sh` is explicitly
// allowlisted -- it is not a Node dependency, but the guard would otherwise
// need a bare substring match on "node" that also flags words like
// "cleanup" incidentally; naming it here makes the guard's silence on it a
// decision, not an oversight.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const pluginJsonPath = path.join(repoRoot, ".claude-plugin", "plugin.json");

const ALLOWLISTED_COMMANDS = new Set([
  "bash ${CLAUDE_PLUGIN_ROOT}/hooks/keepalive/cleanup.sh",
]);

function collectCommandStrings(plugin) {
  const commands = [];

  for (const events of Object.values(plugin.hooks || {})) {
    for (const entry of events) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command === "string") commands.push(hook.command);
      }
    }
  }

  for (const server of Object.values(plugin.mcpServers || {})) {
    if (typeof server.command === "string") commands.push(server.command);
    // args form: {"command": "tkr", "args": ["mcp"]} -- join for one check.
    if (Array.isArray(server.args)) {
      commands.push([server.command, ...server.args].join(" "));
    }
  }

  return commands;
}

test("plugin.json manifest: no command string invokes node (#664 Stage 4b)", () => {
  const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  const commands = collectCommandStrings(plugin);

  const offenders = commands.filter(
    (cmd) => /(^|\s)node(\.exe)?(\s|$)/i.test(cmd) && !ALLOWLISTED_COMMANDS.has(cmd),
  );

  assert.deepStrictEqual(
    offenders,
    [],
    `plugin.json command(s) invoke node, reopening the no-Node-host failure ` +
      `mode ADR-0041 closed: ${offenders.join("; ")}`,
  );
});
