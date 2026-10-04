#!/usr/bin/env node
// Simulated Claude Code CLI for tests. Behaviour comes from a scenario file
// (FAKE_CLAUDE_SCENARIO); every invocation is logged to FAKE_CLAUDE_LOG.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const scenarioFile = process.env.FAKE_CLAUDE_SCENARIO;
const logFile = process.env.FAKE_CLAUDE_LOG;

if (args[0] === "--version") {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  const method = process.env.FAKE_CLAUDE_AUTH ?? "claude.ai";
  console.log(JSON.stringify({ loggedIn: method !== "none", authMethod: method, subscriptionType: "max" }));
  process.exit(method === "none" ? 1 : 0);
}

const stdin = fs.readFileSync(0, "utf8");
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const sessionId = valueOf("--resume") ?? valueOf("--session-id") ?? randomUUID();
const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
const counterFile = `${scenarioFile}.count`;
const n = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0;
fs.writeFileSync(counterFile, String(n + 1));
const run = scenario.runs[Math.min(n, scenario.runs.length - 1)];
if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ n, args, prompt: stdin, cwd: process.cwd(), env: { worker: process.env.CODEX_CLAUDE_DIRECTOR_WORKER ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null, secret: process.env.MY_SECRET_TOKEN ?? null } })}\n`);

const emit = (obj) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...obj })}\n`);
emit({ type: "system", subtype: "init", model: "claude-test", claude_code_version: "2.1.300", permissionMode: valueOf("--permission-mode"), tools: [] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let usageTokens = run.contextTokens ?? 1000;
for (const a of run.actions ?? []) {
  if (a.write) {
    fs.mkdirSync(path.dirname(a.write), { recursive: true });
    fs.writeFileSync(a.write, a.content ?? "");
  } else if (a.delete) {
    fs.rmSync(a.delete, { force: true });
  } else if (a.sleep) {
    await sleep(a.sleep);
  } else if (a.spawnChild) {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.writeFileSync(a.spawnChild, String(child.pid));
  } else if (a.rateLimit) {
    emit({ type: "rate_limit_event", rate_limit_info: a.rateLimit, uuid: randomUUID() });
  } else if (a.invalid) {
    process.stdout.write("this is not json\n");
  } else if (a.permissionDenied) {
    emit({ type: "system", subtype: "permission_denied", tool_name: a.permissionDenied });
  } else if (a.assistantError) {
    emit({ type: "assistant", error: a.assistantError, message: { content: [] } });
  }
}
emit({ type: "assistant", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: usageTokens, output_tokens: 50 }, content: [] }, parent_tool_use_id: null });

if (run.result === "none") process.exit(run.exitCode ?? 1);
if (run.result === "auth_error") {
  emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", num_turns: 0 });
  process.exit(1);
}
if (run.result === "rate_limited") {
  emit({ type: "result", subtype: "success", is_error: true, result: "You've hit your usage limit · resets 5pm", num_turns: 1 });
  process.exit(1);
}
emit({
  type: "result",
  subtype: run.result ?? "success",
  is_error: (run.result ?? "success") !== "success",
  result: run.text ?? "done",
  structured_output: run.report === undefined ? { summary: "implemented", filesChanged: [], blocked: false } : run.report,
  num_turns: 3,
  duration_ms: 100,
  total_cost_usd: 0.12,
  usage: { input_tokens: 100, output_tokens: 50 },
  modelUsage: { "claude-test": { contextWindow: 200000, costUSD: 0.12 } },
  permission_denials: []
});
process.exit(run.exitCode ?? 0);
