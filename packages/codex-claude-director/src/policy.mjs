// Allocation policy: decide whether a task should be delegated to Claude,
// implemented directly by Codex, or wait — reserving capacity for every phase
// that will be needed to deliver a *validated* result.
import { PRIMARY_WINDOWS, assessProvider } from "./capacity.mjs";
import { reservedAmount } from "./ledger.mjs";

export const SIZES = ["S", "M", "L"];
const COMPLEXITY_FACTOR = { low: 0.8, medium: 1, high: 1.3 };

function phaseCost(config, provider, phase, size, complexity, samples) {
  const table = config.estimates?.[provider]?.[phase]?.[size] ?? {};
  const factor = COMPLEXITY_FACTOR[complexity] ?? 1;
  const out = {};
  for (const [window, value] of Object.entries(table)) {
    let amount = value * factor;
    let basis = "configured estimate";
    const learned = samples?.[`${provider}:${phase}:${size}:${window}`];
    if (config.learning?.enabled && learned && learned.n >= (config.learning.minSamples ?? 3) && learned.p75 > amount) {
      // Learned samples may only make reservations more conservative.
      amount = learned.p75;
      basis = `learned p75 of ${learned.n} samples`;
    }
    out[window] = { amount: Math.round(amount * 100) / 100, basis };
  }
  return out;
}

/** Build the list of reservation items each strategy needs. */
export function strategyNeeds(config, { size, complexity, fixRounds, samples }) {
  const rounds = Number.isInteger(fixRounds) ? fixRounds : config.maxFixRounds;
  const add = (items, provider, phase, multiplier = 1) => {
    if (multiplier <= 0) return;
    const cost = phaseCost(config, provider, phase, size, complexity, samples);
    for (const [window, { amount, basis }] of Object.entries(cost)) {
      items.push({ provider, window, phase, amountPct: amount * multiplier, units: multiplier, unitAmount: amount, basis });
    }
  };
  const delegate = [];
  add(delegate, "claude", "implement");
  add(delegate, "claude", "fix", rounds);
  add(delegate, "codex", "review", 1 + rounds);
  add(delegate, "codex", "agentChecks", 1 + rounds);
  add(delegate, "codex", "final");

  const direct = [];
  add(direct, "codex", "implement");
  add(direct, "codex", "agentChecks", 1 + rounds);
  add(direct, "codex", "final");
  return { delegate_claude: delegate, codex_direct: direct };
}

function sumByWindow(items, provider) {
  const out = {};
  for (const it of items) {
    if (it.provider !== provider) continue;
    out[it.window] = (out[it.window] ?? 0) + it.amountPct;
  }
  return out;
}

/** Headroom per window after effective usage, other reservations and margin. */
export function providerHeadroom(provider, { telemetry, ledger, config, excludeTaskId, now }) {
  const assessment = assessProvider(provider, telemetry, config, now);
  const windows = {};
  for (const w of assessment.windows) {
    const reserved = reservedAmount(ledger, telemetry, provider, w.window, { excludeTaskId });
    const margin = config.safetyMarginPct?.[w.window] ?? config.safetyMarginPct?.default ?? 10;
    let used = w.effectiveUsedPercent;
    let assumed = false;
    if (used === null && config.telemetry.unknownPolicy === "assume_used" && PRIMARY_WINDOWS.includes(w.window)) {
      used = config.telemetry.assumeUsedPct;
      assumed = true;
    }
    windows[w.window] = {
      ...w,
      reservedByOthers: reserved,
      safetyMargin: margin,
      assumedUsedPercent: assumed ? used : undefined,
      headroom: used === null ? null : Math.round((100 - used - reserved - margin) * 100) / 100
    };
  }
  return { provider, state: assessment.state, windows };
}

