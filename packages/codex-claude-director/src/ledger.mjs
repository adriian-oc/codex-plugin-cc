// Shared reservation ledger. One ledger per account state home, guarded by a
// cross-process lock, so concurrent tasks and different projects never reserve
// the same capacity twice.
import { paths } from "./config.mjs";
import { newId, nowIso, nowMs, readJson, withLock, writeJsonAtomic } from "./util.mjs";

function emptyLedger() {
  return { version: 1, reservations: [], pathLocks: [] };
}

export function readLedger(home) {
  return readJson(paths(home).ledger, emptyLedger());
}

export function mutateLedger(home, fn) {
  const p = paths(home);
  return withLock(p.ledgerLock, () => {
    const ledger = readJson(p.ledger, emptyLedger());
    pruneLedger(ledger);
    const result = fn(ledger);
    writeJsonAtomic(p.ledger, ledger);
    return result;
  });
}

function pruneLedger(ledger, now = nowMs()) {
  ledger.reservations = ledger.reservations.filter((r) => Date.parse(r.expiresAt) > now);
}

/**
 * Amount (percentage points) of a provider window held by reservations.
 * Released reservations stay counted as "consumed, not yet observed" until a
 * telemetry reading newer than the release time arrives for that window.
 */
export function reservedAmount(ledger, telemetry, provider, window, { excludeTaskId } = {}) {
  let total = 0;
  for (const r of ledger.reservations) {
    if (r.provider !== provider || r.window !== window) continue;
    if (excludeTaskId && r.taskId === excludeTaskId) continue;
    if (r.state === "active") {
      total += r.amountPct;
    } else if (r.state === "consumed") {
      const obs = telemetry?.latest?.[`${provider}:${window}`];
      const observedAfter = obs && Date.parse(obs.observedAt) > Date.parse(r.releasedAt);
      if (!observedAfter) total += r.amountPct;
    }
  }
  return Math.round(total * 100) / 100;
}

export function addReservations(ledger, taskId, project, items, leaseHours) {
  const created = [];
  const expiresAt = new Date(nowMs() + leaseHours * 3600 * 1000).toISOString();
  for (const item of items) {
    if (!(item.amountPct > 0)) continue;
    const r = {
      id: newId("rsv"),
      taskId,
      project,
      provider: item.provider,
      window: item.window,
      phase: item.phase,
      amountPct: Math.round(item.amountPct * 100) / 100,
      units: item.units ?? 1,
      unitAmount: Math.round((item.unitAmount ?? item.amountPct) * 100) / 100,
      basis: item.basis ?? "configured estimate",
      estimate: true,
      state: "active",
      createdAt: nowIso(),
      expiresAt
    };
    ledger.reservations.push(r);
    created.push(r);
  }
  return created;
}

/**
 * Finish a phase: its active reservations become "consumed" (still counted
 * until telemetry catches up). `cancelled` releases them without counting.
 */
export function settlePhase(ledger, taskId, phase, { cancelled = false } = {}) {
  const at = nowIso();
  let n = 0;
  for (const r of ledger.reservations) {
    if (r.taskId !== taskId || r.state !== "active") continue;
    if (phase && r.phase !== phase) continue;
    r.state = cancelled ? "released" : "consumed";
    r.releasedAt = at;
    n += 1;
  }
  ledger.reservations = ledger.reservations.filter((r) => r.state !== "released");
  return n;
}

/**
 * Consume one unit of a multi-unit phase (for example one fix round): that
 * part becomes "consumed", the rest stays reserved.
 */
export function consumeUnit(ledger, taskId, phase) {
  const at = nowIso();
  let n = 0;
  for (const r of [...ledger.reservations]) {
    if (r.taskId !== taskId || r.phase !== phase || r.state !== "active") continue;
    const unit = Math.min(r.unitAmount ?? r.amountPct, r.amountPct);
    ledger.reservations.push({ ...r, id: newId("rsv"), amountPct: unit, units: 1, state: "consumed", releasedAt: at });
    r.amountPct = Math.round((r.amountPct - unit) * 100) / 100;
    r.units = Math.max(0, (r.units ?? 1) - 1);
    n += 1;
  }
  ledger.reservations = ledger.reservations.filter((r) => !(r.state === "active" && r.amountPct <= 0));
  return n;
}

export function releaseTask(ledger, taskId) {
  // Unused reservations for a finished task are dropped; consumed ones stay
  // until observed.
  ledger.reservations = ledger.reservations.filter((r) => !(r.taskId === taskId && r.state === "active"));
  ledger.pathLocks = ledger.pathLocks.filter((l) => l.taskId !== taskId);
}

export function taskReservations(ledger, taskId) {
  return ledger.reservations.filter((r) => r.taskId === taskId);
}

// --- path locks: avoid two agents editing the same files concurrently ------

function normalizeScope(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

export function scopesOverlap(a, b) {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  if (x === "" || y === "") return true; // whole repository
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function findPathConflicts(ledger, repoKey, taskId, scopePaths) {
  const scopes = scopePaths?.length ? scopePaths : [""];
  return ledger.pathLocks.filter((l) => l.repoKey === repoKey && l.taskId !== taskId && scopes.some((s) => scopesOverlap(s, l.path)));
}

export function lockPaths(ledger, repoKey, taskId, scopePaths) {
  const scopes = scopePaths?.length ? scopePaths : [""];
  ledger.pathLocks = ledger.pathLocks.filter((l) => l.taskId !== taskId);
  for (const s of scopes) ledger.pathLocks.push({ repoKey, taskId, path: normalizeScope(s), at: nowIso() });
}
