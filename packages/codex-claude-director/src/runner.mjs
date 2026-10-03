#!/usr/bin/env node
// Detached supervisor for one child process (a Claude worker run or a check).
// It survives MCP server restarts, enforces duration and output limits,
// forwards cancellation to the child's whole process group and always writes
// an exit record.
//
// Usage: node runner.mjs <spec.json> <nonce>
import { spawn } from "node:child_process";
import fs from "node:fs";

import { processSignature } from "./process-control.mjs";

const [specFile, nonce] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
const startedAt = new Date().toISOString();

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let child;
let reason = null;
let finished = false;
let escalation = null;
const out = fs.openSync(spec.stdoutFile, "a");
const err = fs.openSync(spec.stderrFile, "a");
let outBytes = 0;
let errBytes = 0;
const maxOut = spec.maxOutputBytes ?? 20 * 1024 * 1024;
const maxErr = Math.min(maxOut, 2 * 1024 * 1024);

function signalGroup(sig) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try { child.kill(sig); } catch {}
  }
}

function stop(why) {
  if (reason === null) reason = why;
  if (escalation) return;
  const grace = spec.killGraceMs ?? 5000;
  // SIGINT first lets Claude Code finish the turn cleanly; then SIGTERM, then SIGKILL.
  signalGroup("SIGINT");
  escalation = setTimeout(() => {
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), grace);
    escalation.unref?.();
  }, grace);
}

function finish(record) {
  if (finished) return;
  finished = true;
  try { fs.closeSync(out); } catch {}
  try { fs.closeSync(err); } catch {}
  writeJson(spec.exitFile, { nonce, startedAt, endedAt: new Date().toISOString(), outputBytes: outBytes, ...record, reason: reason ?? record.reason ?? "exited" });
  // Make sure no grandchild survives the run.
  signalGroup("SIGKILL");
  process.exit(0);
}

process.on("SIGTERM", () => stop("cancelled"));
process.on("SIGINT", () => stop("cancelled"));
process.on("SIGHUP", () => {});

try {
  child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: [spec.stdinFile ? "pipe" : "ignore", "pipe", "pipe"],
    detached: true,
    shell: false
  });
} catch (error) {
  finish({ exitCode: null, signal: null, reason: "spawn_error", error: error.message });
}

child.on("error", (error) => finish({ exitCode: null, signal: null, reason: "spawn_error", error: error.message }));

if (child.pid) {
  writeJson(spec.runnerFile, {
    nonce,
    runnerPid: process.pid,
    runnerSignature: processSignature(process.pid),
    childPid: child.pid,
    childSignature: processSignature(child.pid),
    startedAt
  });
}

if (spec.stdinFile && child.stdin) {
  fs.createReadStream(spec.stdinFile).pipe(child.stdin);
  child.stdin.on("error", () => {});
}

child.stdout.on("data", (chunk) => {
  if (outBytes + chunk.length > maxOut) {
    const room = Math.max(0, maxOut - outBytes);
    if (room) fs.writeSync(out, chunk.subarray(0, room));
    outBytes += room;
    stop("output_limit");
    return;
  }
  outBytes += chunk.length;
  fs.writeSync(out, chunk);
});
child.stderr.on("data", (chunk) => {
  if (errBytes >= maxErr) return;
  const part = chunk.subarray(0, maxErr - errBytes);
  errBytes += part.length;
  fs.writeSync(err, part);
});

const timer = setTimeout(() => stop("timeout"), spec.timeoutMs ?? 45 * 60 * 1000);
timer.unref?.();

child.on("close", (code, signal) => {
  clearTimeout(timer);
  if (escalation) clearTimeout(escalation);
  finish({ exitCode: code, signal });
});
