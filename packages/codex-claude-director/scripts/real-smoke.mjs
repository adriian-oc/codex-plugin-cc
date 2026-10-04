#!/usr/bin/env node
// REAL smoke test against the installed, authenticated Claude Code CLI.
// It spends a small amount of real Claude usage (one short task, default
// model "haiku", max 8 turns). It uses a throw-away repository and a
// throw-away coordinator state home, so your real state is untouched.
//
// The "review" step here is a scripted stand-in for Codex (it checks the
// files and the check results). It validates the coordinator mechanics with
// the real CLI; it is NOT a Codex review.
//
// Usage: node scripts/real-smoke.mjs [--model haiku] [--keep]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG } from "../src/config.mjs";
import * as O from "../src/orchestrator.mjs";
import { deepMerge } from "../src/util.mjs";

const argv = process.argv.slice(2);
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "haiku";
const which = (b) => spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", b], { encoding: "utf8" }).stdout.trim();
const claudeBin = which("claude");
if (!claudeBin) throw new Error("claude not found in PATH");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-real-"));
const repo = path.join(root, "repo");
const home = path.join(root, "state");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "smoke@example.com");
git("config", "user.name", "smoke");
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "smoke", type: "module", private: true }, null, 2));
fs.writeFileSync(path.join(repo, ".codex-claude-director.json"), JSON.stringify({
  checks: [{ name: "unit", argv: ["node", "--test", "test/"], timeoutSec: 120 }],
  claudeAllowedBash: ["Bash(node --test *)", "Bash(node --test)"]
}, null, 2));
fs.writeFileSync(path.join(repo, "src", ".gitkeep"), "");
git("add", "-A");
git("commit", "-q", "-m", "init");

const config = deepMerge(DEFAULT_CONFIG, {
  claude: { bin: claudeBin, model, maxTurns: 8, timeoutMin: 10 },
  // This throw-away run has no Codex telemetry in this environment; the
  // assumption is explicit and visible in the plan output.
  telemetry: { unknownPolicy: "assume_used", assumeUsedPct: 50 }
});
const ctx = O.createContext({ home, config });
const log = (label, v) => process.stdout.write(`\n## ${label}\n${JSON.stringify(v, null, 2)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(id) {
  for (;;) {
    const s = await O.taskStatus(ctx, { taskId: id });
    if (!["running", "checks_running", "ready"].includes(s.status)) return s;
    await sleep(2000);
  }
}

const criteria = [
  { id: "AC1", text: "src/sum.js exports a function sum(a, b) returning a + b" },
  { id: "AC2", text: "test/sum.test.js uses node:test and covers sum(2, 3) === 5" }
];
log("doctor", await O.doctor(ctx));
const t = await O.createTask(ctx, { repo, title: "sum function", objective: "Create src/sum.js (ES module) exporting sum(a, b) and a node:test test in test/sum.test.js.", acceptanceCriteria: criteria, scopePaths: ["src", "test"], size: "S", complexity: "low", agent: "claude" });
log("task_create", { status: t.status, reason: t.statusReason, plan: t.plan });
let s = await wait(t.taskId);
log("after implementation", { status: s.status, reason: s.statusReason, lastRun: s.lastRun, claudeSession: s.claudeSession });
let rounds = 0;
for (;;) {
  const res = await O.taskResult(ctx, { taskId: t.taskId });
  log("task_result", { tree: res.tree, files: res.files, outOfScope: res.scope.outOfScope, worker: res.workerReport?.structured });
  s = await O.runChecks(ctx, { taskId: t.taskId, waitSec: 50 });
  while (s.status === "checks_running") s = await wait(t.taskId);
  log("checks", s.lastChecks);
  const files = Object.fromEntries(res.files.map((f) => [f.path, f.change]));
  const ok = s.lastChecks.passed && files["src/sum.js"] && files["test/sum.test.js"];
  const tree = (await O.taskResult(ctx, { taskId: t.taskId })).tree;
  if (ok) {
    const acc = await O.reviewTask(ctx, { taskId: t.taskId, tree, verdict: "accept", criteria: criteria.map((c) => ({ id: c.id, met: true, evidence: "scripted smoke review: file present and `node --test` passed on this tree" })) });
    log("accepted", { status: acc.status, acceptedCommit: acc.acceptedCommit, branch: acc.branch });
    break;
  }
  if (rounds >= 1) {
    log("not accepted", s);
    break;
  }
  rounds += 1;
  await O.reviewTask(ctx, { taskId: t.taskId, tree, verdict: "changes_requested", findings: ["Make `node --test test/` pass and keep both files."] });
  await O.requestFix(ctx, { taskId: t.taskId });
  s = await wait(t.taskId);
  log("after fix", { status: s.status, lastRun: s.lastRun });
}
const cap = await O.capacityStatus(ctx);
log("claude telemetry observed during the run", cap.providers.claude.windows);
log("state", { root, keep: argv.includes("--keep") });
if (!argv.includes("--keep")) {
  O.cleanupTask(ctx, { taskId: t.taskId, removeWorktree: true }).catch(() => {});
}
