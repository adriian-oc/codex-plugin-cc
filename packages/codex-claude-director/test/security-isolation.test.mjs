import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildClaudeArgs, classifyRun, parseClaudeStream } from "../src/claude-worker.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import * as O from "../src/orchestrator.mjs";
import { redact, scrubEnv } from "../src/security.mjs";
import { CHECK_PASS_IF_FILE, invocations, makeCtx, makeRepo, notRunning, setClaude, sh, tmpdir, waitFor } from "./helpers.mjs";

test("worker environment: API key and unrelated secrets removed, worker marker set", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnop", MY_SECRET_TOKEN: "s3cr3t" } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  await waitFor(ctx, t.taskId, notRunning);
  const call = invocations(ctx)[0];
  assert.equal(call.env.apiKey, null);
  assert.equal(call.env.secret, null);
  assert.equal(call.env.worker, "1");
});

test("billing guard: API-key authentication is refused unless explicitly allowed", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ env: { FAKE_CLAUDE_AUTH: "api_key" } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  assert.equal(t.status, "blocked");
  assert.match(t.statusReason, /bill an API account/);
  assert.equal(invocations(ctx).length, 0, "Claude never started");
  const unauth = makeCtx({ env: { FAKE_CLAUDE_AUTH: "none" } });
  setClaude(unauth, 10, 10);
  const t2 = await O.createTask(unauth, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  assert.match(t2.statusReason, /not authenticated/);
});

test("nested delegation from inside a worker is refused (no Claude→Codex→Claude loop)", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ env: { CODEX_CLAUDE_DIRECTOR_WORKER: "1" } });
  setClaude(ctx, 10, 10);
  await assert.rejects(() => O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"] }), /Nested delegation refused/);
  const p = await O.plan(ctx, {});
  assert.equal(p.decision, "refuse");
});

test("worker invocation: explicit permissions, no MCP servers, no user plugins, no bypass", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.claude.permissionMode = "bypassPermissions"; // even if misconfigured
  const args = buildClaudeArgs(cfg, { sessionId: "11111111-1111-1111-1111-111111111111", extraAllowed: ["Bash(npm test *)"] });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.ok(args.includes("mcp__*") && args.includes("Bash(codex *)") && args.includes("Bash(git push *)"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
  assert.ok(args.includes("Bash(npm test *)"));
  assert.ok(!args.includes("--bare"), "--bare would require an API key instead of the subscription");
  assert.match(args[args.indexOf("--settings") + 1], /"sandbox"/);
});

test("invalid / incomplete stream and permission denials are classified, never treated as success", () => {
  const dir = tmpdir();
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, ['{"type":"system","subtype":"init","session_id":"abc"}', "garbage", '{"type":"system","subtype":"permission_denied","tool_name":"Bash"}'].join("\n"));
  const p = parseClaudeStream(f);
  assert.equal(p.invalidLines, 1);
  assert.equal(p.permissionDenials.length, 1);
  assert.equal(classifyRun({ reason: "exited", exitCode: 0 }, p), "incomplete");
  fs.writeFileSync(f, '{"type":"result","subtype":"success","is_error":false,"result":"ok","structured_output":null}\n');
  assert.equal(classifyRun({ reason: "exited", exitCode: 0 }, parseClaudeStream(f)), "completed_invalid_report");
  fs.writeFileSync(f, '{"type":"result","subtype":"error_max_turns","is_error":true}\n');
  assert.equal(classifyRun({ reason: "exited", exitCode: 1 }, parseClaudeStream(f)), "max_turns");
});

test("incomplete worker response becomes 'interrupted' with work preserved", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ scenario: { runs: [{ actions: [{ write: "a.txt", content: "1" }, { invalid: true }, { permissionDenied: "Bash" }], result: "none", exitCode: 0 }] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  const s = await waitFor(ctx, t.taskId, notRunning);
  assert.equal(s.status, "interrupted");
  assert.equal(s.lastRun.outcome, "incomplete");
  assert.match(s.statusReason, /denied by the permission policy/);
  assert.equal(s.lastRun.permissionDenials, 1);
});

