import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.mjs";
import {
  assessObservation,
  loadTelemetry,
  makeObservation,
  observationFromClaudeRateLimitEvent,
  observationsFromCodexRateLimits,
  observationsFromStatuslineSnapshot,
  recordObservations
} from "../src/capacity.mjs";
import { planTask } from "../src/policy.mjs";
import { tmpdir } from "./helpers.mjs";

const cfg = structuredClone(DEFAULT_CONFIG);
const NOW = Date.parse("2026-10-03T12:00:00Z");
const iso = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString();

function telemetry(obsList) {
  const latest = {};
  for (const o of obsList) latest[`${o.provider}:${o.window}`] = o;
  return { latest, history: [] };
}
const obs = (provider, window, usedPercent, { ageSec = 10, resetsIn = 3600, status, source = "official" } = {}) =>
  makeObservation({ provider, window, usedPercent, status, observedAt: iso(-ageSec), resetsAt: resetsIn === null ? null : iso(resetsIn), source });
const both = (provider, five, seven, opts) => [obs(provider, "five_hour", five, opts), obs(provider, "seven_day", seven, opts)];
const plan = (tele, input = {}, ledger = { reservations: [], pathLocks: [] }, config = cfg) =>
  planTask({ size: "M", ...input }, { telemetry: telemetry(tele), ledger, config, samples: input.samples, now: NOW });

test("unknown quota is never treated as available", () => {
  const p = plan([...both("codex", 10, 10)]);
  assert.equal(p.strategies.delegate_claude.ok, false);
  assert.ok(p.strategies.delegate_claude.problems.claude.some((x) => x.reason === "unknown"));
  assert.equal(p.decision, "codex_direct");
  const none = plan([]);
  assert.equal(none.decision, "wait");
  assert.match(none.guidance, /Refresh telemetry/);
});

test("fresh, degraded (penalty), stale (ignored) and reset-passed readings", () => {
  const fresh = assessObservation(obs("claude", "five_hour", 40, { ageSec: 60 }), cfg, NOW);
  assert.equal(fresh.freshness, "fresh");
  assert.equal(fresh.effectiveUsedPercent, 40);
  const degraded = assessObservation(obs("claude", "five_hour", 40, { ageSec: 1800 }), cfg, NOW);
  assert.equal(degraded.freshness, "degraded");
  assert.equal(degraded.effectiveUsedPercent, 55);
  const stale = assessObservation(obs("claude", "five_hour", 40, { ageSec: 4 * 3600, resetsIn: 7200 }), cfg, NOW);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.effectiveUsedPercent, null);
  const reset = assessObservation(obs("claude", "five_hour", 95, { ageSec: 100, resetsIn: -10 }), cfg, NOW);
  assert.equal(reset.freshness, "reset_passed");
  assert.equal(reset.effectiveUsedPercent, cfg.telemetry.stalePenaltyPct);
});

test("exhausted window blocks the provider until its reset", () => {
  const p = plan([...both("codex", 10, 10), obs("claude", "five_hour", null, { status: "rejected", resetsIn: 900 }), obs("claude", "seven_day", 20)]);
  assert.equal(p.decision, "codex_direct");
  assert.equal(p.strategies.delegate_claude.problems.claude[0].reason, "exhausted");
});

test("multiple windows: weekly window limits even when 5h is fine", () => {
  const p = plan([...both("codex", 10, 10), obs("claude", "five_hour", 5), obs("claude", "seven_day", 93)]);
  assert.equal(p.decision, "codex_direct");
  assert.ok(p.strategies.delegate_claude.problems.claude.some((x) => x.window === "seven_day" && x.reason === "insufficient"));
});

test("allocation: both available → delegate; Codex low → never delegate work it cannot review; both low → wait with retry time", () => {
  assert.equal(plan([...both("codex", 10, 10), ...both("claude", 10, 10)]).decision, "delegate_claude");
  const codexLow = plan([...both("codex", 80, 10), ...both("claude", 10, 10)]);
  assert.equal(codexLow.decision, "wait");
  assert.ok(codexLow.strategies.delegate_claude.problems.codex.length);
  const bothLow = plan([...both("codex", 88, 10, { resetsIn: 1200 }), ...both("claude", 90, 10, { resetsIn: 600 })]);
  assert.equal(bothLow.decision, "wait");
  assert.equal(bothLow.retryAfter, iso(600));
  // Claude low but Codex can implement and validate itself.
  const claudeLow = plan([...both("codex", 10, 10), ...both("claude", 75, 10)], { size: "S" });
  assert.equal(claudeLow.decision, "codex_direct");
  assert.match(claudeLow.reasons.join(" "), /not an independent review/);
});

test("reservations by other tasks reduce headroom (shared across projects)", () => {
  const tele = [...both("codex", 10, 10), ...both("claude", 30, 10)];
  const ledger = { reservations: [{ taskId: "other", project: "other-repo", provider: "claude", window: "five_hour", amountPct: 45, state: "active", expiresAt: iso(3600) }], pathLocks: [] };
  const p = plan(tele, {}, ledger);
  assert.equal(p.headroom.claude.windows.five_hour.reservedByOthers, 45);
  assert.equal(p.decision, "codex_direct");
});

