// Project checks: only commands declared in trusted configuration may run.
// Configuration is read from the repository at the task's *base* commit (or
// from the coordinator's per-project override), never from the worker's
// worktree, so a worker cannot change what "passing" means.
import fs from "node:fs";
import path from "node:path";

import { paths } from "./config.mjs";
import { showFile } from "./git.mjs";
import { readJson } from "./util.mjs";

export const PROJECT_CONFIG_FILE = ".codex-claude-director.json";

export function validateProjectConfig(raw, origin) {
  const errors = [];
  const cfg = raw && typeof raw === "object" ? raw : {};
  const checks = [];
  const seen = new Set();
  for (const c of Array.isArray(cfg.checks) ? cfg.checks : []) {
    if (!c || typeof c.name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(c.name)) {
      errors.push(`invalid check name in ${origin}`);
      continue;
    }
    if (seen.has(c.name)) {
      errors.push(`duplicate check ${c.name}`);
      continue;
    }
    if (!Array.isArray(c.argv) || c.argv.length === 0 || !c.argv.every((a) => typeof a === "string" && a.length > 0)) {
      errors.push(`check ${c.name}: argv must be a non-empty array of strings (no shell strings)`);
      continue;
    }
    seen.add(c.name);
    checks.push({
      name: c.name,
      argv: c.argv,
      timeoutSec: Number.isFinite(c.timeoutSec) ? Math.min(Math.max(c.timeoutSec, 5), 7200) : null,
      required: c.required !== false,
      agentNeeded: Boolean(c.agentNeeded)
    });
  }
  const claudeAllowedBash = (Array.isArray(cfg.claudeAllowedBash) ? cfg.claudeAllowedBash : [])
    .filter((r) => typeof r === "string" && /^Bash\(.+\)$/.test(r));
  return {
    origin,
    checks,
    claudeAllowedBash,
    defaultScope: Array.isArray(cfg.defaultScope) ? cfg.defaultScope.filter((s) => typeof s === "string") : [],
    errors
  };
}

export function loadProjectConfig(home, repoRoot, repoKey, baseCommit) {
  const override = path.join(paths(home).projectsDir, `${repoKey}.json`);
  if (fs.existsSync(override)) return validateProjectConfig(readJson(override, {}), override);
  const text = baseCommit ? showFile(repoRoot, baseCommit, PROJECT_CONFIG_FILE) : null;
  if (text === null) return validateProjectConfig({}, "none");
  try {
    return validateProjectConfig(JSON.parse(text), `${PROJECT_CONFIG_FILE}@${baseCommit.slice(0, 12)}`);
  } catch {
    return { ...validateProjectConfig({}, PROJECT_CONFIG_FILE), errors: [`${PROJECT_CONFIG_FILE} is not valid JSON`] };
  }
}