test("checks come from the trusted base commit: a worker cannot rewrite them; protected changes block acceptance", async () => {
  const repo = makeRepo({ projectConfig: { checks: [CHECK_PASS_IF_FILE("required.txt")] } });
  const ctx = makeCtx({ scenario: { runs: [{ actions: [{ write: ".codex-claude-director.json", content: JSON.stringify({ checks: [{ name: "test", argv: ["true"] }] }) }] }] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  await waitFor(ctx, t.taskId, notRunning);
  const st = await O.runChecks(ctx, { taskId: t.taskId, waitSec: 20 });
  assert.equal(st.lastChecks.passed, false, "original check still applies");
  const res = await O.taskResult(ctx, { taskId: t.taskId });
  assert.deepEqual(res.protectedChanges, [".codex-claude-director.json"]);
  await assert.rejects(() => O.runChecks(ctx, { taskId: t.taskId, names: ["evil"] }), /Only configured checks/);
});

test("out-of-scope changes block acceptance unless acknowledged", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ scenario: { runs: [{ actions: [{ write: "src/in.js", content: "1" }, { write: "docs/out.md", content: "2" }] }] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], scopePaths: ["src"], size: "S" });
  await waitFor(ctx, t.taskId, notRunning);
  const res = await O.taskResult(ctx, { taskId: t.taskId });
  assert.deepEqual(res.scope.outOfScope, ["docs/out.md"]);
  const crit = [{ id: "AC1", met: true, evidence: "checked" }];
  await assert.rejects(() => O.reviewTask(ctx, { taskId: t.taskId, tree: res.tree, verdict: "accept", criteria: crit, acknowledge: { noChecks: true } }), /outside the declared scope/);
  const ok = await O.reviewTask(ctx, { taskId: t.taskId, tree: res.tree, verdict: "accept", criteria: crit, acknowledge: { noChecks: true, outOfScope: true } });
  assert.equal(ok.status, "accepted");
});

test("uncommitted source changes: refused by default, included as snapshot, or ignored with warning; source checkout untouched", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "src/keep.js"), "export const keep = 2; // local edit\n");
  fs.writeFileSync(path.join(repo, "local-new.txt"), "untracked\n");
  const ctx = makeCtx({ scenario: { runs: [{ actions: [{ write: "w.txt", content: "w" }] }] } });
  setClaude(ctx, 5, 5);
  const base = { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S", start: false };
  await assert.rejects(() => O.createTask(ctx, base), /uncommitted change\(s\)/);
  const inc = await O.createTask(ctx, { ...base, dirtyPolicy: "include", scopePaths: ["a"] });
  assert.equal(fs.readFileSync(path.join(inc.worktree, "local-new.txt"), "utf8"), "untracked\n");
  assert.match(fs.readFileSync(path.join(inc.worktree, "src/keep.js"), "utf8"), /local edit/);
  assert.match(sh(repo, "git", ["status", "--porcelain"]), /local-new.txt/, "user's working tree unchanged");
  const res = await O.taskResult(ctx, { taskId: inc.taskId });
  assert.equal(res.files.length, 0, "snapshot is the base: the user's edits are not attributed to the worker");
  const ign = await O.createTask(ctx, { ...base, dirtyPolicy: "ignore", scopePaths: ["b"] });
  assert.match(ign.warnings[0], /NOT visible/);
  assert.ok(!fs.existsSync(path.join(ign.worktree, "local-new.txt")));
});

test("credential redaction in worker output and check output", () => {
  const s = redact("token ghp_abcdefghijklmnopqrstuvwxyz123456 and sk-ant-api03-zzzzzzzzzzzzzzzz and AKIAABCDEFGHIJKLMNOP");
  assert.doesNotMatch(s, /ghp_|sk-ant|AKIA/);
  const { env, removed } = scrubEnv({ PATH: "/bin", GITHUB_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "y", CLAUDE_CODE_OAUTH_TOKEN: "z" }, { keep: ["CLAUDE_CODE_OAUTH_TOKEN"] });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "PATH"]);
  assert.deepEqual(removed.sort(), ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]);
});

test("state files are private to the user", async () => {
  const repo = makeRepo();
  const ctx = makeCtx();
  setClaude(ctx, 5, 5);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S", start: false });
  const mode = fs.statSync(path.join(ctx.p.tasksDir, t.taskId, "task.json")).mode & 0o777;
  assert.equal(mode & 0o077, 0);
});
