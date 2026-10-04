// Full simulated flow: request → allocation → implementation → diff → checks
// → review → correction → acceptance, with a simulated Claude CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as O from "../src/orchestrator.mjs";
import { CHECK_PASS_IF_FILE, invocations, makeCtx, makeRepo, notRunning, setClaude, sh, waitFor } from "./helpers.mjs";

const criteria = [{ id: "AC1", text: "src/feature.js exports feature()" }, { id: "AC2", text: "tests pass" }];

test("SIMULATED end-to-end: delegate, diff, failing checks, fix round with session reuse, accept, invalidate", async () => {
  const repo = makeRepo({ projectConfig: { checks: [CHECK_PASS_IF_FILE("src/fixed.txt")] } });
  const ctx = makeCtx({
    scenario: {
      runs: [
        { actions: [{ write: "src/feature.js", content: "export function feature() {}\n" }, { delete: "src/old.js" }, { rateLimit: { status: "allowed", rateLimitType: "five_hour", utilization: 0.3 } }, { rateLimit: { status: "allowed", rateLimitType: "five_hour", utilization: 0.36 } }] },
        { actions: [{ write: "src/fixed.txt", content: "ok\n" }] }
      ]
    }
  });
  setClaude(ctx, 20, 10);

  const plan = await O.plan(ctx, { size: "M" });
  assert.equal(plan.decision, "delegate_claude");
  assert.ok(plan.reservations.some((r) => r.provider === "codex" && r.phase === "review"), "review capacity reserved up-front");

  const created = await O.createTask(ctx, { repo, title: "feature", objective: "Add feature()", acceptanceCriteria: criteria, scopePaths: ["src"], size: "M" });
  assert.equal(created.agent, "claude");
  assert.match(created.branch, /^ccd\/task_/);
  assert.notEqual(created.worktree, repo);

  const done = await waitFor(ctx, created.taskId, notRunning);
  assert.equal(done.status, "pending_review", done.statusReason);
  // the source checkout is untouched
  assert.ok(!fs.existsSync(path.join(repo, "src/feature.js")));

  const result = await O.taskResult(ctx, { taskId: created.taskId, diff: "inline" });
  const changes = Object.fromEntries(result.files.map((f) => [f.path, f.change]));
  assert.equal(changes["src/feature.js"], "added");
  assert.equal(changes["src/old.js"], "deleted");
  assert.ok(fs.existsSync(result.patchFile));
  assert.match(result.inlineDiff.text, /deleted file mode/);
  assert.equal(result.workerReport.untrusted, true);

  // Exit code 0 is not validation: accepting before checks is refused.
  await assert.rejects(() => O.reviewTask(ctx, { taskId: created.taskId, tree: result.tree, verdict: "accept", criteria: criteria.map((c) => ({ id: c.id, met: true, evidence: "seen" })) }), /No completed check run/);

  const checked = await O.runChecks(ctx, { taskId: created.taskId, waitSec: 20 });
  assert.equal(checked.lastChecks.passed, false);
  await assert.rejects(() => O.reviewTask(ctx, { taskId: created.taskId, tree: result.tree, verdict: "accept", criteria: criteria.map((c) => ({ id: c.id, met: true, evidence: "seen" })) }), /did not pass/);

  const reviewed = await O.reviewTask(ctx, { taskId: created.taskId, tree: result.tree, verdict: "changes_requested", findings: ["create src/fixed.txt"] });
  assert.equal(reviewed.status, "changes_requested");

  const fix = await O.requestFix(ctx, { taskId: created.taskId });
  assert.equal(fix.fixRound, 1);
  const fixed = await waitFor(ctx, created.taskId, notRunning);
  assert.equal(fixed.status, "pending_review", fixed.statusReason);
  const calls = invocations(ctx);
  assert.equal(calls.length, 2);
  const resumeIdx = calls[1].args.indexOf("--resume");
  assert.ok(resumeIdx > 0, "correction reuses the Claude session");
  assert.equal(calls[1].args[resumeIdx + 1], calls[0].args[calls[0].args.indexOf("--session-id") + 1]);
  assert.match(calls[1].prompt, /create src\/fixed.txt/);
  assert.doesNotMatch(calls[1].prompt, /## Objective/, "resumed round sends only the findings, not the whole brief");

  const r2 = await O.taskResult(ctx, { taskId: created.taskId });
  await O.runChecks(ctx, { taskId: created.taskId, waitSec: 20 });
  const accepted = await O.reviewTask(ctx, { taskId: created.taskId, tree: r2.tree, verdict: "accept", criteria: criteria.map((c) => ({ id: c.id, met: true, evidence: "verified in diff and check run" })) });
  assert.equal(accepted.status, "accepted");
  assert.match(accepted.statusReason, /two different models/);
  assert.equal(accepted.reservations.filter((r) => r.state === "active").length, 0, "active reservations released");

  // Learned sample recorded from utilization change inside the run (0.30 → 0.36).
  const samples = JSON.parse(fs.readFileSync(ctx.p.samples, "utf8"));
  assert.ok(Math.abs(samples["claude:implement:M:five_hour"].values[0] - 6) < 0.01);

  // Nothing merged into the source branch.
  assert.equal(sh(repo, "git", ["rev-parse", "main"]), created.baseCommit);

  // Any later modification invalidates the acceptance.
  fs.writeFileSync(path.join(accepted.worktree, "src/feature.js"), "tampered\n");
  const after = await O.taskStatus(ctx, { taskId: created.taskId });
  assert.equal(after.status, "pending_review");
  assert.ok(after.reviews.find((r) => r.verdict === "accept").invalidated);
});

test("review bound to an exact tree: stale tree refused; file-modifying checks require reviewing the post-check tree", async () => {
  const formatter = { name: "fmt", argv: [process.execPath, "-e", "require('fs').writeFileSync('src/feature.js','formatted\\n')"], timeoutSec: 30 };
  const repo = makeRepo({ projectConfig: { checks: [formatter] } });
  const ctx = makeCtx({ scenario: { runs: [{ actions: [{ write: "src/feature.js", content: "raw\n" }] }] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  await waitFor(ctx, t.taskId, notRunning);
  const before = await O.taskResult(ctx, { taskId: t.taskId });
  const st = await O.runChecks(ctx, { taskId: t.taskId, waitSec: 20 });
  assert.equal(st.lastChecks.passed, true);
  assert.deepEqual(st.lastChecks.modifiedFiles, ["modified:src/feature.js"]);
  await assert.rejects(() => O.reviewTask(ctx, { taskId: t.taskId, tree: before.tree, verdict: "accept", criteria: [{ id: "AC1", met: true, evidence: "ok!" }] }), /worktree is now/);
  const after = await O.taskResult(ctx, { taskId: t.taskId });
  assert.notEqual(after.tree, before.tree);
  const acc = await O.reviewTask(ctx, { taskId: t.taskId, tree: after.tree, verdict: "accept", criteria: [{ id: "AC1", met: true, evidence: "ok!" }] });
  assert.equal(acc.status, "accepted");
});

test("maximum automatic correction rounds is enforced and work is preserved", async () => {
  const repo = makeRepo({ projectConfig: { checks: [CHECK_PASS_IF_FILE("never.txt")] } });
  const ctx = makeCtx({ config: { maxFixRounds: 2 }, scenario: { runs: [{ actions: [{ write: "a.txt", content: "1" }] }] } });
  setClaude(ctx, 5, 5);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S" });
  await waitFor(ctx, t.taskId, notRunning);
  for (let round = 1; round <= 2; round += 1) {
    await O.runChecks(ctx, { taskId: t.taskId, waitSec: 20 });
    const s = await O.requestFix(ctx, { taskId: t.taskId, findings: ["still failing"] });
    assert.equal(s.fixRound, round);
    await waitFor(ctx, t.taskId, notRunning);
  }
  await O.runChecks(ctx, { taskId: t.taskId, waitSec: 20 });
  const blocked = await O.requestFix(ctx, { taskId: t.taskId, findings: ["still failing"] });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.statusReason, /Maximum automatic correction rounds \(2\)/);
  assert.equal(invocations(ctx).length, 3);
  assert.ok(fs.existsSync(path.join(blocked.worktree, "a.txt")));
});

test("config cannot raise fix rounds above the hard cap", async () => {
  const { loadConfig } = await import("../src/config.mjs");
  const { tmpdir } = await import("./helpers.mjs");
  const home = tmpdir();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ maxFixRounds: 50 }));
  assert.equal(loadConfig(home).maxFixRounds, 5);
});