test("consumed reservation still counts until a newer reading arrives", async () => {
  const { reservedAmount } = await import("../src/ledger.mjs");
  const ledger = { reservations: [{ provider: "claude", window: "five_hour", amountPct: 12, state: "consumed", releasedAt: iso(-60), expiresAt: iso(3600) }] };
  assert.equal(reservedAmount(ledger, telemetry([obs("claude", "five_hour", 40, { ageSec: 120 })]), "claude", "five_hour"), 12);
  assert.equal(reservedAmount(ledger, telemetry([obs("claude", "five_hour", 52, { ageSec: 10 })]), "claude", "five_hour"), 0);
});

test("explicit trivial task stays with Codex; nested delegation refused", () => {
  const tele = [...both("codex", 10, 10), ...both("claude", 10, 10)];
  assert.equal(plan(tele, { trivial: true }).decision, "codex_direct");
  assert.equal(plan(tele, { workerContext: true }).decision, "refuse");
});

test("learned samples can only make reservations more conservative", () => {
  const tele = [...both("codex", 10, 10), ...both("claude", 10, 10)];
  const higher = plan(tele, { samples: { "claude:implement:M:five_hour": { n: 5, p75: 33 } } });
  assert.equal(higher.reservations.find((r) => r.provider === "claude" && r.phase === "implement" && r.window === "five_hour").amountPct, 33);
  const lower = plan(tele, { samples: { "claude:implement:M:five_hour": { n: 5, p75: 1 } } });
  assert.equal(lower.reservations.find((r) => r.provider === "claude" && r.phase === "implement" && r.window === "five_hour").amountPct, 20);
});

test("Codex app-server response → official observations with provenance", () => {
  const list = observationsFromCodexRateLimits({
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1790500000 }, planType: "pro" }
  }, iso(0));
  assert.deepEqual(list.map((o) => [o.window, o.usedPercent, o.source]), [["five_hour", 42, "official"], ["seven_day", 7, "official"]]);
  assert.match(list[0].sourceDetail, /account\/rateLimits\/read/);
  assert.equal(list[0].resetsAt, new Date(1790000000 * 1000).toISOString());
  const blocked = observationsFromCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null } } });
  assert.equal(blocked[0].status, "rejected");
});

test("Claude rate_limit_event parsing: fraction, status-only, rejected", () => {
  const a = observationFromClaudeRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: 1790000000 } });
  assert.equal(Math.round(a.usedPercent), 81);
  assert.equal(a.reliability, "medium");
  const b = observationFromClaudeRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } });
  assert.equal(b.usedPercent, null);
  const c = observationFromClaudeRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1800000000 } });
  assert.equal(assessObservation(c, cfg, NOW).exhausted, true);
  assert.equal(observationFromClaudeRateLimitEvent({ type: "rate_limit_event" }), null);
});

test("a status-only event does not erase a reading that has a percentage", () => {
  const home = tmpdir();
  recordObservations(home, [obs("claude", "five_hour", 37, { ageSec: 100 })]);
  recordObservations(home, [makeObservation({ provider: "claude", window: "five_hour", usedPercent: null, status: "allowed", source: "official", observedAt: iso(0) })]);
  const t = loadTelemetry(home);
  assert.equal(t.latest["claude:five_hour"].usedPercent, 37);
  assert.equal(t.latest["claude:five_hour"].lastStatusCheck.status, "allowed");
  // An older manual entry never overrides a newer official reading.
  recordObservations(home, [makeObservation({ provider: "claude", window: "five_hour", usedPercent: 5, source: "manual", observedAt: iso(-5000) })]);
  assert.equal(loadTelemetry(home).latest["claude:five_hour"].usedPercent, 37);
});

test("status line snapshot (documented rate_limits fields) → observations", () => {
  const list = observationsFromStatuslineSnapshot({ capturedAt: iso(0), rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 }, spend_limit: { used_percentage: 3 } } });
  assert.deepEqual(list.map((o) => [o.window, o.usedPercent]), [["five_hour", 23.5], ["seven_day", 41.2]]);
  assert.equal(observationsFromStatuslineSnapshot({}).length, 0);
});

test("unknownPolicy assume_used is explicit opt-in and still conservative", () => {
  const c = structuredClone(cfg);
  c.telemetry.unknownPolicy = "assume_used";
  const p = plan([...both("codex", 10, 10)], { size: "S" }, undefined, c);
  assert.equal(p.headroom.claude.windows.five_hour.assumedUsedPercent, 80);
  assert.equal(p.headroom.claude.windows.five_hour.headroom, 10);
  // 80% assumed + 10 margin leaves 10 points: not enough for S implementation + 2 fix rounds.
  assert.equal(p.decision, "codex_direct");
});
