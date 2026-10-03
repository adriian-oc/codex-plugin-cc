// Capacity telemetry: observations of account usage windows for Codex and
// Claude, with explicit provenance, freshness and reliability.
//
// Dimensions are kept separate on purpose:
//   - account usage windows (five_hour, seven_day, ...) -> this module
//   - per-session context tokens                      -> task runs (tasks.mjs)
//   - token counts / client-side USD estimates         -> task runs, never
//     converted into subscription percentages.
import fs from "node:fs";

import { paths } from "./config.mjs";
import { nowIso, nowMs, readJson, withLock, writeJsonAtomic } from "./util.mjs";

export const PROVIDERS = ["claude", "codex"];
export const PRIMARY_WINDOWS = ["five_hour", "seven_day"];
const HISTORY_LIMIT = 300;

export function windowNameFromMinutes(minutes) {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "seven_day";
  if (!Number.isFinite(minutes)) return "unknown_window";
  return `window_${minutes}m`;
}

function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    // Unix seconds or milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function makeObservation(fields) {
  const usedPercent = fields.usedPercent === null || fields.usedPercent === undefined ? null : Number(fields.usedPercent);
  if (usedPercent !== null && (!Number.isFinite(usedPercent) || usedPercent < 0)) {
    throw new Error(`Invalid usedPercent: ${fields.usedPercent}`);
  }
  if (!PROVIDERS.includes(fields.provider)) throw new Error(`Unknown provider: ${fields.provider}`);
  if (!["official", "manual", "estimated"].includes(fields.source)) throw new Error(`Invalid source: ${fields.source}`);
  return {
    provider: fields.provider,
    scope: fields.scope ?? "account",
    window: fields.window,
    windowMinutes: fields.windowMinutes ?? null,
    usedPercent: usedPercent === null ? null : Math.min(usedPercent, 1000),
    status: fields.status ?? null,
    resetsAt: toIso(fields.resetsAt),
    observedAt: toIso(fields.observedAt) ?? nowIso(),
    source: fields.source,
    sourceDetail: fields.sourceDetail ?? null,
    reliability: fields.reliability ?? (fields.source === "official" ? "high" : fields.source === "manual" ? "medium" : "low"),
    note: fields.note ?? null
  };
}

export function loadTelemetry(home) {
  const p = paths(home);
  return readJson(p.telemetry, { latest: {}, history: [] });
}

export function recordObservations(home, observations) {
  const p = paths(home);
  return withLock(p.telemetryLock, () => {
    const store = readJson(p.telemetry, { latest: {}, history: [] });
    for (const obs of observations) {
      const key = `${obs.provider}:${obs.window}`;
      const previous = store.latest[key];
      // Never let an older reading (for example a delayed manual entry)
      // replace a newer one.
      const statusOnly = obs.usedPercent === null && obs.status !== "rejected";
      if (previous && statusOnly && previous.usedPercent !== null && previous.status !== "rejected") {
        // A status-only event ("allowed", no percentage) must not erase a
        // reading that carries a percentage; keep it as a side note.
        previous.lastStatusCheck = { status: obs.status, observedAt: obs.observedAt, sourceDetail: obs.sourceDetail };
      } else if (!previous || Date.parse(obs.observedAt) >= Date.parse(previous.observedAt)) {
        store.latest[key] = obs;
      }
      store.history.push(obs);
    }
    store.history = store.history.slice(-HISTORY_LIMIT);
    writeJsonAtomic(p.telemetry, store);
    return store;
  });
}

/**
 * Evaluate one observation at time `now`. Returns the usage the planner
 * should assume (effectiveUsedPercent) and why. Null means unknown.
 */
