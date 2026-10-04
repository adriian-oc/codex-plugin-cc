import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BEGIN, installCodexConfig, installStatusline, uninstallCodexConfig, uninstallStatusline } from "../src/install.mjs";
import { HERE, tmpdir } from "./helpers.mjs";

const SERVER = path.join(HERE, "..", "bin", "ccd-mcp.mjs");

function mcpSession(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { child, request, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`) };
}

test("MCP stdio server: initialize, tools/list, tools/call, argument validation, unknown method", async () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ codex: { bin: "/nonexistent/codex" }, claude: { bin: "/nonexistent/claude" } }));
  const s = mcpSession({ CCD_HOME: home });
  try {
    const discover = await s.request("server/discover", {});
    assert.equal(discover.error.code, -32601, "legacy-era server: modern probe falls back to initialize");
    const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions, /untrusted data/);
    s.notify("notifications/initialized");
    const list = await s.request("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["capacity_status", "plan_task", "task_create", "task_status", "task_result", "task_run_checks", "task_review", "task_request_fix", "task_resume", "task_cancel", "task_finalize_direct"]) assert.ok(names.includes(n), n);
    assert.ok(list.result.tools.every((t) => t.inputSchema.type === "object"));
    const cap = await s.request("tools/call", { name: "capacity_status", arguments: {} });
    assert.equal(cap.result.isError, undefined);
    assert.equal(cap.result.structuredContent.providers.claude.state, "unknown");
    assert.equal(cap.result.structuredContent.refresh.codex.reason, "error", "missing codex binary is reported, not hidden");
    const bad = await s.request("tools/call", { name: "task_status", arguments: { taskId: "../../etc" } });
    assert.equal(bad.result.isError, true);
    const extra = await s.request("tools/call", { name: "capacity_status", arguments: { nope: 1 } });
    assert.equal(extra.result.isError, true);
    const unknown = await s.request("tools/call", { name: "no_such_tool", arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const manual = await s.request("tools/call", { name: "capacity_record_manual", arguments: { provider: "claude", window: "five_hour", usedPercent: 42 } });
    assert.equal(manual.result.structuredContent.recorded.source, "manual");
  } finally {
    s.child.kill();
  }
});

test("Codex config: existing content preserved, idempotent, backups, conflicting entry refused, clean uninstall", () => {
  const codexHome = tmpdir();
  const file = path.join(codexHome, "config.toml");
  const original = 'model = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "x"\n';
  fs.writeFileSync(file, original);
  const r1 = installCodexConfig({ codexHome, serverPath: "/opt/ccd/bin/ccd-mcp.mjs", nodePath: "/usr/local/bin/node", home: "/Users/me/.ccd" });
  assert.ok(fs.existsSync(r1.backup));
  const after1 = fs.readFileSync(file, "utf8");
  assert.ok(after1.startsWith(original.trimEnd()));
  assert.match(after1, /\[mcp_servers\.claude_director\]/);
  installCodexConfig({ codexHome, serverPath: "/opt/ccd/bin/ccd-mcp.mjs", nodePath: "/usr/local/bin/node", home: "/Users/me/.ccd" });
  assert.equal(fs.readFileSync(file, "utf8").split(BEGIN).length, 2, "installed once");
  const un = uninstallCodexConfig({ codexHome });
  assert.equal(un.removed, true);
  assert.equal(fs.readFileSync(file, "utf8").trimEnd(), original.trimEnd());
  fs.writeFileSync(file, "[mcp_servers.claude_director]\ncommand = \"mine\"\n");
  assert.throws(() => installCodexConfig({ codexHome, serverPath: "/x" }), /outside our markers/);
});

test("status line bridge keeps only rate limits and chains the user's previous status line", () => {
  const claudeHome = tmpdir();
  const home = tmpdir();
  const bridgePath = path.join(HERE, "..", "bin", "ccd-statusline.mjs");
  fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ model: "opus", statusLine: { type: "command", command: "echo previous-line" } }));
  const r = installStatusline({ claudeHome, bridgePath, home });
  assert.equal(r.chained, true);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8"));
  assert.equal(settings.model, "opus");
  const out = spawnSync(process.execPath, [bridgePath], {
    input: JSON.stringify({ session_id: "s", transcript_path: "/secret/path.jsonl", version: "2.1.300", rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 } } }),
    env: { ...process.env, CCD_HOME: home },
    encoding: "utf8"
  });
  assert.equal(out.stdout.trim(), "previous-line");
  const snap = JSON.parse(fs.readFileSync(path.join(home, "telemetry", "claude-statusline.json"), "utf8"));
  assert.equal(snap.rate_limits.five_hour.used_percentage, 23.5);
  assert.doesNotMatch(JSON.stringify(snap), /secret|transcript/);
  const u = uninstallStatusline({ claudeHome, home, bridgePath });
  assert.equal(u.restored, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8")).statusLine.command, "echo previous-line");
});