function checkFit(headroom, needs) {
  const problems = [];
  if (headroom.state === "exhausted") {
    const w = Object.values(headroom.windows).find((x) => x.exhausted);
    problems.push({ window: w?.window, reason: "exhausted", resetsAt: w?.resetsAt ?? null });
  }
  for (const [window, need] of Object.entries(needs)) {
    const w = headroom.windows[window];
    if (!w || w.headroom === null) {
      problems.push({ window, reason: w?.freshness === "stale" ? "stale" : "unknown", need: round(need) });
    } else if (w.headroom < need) {
      problems.push({ window, reason: "insufficient", need: round(need), headroom: w.headroom, resetsAt: w.resetsAt ?? null });
    }
  }
  return problems;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Decide a strategy. Returns a structured decision with a human explanation.
 * `agent` may be "auto", "claude" or "codex".
 */
export function planTask(input, ctx) {
  const { config } = ctx;
  const size = SIZES.includes(input.size) ? input.size : "M";
  const complexity = COMPLEXITY_FACTOR[input.complexity] ? input.complexity : "medium";
  const agent = ["auto", "claude", "codex"].includes(input.agent) ? input.agent : "auto";
  const needs = strategyNeeds(config, { size, complexity, fixRounds: input.fixRounds, samples: ctx.samples });
  const head = {
    claude: providerHeadroom("claude", ctx),
    codex: providerHeadroom("codex", ctx)
  };
  const evalStrategy = (name) => {
    const items = needs[name];
    const problems = {
      claude: checkFit(head.claude, sumByWindow(items, "claude")),
      codex: checkFit(head.codex, sumByWindow(items, "codex"))
    };
    if (!items.some((i) => i.provider === "claude")) problems.claude = [];
    return { name, items, problems, ok: problems.claude.length === 0 && problems.codex.length === 0 };
  };
  const delegate = evalStrategy("delegate_claude");
  const direct = evalStrategy("codex_direct");
  const reasons = [];
  let decision;

  if (input.workerContext) {
    decision = "refuse";
    reasons.push("Called from inside a delegated worker: nested delegation is disabled to prevent loops.");
  } else if (agent === "claude") {
    decision = delegate.ok ? "delegate_claude" : "wait";
    reasons.push(delegate.ok ? "Claude requested and both providers can cover implementation plus review." : "Claude requested but capacity is insufficient or unknown (see problems).");
  } else if (agent === "codex") {
    decision = direct.ok ? "codex_direct" : "wait";
    reasons.push(direct.ok ? "Codex direct requested and Codex can cover implementation and validation." : "Codex direct requested but Codex capacity is insufficient or unknown.");
  } else if (input.trivial && config.routing?.preferDirectForTrivial && direct.ok) {
    decision = "codex_direct";
    reasons.push("Trivial task: delegation overhead (briefing, review) exceeds the work itself.");
  } else if (delegate.ok) {
    decision = "delegate_claude";
    reasons.push("Both providers have headroom: Claude implements, Codex keeps capacity reserved for review, checks, up to the configured fix rounds and the final report.");
  } else if (direct.ok) {
    decision = "codex_direct";
    const why = delegate.problems.claude.length ? "Claude capacity is low/unknown" : "delegated review would not fit";
    reasons.push(`${why}; Codex still has enough headroom to implement and validate itself. Note: this is self-checked, not an independent review.`);
  } else {
    decision = "wait";
    reasons.push("Neither strategy fits the current capacity; keep state and retry after a reset or a fresh reading.");
  }

  // Never delegate work whose review cannot be afforded.
  if (decision === "delegate_claude" && delegate.problems.codex.length) {
    decision = "wait";
    reasons.push("Codex could not review the delegated result; delegation refused.");
  }

  const limiting = [...delegate.problems.claude, ...delegate.problems.codex, ...direct.problems.codex];
  const resets = limiting.map((p) => p.resetsAt).filter(Boolean).sort();
  const chosen = decision === "delegate_claude" ? delegate : decision === "codex_direct" ? direct : null;
  return {
    decision,
    size,
    complexity,
    fixRounds: Number.isInteger(input.fixRounds) ? input.fixRounds : config.maxFixRounds,
    reasons,
    reservations: chosen ? chosen.items.map((i) => ({ ...i, amountPct: round(i.amountPct) })) : [],
    strategies: {
      delegate_claude: { ok: delegate.ok, problems: delegate.problems },
      codex_direct: { ok: direct.ok, problems: direct.problems }
    },
    headroom: head,
    retryAfter: decision === "wait" ? resets[0] ?? null : null,
    estimatesNote: "Reservation amounts are estimates in percentage points of each usage window, not measurements.",
    guidance: decision === "wait" && limiting.some((p) => p.reason === "unknown" || p.reason === "stale")
      ? "Refresh telemetry: capacity_status(refresh=true) for Codex; for Claude install the status line bridge or record a manual reading from /usage (capacity_record_manual)."
      : null
  };
}
