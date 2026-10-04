// Child process used by the concurrency test: admits one task against a
// shared state home, exactly like a separate Codex session would.
import { DEFAULT_CONFIG } from "../../src/config.mjs";
import { createContext, createTask } from "../../src/orchestrator.mjs";
import { deepMerge } from "../../src/util.mjs";

const [home, repo, scope, fake] = process.argv.slice(2);
const config = deepMerge(DEFAULT_CONFIG, { claude: { bin: fake } });
const now = Math.floor(Date.now() / 1000);
const ctx = createContext({
  home,
  config,
  codexReader: async () => ({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: now + 3600 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: now + 86400 } } })
});
const t = await createTask(ctx, { repo, title: scope, objective: "o", acceptanceCriteria: ["x"], scopePaths: [scope], size: "S", start: false });
process.stdout.write(JSON.stringify({ agent: t.agent, status: t.status }));
