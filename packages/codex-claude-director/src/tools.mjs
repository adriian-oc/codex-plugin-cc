// MCP tool catalogue. Results are compact structured JSON with file
// references instead of transcripts.
import * as O from "./orchestrator.mjs";

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const TASK_ID = str("Task id returned by task_create (task_xxxxxxxxxxxx).", { pattern: "^task_[a-f0-9]{12}$" });
const SIZE = { type: "string", enum: ["S", "M", "L"], description: "Expected size of the work." };
const COMPLEXITY = { type: "string", enum: ["low", "medium", "high"] };
const AGENT = { type: "string", enum: ["auto", "claude", "codex"], description: "auto lets the capacity policy choose." };

function obj(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOLS = [
  {
    name: "capacity_status",
    title: "Capacity status",
    description: "Current usage windows for Codex and Claude with provenance (official/manual/estimated), age, freshness, reset times, active reservations and headroom. refresh=true re-reads Codex limits via the official app-server API (no model turn).",
    inputSchema: obj({ refresh: { type: "boolean" } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (ctx, a) => O.capacityStatus(ctx, a)
  },
  {
    name: "capacity_record_manual",
    title: "Record a manual capacity reading",
    description: "Store a usage percentage you or the user read from an official screen (Claude /usage, Codex /status). Marked source=manual, reliability=medium; it expires like any reading.",
    inputSchema: obj({
      provider: { type: "string", enum: ["claude", "codex"] },
      window: str("Usage window, e.g. five_hour or seven_day."),
      usedPercent: { type: "number", minimum: 0, maximum: 100 },
      resetsAt: str("ISO-8601 reset time, if shown."),
      note: str("Where the number came from.")
    }, ["provider", "window", "usedPercent"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: (ctx, a) => O.recordManualCapacity(ctx, a)
  },
  {
    name: "plan_task",
    title: "Plan allocation",
    description: "Explain how a task would be allocated (delegate_claude | codex_direct | wait) and what capacity would be reserved for implementation, review, checks, fix rounds and final report. No side effects.",
    inputSchema: obj({ size: SIZE, complexity: COMPLEXITY, agent: AGENT, trivial: { type: "boolean" }, fixRounds: { type: "integer", minimum: 0, maximum: 5 } }),
    annotations: { readOnlyHint: true },
    handler: (ctx, a) => O.plan(ctx, a)
  },
  {
    name: "task_create",
    title: "Create (and start) a task",
    description: "Create a task with objective and acceptance criteria. Admission re-checks capacity under a shared lock, reserves it, locks the scope paths and creates an isolated git worktree/branch. If delegated, Claude Code starts in the background (poll task_status). If codex_direct, edit the returned worktree yourself and call task_finalize_direct.",
    inputSchema: obj({
      repo: str("Absolute path of the Git repository."),
      title: str("Short title."),
      objective: str("What must be achieved."),
      acceptanceCriteria: { type: "array", minItems: 1, items: { anyOf: [{ type: "string" }, obj({ id: { type: "string" }, text: { type: "string" } }, ["text"])] } },
      scopePaths: { type: "array", items: { type: "string" }, description: "Repo-relative files/dirs the worker may change. Used for conflict locks and scope checks." },
      dependsOn: { type: "array", items: TASK_ID },
      priority: { type: "integer", minimum: 1, maximum: 5, description: "1 = highest." },
      size: SIZE,
      complexity: COMPLEXITY,
      agent: AGENT,
      trivial: { type: "boolean" },
      dirtyPolicy: { type: "string", enum: ["refuse", "include", "ignore"], description: "What to do with uncommitted changes in the source checkout. Default refuse (asks you to choose)." },
      start: { type: "boolean", description: "Start the Claude run immediately (default true)." }
    }, ["repo", "title", "objective", "acceptanceCriteria"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (ctx, a) => O.createTask(ctx, a)
  },
  {
    name: "task_status",
    title: "Task status",
    description: "Status, reason and next action for one task (reconciles finished/lost runs and checks), or a prioritized list of all tasks when taskId is omitted.",
    inputSchema: obj({ taskId: TASK_ID }),
    annotations: { readOnlyHint: true },
    handler: (ctx, a) => O.taskStatus(ctx, a)
  },
  {
    name: "task_result",
    title: "Task result and diff",
    description: "Exact tree hash of the current worktree, files added/modified/deleted vs the base, patch file path (full binary-safe diff), optional inline diff, scope/protected-file violations, checks on this tree and the worker report (untrusted).",
    inputSchema: obj({ taskId: TASK_ID, diff: { type: "string", enum: ["stat", "inline"] }, maxBytes: { type: "integer", minimum: 1024, maximum: 409600 } }, ["taskId"]),
    annotations: { readOnlyHint: true },
    handler: (ctx, a) => O.taskResult(ctx, a)
  },
  {
    name: "task_run_checks",
    title: "Run authorized checks",
    description: "Run the checks declared in trusted project configuration (read from the base commit, never from the worker's changes). Runs in the background; waitSec (<=50) waits for completion. Records the tree before/after so file-modifying checks are detected.",
    inputSchema: obj({ taskId: TASK_ID, names: { type: "array", items: { type: "string" } }, waitSec: { type: "integer", minimum: 0, maximum: 50 } }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (ctx, a) => O.runChecks(ctx, a)
  },
  {
    name: "task_review",
    title: "Record Codex review",
    description: "Record your review of an exact tree hash (from task_result). accept requires: checks passed on that same tree, every acceptance criterion met with evidence, no unacknowledged out-of-scope/protected changes. Any later file change invalidates the acceptance.",
    inputSchema: obj({
      taskId: TASK_ID,
      tree: str("Tree hash you reviewed (task_result.tree)."),
      verdict: { type: "string", enum: ["accept", "changes_requested", "reject"] },
      criteria: { type: "array", items: obj({ id: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string" } }, ["id", "met"]) },
      findings: { type: "array", items: { anyOf: [{ type: "string" }, obj({ file: { type: "string" }, issue: { type: "string" }, severity: { type: "string" } }, ["issue"])] } },
      notes: { type: "string" },
      acknowledge: obj({ noChecks: { type: "boolean" }, outOfScope: { type: "boolean" }, protectedFiles: { type: "boolean" }, emptyDiff: { type: "boolean" } })
    }, ["taskId", "tree", "verdict"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (ctx, a) => O.reviewTask(ctx, a)
  },
  {
    name: "task_request_fix",
    title: "Request a correction round",
    description: "Start a correction round (bounded by maxFixRounds). by=claude resumes the Claude session with only the findings and failed check output (fresh session with a compact brief if the context is large); by=codex lets you fix directly in the worktree.",
    inputSchema: obj({ taskId: TASK_ID, findings: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] } }, by: { type: "string", enum: ["claude", "codex"] }, forceNewSession: { type: "boolean" } }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (ctx, a) => O.requestFix(ctx, a)
  },
  {
    name: "task_resume",
    title: "Resume a task",
    description: "Resume an interrupted/blocked Claude run (reusing its session and the checkpointed partial work), or re-try admission for waiting_capacity/queued tasks.",
    inputSchema: obj({ taskId: TASK_ID, note: str("Optional extra guidance for the worker.") }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (ctx, a) => O.resumeTask(ctx, a)
  },
  {
    name: "task_cancel",
    title: "Cancel a task",
    description: "Stop the active run/checks (whole process tree, identity-verified PIDs only), release reservations and path locks. Worktree, branch and partial changes are preserved.",
    inputSchema: obj({ taskId: TASK_ID }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (ctx, a) => O.cancelTask(ctx, a)
  },
  {
    name: "task_finalize_direct",
    title: "Finalize Codex direct implementation",
    description: "After you (Codex) edited the task worktree directly, checkpoint it and move the task to pending_review. Your own review will be labelled a self-check, not an independent review.",
    inputSchema: obj({ taskId: TASK_ID, summary: str("What you changed.") }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (ctx, a) => O.finalizeDirect(ctx, a)
  },
  {
    name: "task_request_independent_review",
    title: "Independent read-only review by Claude",
    description: "Ask Claude (read-only tools) for an advisory review of the current tree, e.g. for Codex-direct work. Result appears in task_result.independentReviews (untrusted). The final decision remains task_review.",
    inputSchema: obj({ taskId: TASK_ID }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: (ctx, a) => O.requestIndependentReview(ctx, a)
  },
  {
    name: "task_cleanup",
    title: "Clean up a finished task",
    description: "For accepted/failed/cancelled tasks: release locks and optionally remove the worktree. The branch is never deleted and nothing is merged.",
    inputSchema: obj({ taskId: TASK_ID, removeWorktree: { type: "boolean" } }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (ctx, a) => O.cleanupTask(ctx, a)
  },
  {
    name: "coordinator_doctor",
    title: "Diagnose installation",
    description: "Check git/claude/codex binaries, Claude authentication method (subscription vs API billing), status line bridge and state paths.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    handler: (ctx) => O.doctor(ctx)
  }
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function validateArgs(schema, args, pathName = "arguments") {
  if (schema.type === "object") {
    if (args === null || typeof args !== "object" || Array.isArray(args)) return `${pathName} must be an object`;
    for (const key of schema.required ?? []) if (args[key] === undefined) return `${pathName}.${key} is required`;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(args)) if (!(key in (schema.properties ?? {}))) return `${pathName}.${key} is not allowed`;
    }
    for (const [key, value] of Object.entries(args)) {
      const sub = schema.properties?.[key];
      if (sub && value !== undefined) {
        const err = validateArgs(sub, value, `${pathName}.${key}`);
        if (err) return err;
      }
    }
    return null;
  }
  if (schema.anyOf) return schema.anyOf.some((s) => !validateArgs(s, args, pathName)) ? null : `${pathName} has an invalid shape`;
  if (schema.type === "array") {
    if (!Array.isArray(args)) return `${pathName} must be an array`;
    if (schema.minItems && args.length < schema.minItems) return `${pathName} needs at least ${schema.minItems} item(s)`;
    for (let i = 0; i < args.length; i += 1) {
      const err = schema.items ? validateArgs(schema.items, args[i], `${pathName}[${i}]`) : null;
      if (err) return err;
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof args !== "string") return `${pathName} must be a string`;
    if (schema.enum && !schema.enum.includes(args)) return `${pathName} must be one of ${schema.enum.join(", ")}`;
    if (schema.pattern && !new RegExp(schema.pattern).test(args)) return `${pathName} has an invalid format`;
    return null;
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof args !== "number" || (schema.type === "integer" && !Number.isInteger(args))) return `${pathName} must be a ${schema.type}`;
    if (schema.minimum !== undefined && args < schema.minimum) return `${pathName} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && args > schema.maximum) return `${pathName} must be <= ${schema.maximum}`;
    return null;
  }
  if (schema.type === "boolean" && typeof args !== "boolean") return `${pathName} must be a boolean`;
  return null;
}

export async function callTool(ctx, name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    const error = new Error(`Unknown tool: ${name}`);
    error.code = -32602;
    throw error;
  }
  const invalid = validateArgs(tool.inputSchema, args);
  if (invalid) return { content: [{ type: "text", text: `Invalid arguments: ${invalid}` }], isError: true };
  try {
    const result = await tool.handler(ctx, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (error) {
    const payload = { error: error.message, details: error.details ?? undefined };
    if (!(error instanceof O.UserError)) payload.internal = true;
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
  }
}
