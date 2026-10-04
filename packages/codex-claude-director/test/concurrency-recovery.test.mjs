import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readLedger } from "../src/ledger.mjs";
import * as O from "../src/orchestrator.mjs";
import { cancelRun, runState, verifyRunner } from "../src/process-control.mjs";
import { pidAlive } from "../src/util.mjs";
import { FAKE_CLAUDE, HERE, invocations, makeCtx, makeRepo, notRunning, setClaude, waitFor } from "./helpers.mjs";

function runChild(args) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(HERE, "fixtures", "admit.mjs"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });
}

test("concurrent admissions from several processes and projects never over-reserve one account", async () => {
  const ctx = makeCtx();
  setClaude(ctx, 30, 10); // headroom 5h: 100-30-10 = 60; each S delegation reserves 8 + 2*4 = 16
  const repoA = makeRepo();
  const repoB = makeRepo();
  const jobs = [];
  for (let i = 0; i < 6; i += 1) jobs.push(runChild([ctx.home, i % 2 ? repoA : repoB, `dir${i}`, FAKE_CLAUDE]));
  const results = await Promise.all(jobs);
  const delegated = results.filter((r) => r.agent === "claude").length;
  assert.equal(delegated, 3, JSON.stringify(results));
  const ledger = readLedger(ctx.home);
  const claude5h = ledger.reservations.filter((r) => r.provider === "claude" && r.window === "five_hour").reduce((s, r) => s + r.amountPct, 0);
  assert.ok(claude5h <= 60, `reserved ${claude5h}`);
  assert.equal(new Set(ledger.reservations.map((r) => r.project)).size, 2, "one ledger shared by both projects");
});

test("overlapping scopes are not edited concurrently", async () => {
  const ctx = makeCtx();
  setClaude(ctx, 5, 5);
  const repo = makeRepo();
  const a = await O.createTask(ctx, { repo, title: "a", objective: "o", acceptanceCriteria: ["x"], scopePaths: ["src"], size: "S", start: false });
  assert.equal(a.status, "ready");
  const b = await O.createTask(ctx, { repo, title: "b", objective: "o", acceptanceCriteria: ["x"], scopePaths: ["src/keep.js"], size: "S", start: false });
  assert.equal(b.status, "queued");
  assert.match(b.statusReason, /overlaps/);
  await O.cancelTask(ctx, { taskId: a.taskId });
  const b2 = await O.resumeTask(ctx, { taskId: b.taskId });
  assert.notEqual(b2.status, "queued");
});

test("dependencies keep a task queued until the dependency is accepted", async () => {
  const ctx = makeCtx();
  setClaude(ctx, 5, 5);
  const repo = makeRepo();
  const a = await O.createTask(ctx, { repo, title: "a", objective: "o", acceptanceCriteria: ["x"], scopePaths: ["a"], size: "S", start: false });
  const b = await O.createTask(ctx, { repo, title: "b", objective: "o", acceptanceCriteria: ["x"], scopePaths: ["b"], size: "S", dependsOn: [a.taskId], start: false });
  assert.equal(b.status, "queued");
  assert.match(b.statusReason, /dependencies/);
});

test("usage limit reached during a run: changes preserved, task interrupted, resume refused until reset, then resumed in the same session", async () => {
  const repo = makeRepo();
  const resetsAt = Math.floor(Date.now() / 1000) + 2;
  const ctx = makeCtx({ scenario: { runs: [
    { actions: [{ write: "partial.txt", content: "half" }, { rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt } }], result: "rate_limited" },
    { actions: [{ write: "partial.txt", content: "done" }] }
  ] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  const s = await waitFor(ctx, t.taskId, notRunning);
  assert.equal(s.status, "interrupted");
  assert.match(s.statusReason, /usage limit/);
  assert.equal(s.lastRun.outcome, "quota_exhausted");
  const res = await O.taskResult(ctx, { taskId: t.taskId });
  assert.ok(res.files.some((f) => f.path === "partial.txt"), "partial work checkpointed");
  const cap = await O.capacityStatus(ctx);
  assert.equal(cap.providers.claude.state, "exhausted");
  await assert.rejects(() => O.resumeTask(ctx, { taskId: t.taskId }), /limit still reached/);
  await new Promise((r) => setTimeout(r, 2500));
  const resumed = await O.resumeTask(ctx, { taskId: t.taskId });
  assert.equal(resumed.status, "running");
  const done = await waitFor(ctx, t.taskId, notRunning);
  assert.equal(done.status, "pending_review");
  const calls = invocations(ctx);
  assert.ok(calls[1].args.includes("--resume"), "same Claude session resumed");
  assert.match(calls[1].prompt, /do not redo finished work/);
});

test("cancellation stops the worker and its child processes; worktree preserved", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ scenario: { runs: [{ actions: [{ write: "wip.txt", content: "wip" }, { spawnChild: "child.pid" }, { sleep: 60000 }] }] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  const pidFile = path.join(t.worktree, "child.pid");
  const end = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(pidAlive(grandchild));
  const c = await O.cancelTask(ctx, { taskId: t.taskId });
  assert.equal(c.status, "cancelled");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pidAlive(grandchild), false, "grandchild killed with the process group");
  assert.ok(fs.existsSync(path.join(t.worktree, "wip.txt")));
  assert.equal(readLedger(ctx.home).reservations.filter((r) => r.taskId === t.taskId && r.state === "active").length, 0);
});

test("lost runner (crash/reboot) is detected and the task becomes resumable", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ scenario: { runs: [{ actions: [{ write: "x.txt", content: "1" }, { sleep: 60000 }] }, {}] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  const task = O.loadTask(ctx, t.taskId);
  const runDir = task.runs[0].runDir;
  const end = Date.now() + 10000;
  // Wait until the worker has really started (it wrote x.txt) before crashing it.
  while (!(fs.existsSync(path.join(runDir, "runner.json")) && fs.existsSync(path.join(t.worktree, "x.txt"))) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const runner = JSON.parse(fs.readFileSync(path.join(runDir, "runner.json"), "utf8"));
  process.kill(runner.runnerPid, "SIGKILL"); // simulate crash: no exit record
  try { process.kill(-runner.childPid, "SIGKILL"); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  const s = await O.taskStatus(ctx, { taskId: t.taskId });
  assert.equal(s.status, "interrupted");
  assert.equal(s.lastRun.outcome, "runner_lost");
  const r = await O.resumeTask(ctx, { taskId: t.taskId });
  assert.equal(r.status, "running");
  await waitFor(ctx, t.taskId, notRunning);
});

test("a stored PID that now belongs to another process is never signalled", async () => {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, "fake-run");
  fs.mkdirSync(dir, { recursive: true });
  const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ nonce: "run_deadbeef0000", runnerPid: victim.pid, childPid: victim.pid, childSignature: "Mon Jan  1 00:00:00 2001 claude -p" }));
  assert.equal(verifyRunner(victim.pid, "run_deadbeef0000"), false);
  assert.equal(runState(dir).state, "lost");
  const res = await cancelRun(dir, { waitMs: 300 });
  assert.match(JSON.stringify(res.actions), /pid reused/);
  assert.ok(pidAlive(victim.pid), "unrelated process left alone");
  victim.kill();
});

test("timeout limit stops a hanging worker and marks it interrupted", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ config: { claude: { timeoutMin: 0.02 } }, scenario: { runs: [{ actions: [{ sleep: 60000 }] }] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  const s = await waitFor(ctx, t.taskId, notRunning, 30000);
  assert.equal(s.status, "interrupted");
  assert.equal(s.lastRun.outcome, "timeout");
});