export function assessObservation(obs, config, now = nowMs()) {
  const t = config.telemetry;
  const ttl = (t.ttlSec?.[obs.provider] ?? 600) * 1000;
  const maxAge = (t.maxAgeSec?.[obs.provider] ?? 3600) * 1000;
  const age = now - Date.parse(obs.observedAt);
  const resetsAtMs = obs.resetsAt ? Date.parse(obs.resetsAt) : null;
  const base = {
    window: obs.window,
    usedPercent: obs.usedPercent,
    status: obs.status,
    resetsAt: obs.resetsAt,
    observedAt: obs.observedAt,
    ageSec: Math.round(age / 1000),
    source: obs.source,
    sourceDetail: obs.sourceDetail,
    reliability: obs.reliability,
    expiresAt: new Date(Date.parse(obs.observedAt) + ttl).toISOString()
  };

  if (resetsAtMs !== null && resetsAtMs <= now) {
    // The window has rolled over since this reading. The old percentage no
    // longer applies, but other sessions may already have used the new
    // window, so assume a penalty instead of 0%.
    return { ...base, freshness: "reset_passed", effectiveUsedPercent: t.stalePenaltyPct, exhausted: false,
      note: "Window reset after the last reading; assuming stalePenaltyPct until refreshed." };
  }
  if (obs.status === "rejected") {
    return { ...base, freshness: age <= ttl ? "fresh" : "degraded", effectiveUsedPercent: 100, exhausted: true,
      note: obs.resetsAt ? `Limit reached; resets at ${obs.resetsAt}.` : "Limit reached; reset time unknown." };
  }
  if (obs.usedPercent === null) {
    return { ...base, freshness: "unknown", effectiveUsedPercent: null, exhausted: false,
      note: "Reading carries no usage percentage (status only)." };
  }
  if (age <= ttl) {
    return { ...base, freshness: "fresh", effectiveUsedPercent: obs.usedPercent, exhausted: obs.usedPercent >= 100 };
  }
  if (age <= maxAge) {
    const effective = Math.min(100, obs.usedPercent + t.stalePenaltyPct);
    return { ...base, freshness: "degraded", effectiveUsedPercent: effective, exhausted: obs.usedPercent >= 100,
      note: `Reading is older than ${Math.round(ttl / 1000)}s; +${t.stalePenaltyPct} points added.` };
  }
  return { ...base, freshness: "stale", effectiveUsedPercent: null, exhausted: false,
    note: `Reading older than ${Math.round(maxAge / 1000)}s is ignored.` };
}

/** Summarize everything we know about one provider's account windows. */
export function assessProvider(provider, telemetry, config, now = nowMs()) {
  const windows = [];
  for (const [key, obs] of Object.entries(telemetry.latest ?? {})) {
    if (!key.startsWith(`${provider}:`)) continue;
    windows.push(assessObservation(obs, config, now));
  }
  for (const name of PRIMARY_WINDOWS) {
    if (!windows.some((w) => w.window === name)) {
      windows.push({ window: name, freshness: "unknown", effectiveUsedPercent: null, exhausted: false, source: null,
        note: "No reading for this window." });
    }
  }
  windows.sort((a, b) => a.window.localeCompare(b.window));
  const exhausted = windows.filter((w) => w.exhausted);
  const unknown = windows.filter((w) => PRIMARY_WINDOWS.includes(w.window) && w.effectiveUsedPercent === null);
  let state = "known";
  if (exhausted.length) state = "exhausted";
  else if (unknown.length) state = "unknown";
  return { provider, state, windows };
}

// ---------------------------------------------------------------------------
// Codex: official app-server protocol `account/rateLimits/read`.
// ---------------------------------------------------------------------------

export function observationsFromCodexRateLimits(response, observedAt = nowIso()) {
  const out = [];
  const detail = "codex app-server account/rateLimits/read";
  const buckets = response?.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length
    ? response.rateLimitsByLimitId
    : { codex: response?.rateLimits };
  const blocked = response?.ordinaryUsageAllowed === false;
  for (const [limitId, snap] of Object.entries(buckets)) {
    if (!snap) continue;
    const reached = Boolean(snap.rateLimitReachedType) || snap.spendControlReached === true;
    for (const slot of ["primary", "secondary"]) {
      const w = snap[slot];
      if (!w) continue;
      const name = windowNameFromMinutes(w.windowDurationMins);
      const window = limitId === "codex" || Object.keys(buckets).length === 1 ? name : `${limitId}:${name}`;
      out.push(makeObservation({
        provider: "codex",
        window,
        windowMinutes: w.windowDurationMins ?? null,
        usedPercent: w.usedPercent,
        status: blocked || (reached && w.usedPercent >= 100) ? "rejected" : "allowed",
        resetsAt: w.resetsAt ?? null,
        observedAt,
        source: "official",
        sourceDetail: `${detail} (${limitId}.${slot}${snap.planType ? `, plan ${snap.planType}` : ""})`,
        reliability: "high"
      }));
    }
  }
  return out;
}

