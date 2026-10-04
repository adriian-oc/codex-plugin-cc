// Coordinator configuration. One state home per OS user account is shared by
// every project and every MCP server instance, so reservations are never
// counted twice for the same subscription.
import os from "node:os";
import path from "node:path";

import { deepMerge, ensureDir, readJson, writeJsonAtomic } from "./util.mjs";

export const CONFIG_VERSION = 1;

// All percentages below are ESTIMATES in percentage points of a provider usage
// window. They are deliberately conservative starting values, not measured
// facts. Tune them in config.json or let learned samples raise them.
export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  telemetry: {
    // A reading younger than ttlSec is "fresh". Between ttlSec and maxAgeSec it
    // is "degraded" and stalePenaltyPct is added to the used percentage. Older
    // readings are treated as unknown.
    ttlSec: { codex: 300, claude: 900 },
    maxAgeSec: { codex: 3600, claude: 3 * 3600 },
    stalePenaltyPct: 15,
    // What to do when a provider quota is unknown: "deny" never treats it as
    // available. "assume_used" treats it as assumeUsedPct used (explicit opt-in).
    unknownPolicy: "deny",
    assumeUsedPct: 80
  },
  safetyMarginPct: { five_hour: 10, seven_day: 5, default: 10 },
  estimatesNote: "Conservative initial estimates in percentage points of each usage window. Not measurements.",
  estimates: {
    claude: {
      implement: { S: { five_hour: 8, seven_day: 1.5 }, M: { five_hour: 20, seven_day: 4 }, L: { five_hour: 40, seven_day: 8 } },
      fix: { S: { five_hour: 4, seven_day: 0.8 }, M: { five_hour: 8, seven_day: 1.5 }, L: { five_hour: 15, seven_day: 3 } },
      review: { S: { five_hour: 3, seven_day: 0.6 }, M: { five_hour: 6, seven_day: 1.2 }, L: { five_hour: 10, seven_day: 2 } }
    },
    codex: {
      implement: { S: { five_hour: 8, seven_day: 1.5 }, M: { five_hour: 20, seven_day: 4 }, L: { five_hour: 40, seven_day: 8 } },
      review: { S: { five_hour: 3, seven_day: 0.6 }, M: { five_hour: 6, seven_day: 1.2 }, L: { five_hour: 12, seven_day: 2.5 } },
      agentChecks: { S: { five_hour: 1, seven_day: 0.2 }, M: { five_hour: 2, seven_day: 0.4 }, L: { five_hour: 4, seven_day: 0.8 } },
      final: { S: { five_hour: 1, seven_day: 0.2 }, M: { five_hour: 2, seven_day: 0.4 }, L: { five_hour: 3, seven_day: 0.6 } }
    }
  },
  learning: { enabled: true, minSamples: 3 },
  maxFixRounds: 2,
  maxFixRoundsHardCap: 5,
  reservationLeaseHours: 12,
  routing: {
    // Tasks smaller than this are cheaper to do directly in Codex.
    minDelegationSize: "S",
    preferDirectForTrivial: true
  },
  claude: {
    bin: "claude",
    model: null,
    maxTurns: 80,
    timeoutMin: 45,
    maxLogBytes: 20 * 1024 * 1024,
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
    disallowedTools: [
      "WebFetch",
      "WebSearch",
      "mcp__*",
      "Bash(git push *)",
      "Bash(git remote *)",
      "Bash(git config *)",
      "Bash(git commit *)",
      "Bash(git checkout *)",
      "Bash(git reset *)",
      "Bash(git worktree *)",
      "Bash(codex *)",
      "Bash(claude *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(ssh *)",
      "Bash(sudo *)"
    ],
    // Only load project/local settings: user-level plugins and hooks (for
    // example a plugin that calls Codex from a Stop hook) must not run inside a
    // worker and create a delegation loop.
    settingSources: "project,local",
    sandbox: { enabled: true, allowUnsandboxedCommands: false },
    // Refuse to run when Claude Code would bill an API key instead of a
    // claude.ai subscription. Explicit opt-in only.
    allowApiBilling: false,
    // Start a fresh session (with a compact brief) instead of resuming when the
    // previous run already used this many context tokens.
    contextRefreshTokens: 150000,
    reportMaxBytes: 16 * 1024
  },
  codex: { bin: "codex", appServerTimeoutSec: 20 },
  checks: { defaultTimeoutSec: 900, maxOutputBytes: 2 * 1024 * 1024 },
  diff: { inlineMaxBytes: 60 * 1024 }
};

export function stateHome() {
  return process.env.CCD_HOME || path.join(os.homedir(), ".codex-claude-director");
}

export function paths(home = stateHome()) {
  return {
    home,
    config: path.join(home, "config.json"),
    ledger: path.join(home, "ledger.json"),
    ledgerLock: path.join(home, "locks", "ledger.lock"),
    telemetry: path.join(home, "telemetry", "observations.json"),
    telemetryLock: path.join(home, "locks", "telemetry.lock"),
    statuslineSnapshot: path.join(home, "telemetry", "claude-statusline.json"),
    samples: path.join(home, "telemetry", "usage-samples.json"),
    tasksDir: path.join(home, "tasks"),
    worktreesDir: path.join(home, "worktrees"),
    projectsDir: path.join(home, "projects")
  };
}

export function loadConfig(home = stateHome()) {
  const p = paths(home);
  ensureDir(home);
  const user = readJson(p.config, null);
  const merged = deepMerge(DEFAULT_CONFIG, user ?? {});
  const cap = Number(merged.maxFixRoundsHardCap) || 5;
  const rounds = Number(merged.maxFixRounds);
  merged.maxFixRounds = Number.isInteger(rounds) && rounds >= 0 ? Math.min(rounds, cap) : 2;
  return merged;
}

export function writeDefaultConfigIfMissing(home = stateHome()) {
  const p = paths(home);
  if (readJson(p.config, null) === null) {
    writeJsonAtomic(p.config, DEFAULT_CONFIG);
    return true;
  }
  return false;
}
