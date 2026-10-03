// Small shared helpers: atomic JSON files, a cross-process lock, ids and time.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function nowMs() {
  const override = process.env.CCD_FAKE_NOW_MS;
  return override ? Number(override) : Date.now();
}

export function nowIso() {
  return new Date(nowMs()).toISOString();
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function newUuid() {
  return randomUUID();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      // Keep the unreadable file for inspection instead of silently losing it.
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, quarantine);
      } catch {}
      return fallback;
    }
    throw error;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "EPERM";
  }
  // A zombie (exited, not yet reaped) is not a live process.
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim().startsWith("Z")) return false;
  return true;
}

/**
 * Cross-process mutual exclusion based on an atomic mkdir. A lock is broken
 * only when its recorded owner process is gone (or it is older than staleMs),
 * and only after re-reading the owner record to confirm it is still the same
 * acquisition (owner token), so a lock that was released and re-acquired by a
 * live process in the meantime is never broken.
 */
export function withLock(lockDir, fn, { timeoutMs = 15000, staleMs = 60000 } = {}) {
  ensureDir(path.dirname(lockDir));
  const ownerFile = path.join(lockDir, "owner.json");
  const token = randomBytes(8).toString("hex");
  const readOwner = () => {
    try {
      return JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    } catch {
      return null;
    }
  };
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname(), token }));
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readOwner();
      let age = 0;
      if (owner) {
        age = Date.now() - owner.at;
      } else {
        try {
          age = Date.now() - fs.statSync(lockDir).mtimeMs;
        } catch {
          continue; // released meanwhile
        }
      }
      const ownerGone = owner && owner.host === os.hostname() && !pidAlive(owner.pid);
      if ((ownerGone || age > staleMs) && (!owner || readOwner()?.token === owner.token)) {
        const tomb = `${lockDir}.stale-${process.pid}-${randomBytes(3).toString("hex")}`;
        try {
          fs.renameSync(lockDir, tomb);
          const broken = (() => {
            try {
              return JSON.parse(fs.readFileSync(path.join(tomb, "owner.json"), "utf8"));
            } catch {
              return null;
            }
          })();
          if (owner && broken && broken.token !== owner.token) {
            // We raced with a fresh acquisition: put it back untouched.
            try {
              fs.renameSync(tomb, lockDir);
            } catch {}
          } else {
            fs.rmSync(tomb, { recursive: true, force: true });
          }
        } catch {}
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for lock ${lockDir}`);
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    // Release only our own acquisition.
    if (readOwner()?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export function truncateText(text, maxBytes) {
  const value = String(text ?? "");
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return { text: value, truncated: false, bytes: buf.length };
  return { text: `${buf.subarray(0, maxBytes).toString("utf8")}\n…[truncated ${buf.length - maxBytes} bytes]`, truncated: true, bytes: buf.length };
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}
