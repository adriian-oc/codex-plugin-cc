import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../src/config.mjs";
import { recordObservations, makeObservation } from "../src/capacity.mjs";
import { createContext, taskStatus } from "../src/orchestrator.mjs";
import { deepMerge } from "../src/util.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(HERE, "fixtures", "fake-claude.mjs");
// Files uploaded through GitHub's web UI lose the executable bit; restore it.
try {
  fs.chmodSync(FAKE_CLAUDE, 0o755);
} catch {}

export function tmpdir(prefix = "ccd-test-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function makeRepo({ files = {}, projectConfig } = {}) {
  const dir = tmpdir("ccd-repo-");
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "t@example.com"]);
  sh(dir, "git", ["config", "user.name", "Test"]);
  const all = { "README.md": "# demo\n", "src/keep.js": "export const keep = 1;\n", "src/old.js": "export const old = 1;\n", ...files };
  if (projectConfig) all[".codex-claude-director.json"] = JSON.stringify(projectConfig, null, 2);
  for (const [f, c] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "init"]);
  return dir;
}

export const CHECK_PASS_IF_FILE = (file) => ({ name: "test", argv: [process.execPath, "-e", `process.exit(require('fs').existsSync(${JSON.stringify(file)})?0:1)`], timeoutSec: 30 });

export function makeCtx({ scenario, config = {}, env = {}, codexResponse, codexError } = {}) {
  const home = tmpdir("ccd-home-");
  const scenarioFile = path.join(home, "scenario.json");
  const logFile = path.join(home, "fake-claude.log");
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario ?? { runs: [{}] }));
  const cfg = deepMerge(DEFAULT_CONFIG, deepMerge({ claude: { bin: FAKE_CLAUDE, timeoutMin: 2 } }, config));
  const ctx = createContext({
    home,
    config: cfg,
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioFile, FAKE_CLAUDE_LOG: logFile, ...env },
    codexReader: async () => {
      if (codexError) throw new Error(codexError);
      return codexResponse ?? codexLimits(10, 10);
    }
  });
  ctx.scenarioFile = scenarioFile;
  ctx.logFile = logFile;
  return ctx;
}

export function codexLimits(primary, secondary, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: now + 3600 },
      secondary: { usedPercent: secondary, windowDurationMins: 10080, resetsAt: now + 86400 },
      planType: "plus",
      ...extra
    },
    rateLimitsByLimitId: null
  };
}

export function setClaude(ctx, five, seven, { observedAt, resetsInSec = 3600 } = {}) {
  const at = observedAt ?? new Date().toISOString();
  recordObservations(ctx.home, [
    makeObservation({ provider: "claude", window: "five_hour", usedPercent: five, resetsAt: new Date(Date.now() + resetsInSec * 1000).toISOString(), observedAt: at, source: "manual" }),
    makeObservation({ provider: "claude", window: "seven_day", usedPercent: seven, resetsAt: new Date(Date.now() + 5 * 86400 * 1000).toISOString(), observedAt: at, source: "manual" })
  ]);
}

export function invocations(ctx) {
  if (!fs.existsSync(ctx.logFile)) return [];
  return fs.readFileSync(ctx.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export async function waitFor(ctx, taskId, pred, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await taskStatus(ctx, { taskId });
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting; last status ${last?.status}: ${last?.statusReason}`);
}

export const notRunning = (s) => !["running", "checks_running", "ready"].includes(s.status);