/**
 * Read Codex account rate limits through `codex app-server` (stdio JSON-RPC).
 * This does not start a model turn. Uses only the documented protocol.
 */
export async function readCodexRateLimits(config, { spawnImpl } = {}) {
  const { spawn } = await import("node:child_process");
  const doSpawn = spawnImpl ?? spawn;
  const timeoutMs = (config.codex?.appServerTimeoutSec ?? 20) * 1000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = doSpawn(config.codex?.bin ?? "codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = "";
    let settled = false;
    const pending = new Map();
    let nextId = 1;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`codex app-server did not answer within ${timeoutMs} ms`)), timeoutMs);
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(new Error(`codex app-server exited early (code ${code})`)));
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message ?? JSON.stringify(msg.error))); else p.res(msg.result);
        }
      }
    });
    (async () => {
      await request("initialize", {
        clientInfo: { name: "codex_claude_director", title: "Codex Claude Director (unofficial)", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false }
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const result = await request("account/rateLimits/read", { excludeResetCreditDetails: true });
      finish(null, result);
    })().catch((error) => finish(error));
  });
}

// ---------------------------------------------------------------------------
// Claude: official stream-json `rate_limit_event` and the documented status
// line `rate_limits` fields (interactive sessions only).
// ---------------------------------------------------------------------------

export function observationFromClaudeRateLimitEvent(event, observedAt = nowIso()) {
  const info = event?.rate_limit_info;
  if (!info || typeof info !== "object") return null;
  const window = info.rateLimitType ?? "unspecified";
  const status = ["allowed", "allowed_warning", "rejected"].includes(info.status) ? info.status : null;
  let usedPercent = typeof info.utilization === "number" ? info.utilization : null;
  // The SDK type does not state the unit of `utilization`. Claude's unified
  // rate-limit headers use a 0-1 fraction, so values <= 1 are read as a
  // fraction. This interpretation is recorded in the observation note.
  const fractional = usedPercent !== null && usedPercent <= 1;
  if (fractional) usedPercent = usedPercent * 100;
  if (usedPercent === null && status === "allowed_warning" && typeof info.surpassedThreshold === "number") {
    usedPercent = info.surpassedThreshold <= 1 ? info.surpassedThreshold * 100 : info.surpassedThreshold;
  }
  return makeObservation({
    provider: "claude",
    window,
    usedPercent,
    status,
    resetsAt: info.resetsAt ?? null,
    observedAt,
    source: "official",
    sourceDetail: "claude -p stream-json rate_limit_event",
    reliability: usedPercent === null ? "medium" : fractional ? "medium" : "high",
    note: usedPercent === null
      ? "Event reported status without utilization."
      : fractional ? "utilization <= 1 interpreted as a 0-1 fraction (unit not documented)." : null
  });
}

/** Parse the snapshot written by the status line bridge. */
export function observationsFromStatuslineSnapshot(snapshot) {
  if (!snapshot || !snapshot.rate_limits || !snapshot.capturedAt) return [];
  const out = [];
  for (const [window, value] of Object.entries(snapshot.rate_limits)) {
    if (!value || typeof value !== "object" || window === "spend_limit") continue;
    if (typeof value.used_percentage !== "number") continue;
    out.push(makeObservation({
      provider: "claude",
      window,
      usedPercent: value.used_percentage,
      status: value.used_percentage >= 100 ? "rejected" : "allowed",
      resetsAt: value.resets_at ?? null,
      observedAt: snapshot.capturedAt,
      source: "official",
      sourceDetail: "Claude Code status line rate_limits (interactive session)",
      reliability: "high"
    }));
  }
  return out;
}

export function importStatuslineSnapshot(home) {
  const p = paths(home);
  if (!fs.existsSync(p.statuslineSnapshot)) return [];
  const snapshot = readJson(p.statuslineSnapshot, null);
  const observations = observationsFromStatuslineSnapshot(snapshot);
  if (observations.length) recordObservations(home, observations);
  return observations;
}