test("codex direct implementation is labelled a self-check, and an independent Claude review is advisory", async () => {
  const repo = makeRepo();
  const ctx = makeCtx({ scenario: { runs: [{ report: { verdict: "changes_requested", findings: [{ issue: "missing test" }], summary: "needs test" } }] } });
  setClaude(ctx, 10, 10);
  const t = await O.createTask(ctx, { repo, title: "t", objective: "o", acceptanceCriteria: ["x"], size: "S", agent: "codex" });
  assert.equal(t.status, "implementing_direct");
  fs.writeFileSync(path.join(t.worktree, "direct.txt"), "by codex\n");
  const fin = await O.finalizeDirect(ctx, { taskId: t.taskId, summary: "added direct.txt" });
  assert.equal(fin.status, "pending_review");
  await O.requestIndependentReview(ctx, { taskId: t.taskId });
  await waitFor(ctx, t.taskId, (s) => s.reviews.some((r) => r.by === "claude"));
  const call = invocations(ctx)[0];
  assert.ok(call.args.includes("Read") && call.args.includes("Edit"), "review run allows Read and denies Edit");
  assert.ok(call.args.indexOf("Edit") > call.args.indexOf("--disallowedTools"));
  const res = await O.taskResult(ctx, { taskId: t.taskId });
  assert.equal(res.independentReviews[0].verdict, "changes_requested");
  assert.equal(res.independentReviews[0].untrusted, true);
  const acc = await O.reviewTask(ctx, { taskId: t.taskId, tree: res.tree, verdict: "accept", criteria: [{ id: "AC1", met: true, evidence: "file present" }], acknowledge: { noChecks: true } });
  assert.match(acc.statusReason, /self-check/);
  assert.equal(acc.reviews.find((r) => r.verdict === "accept").independent, false);
});
