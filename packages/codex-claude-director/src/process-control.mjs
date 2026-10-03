// Start detached runners and control them safely after restarts.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newId, pidAlive, readJson, writeJsonAtomic } from "./util.mjs";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner.mjs");

/** Start time + command of a live process, used to confirm identity later. */
export function processSignature(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-o", "args=", "-p", String(pid)], { encoding: "utf8", shell: false });
  if (r.status !== 0) return null;
  const line = r.stdout.trim();
  return line || null;
}

export function startRunner(runDir, { argv, cwd, env, stdinText, timeoutMs, maxOutputBytes, killGraceMs }) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const nonce = newId("run");
  const spec = {
    argv,
    cwd,
    env,
    stdoutFile: path.join(runDir, "stdout.jsonl"),
    stderrFile: path.join(runDir, "stderr.log"),
    exitFile: path.join(runDir, "exit.json"),
    runnerFile: path.join(runDir, "runner.json"),
    timeoutMs,
    maxOutputBytes,
    killGraceMs
  };
  if (stdinText !== undefined) {
    spec.stdinFile = path.join(runDir, "stdin.txt");
    fs.writeFileSync(spec.stdinFile, stdinText, { mode: 0o600 });
  }
  const specFile = path.join(runDir, "spec.json");
  writeJsonAtomic(specFile, spec);
  const child = spawn(process.execPath, [RUNNER, specFile, nonce], {
    cwd,
    detached: true,
    stdio: "ignore",
    shell: false,
    env: { PATH: process.env.PATH ?? "" }
  });
  child.unref();
  writeJsonAtomic(path.join(runDir, "launch.json"), { nonce, runnerPid: child.pid, launchedAt: new Date().toISOString() });
  return { nonce, runnerPid: child.pid, runDir };
}

export function runFiles(runDir) {
  return {
    stdout: path.join(runDir, "stdout.jsonl"),
    stderr: path.join(runDir, "stderr.log"),
    exit: path.join(runDir, "exit.json"),
    runner: path.join(runDir, "runner.json"),
    launch: path.join(runDir, "launch.json")
  };
}

/**
 * State of a run: "exited" (exit record present), "running" (runner alive and
 * verified), or "lost" (no exit record and runner not running / not ours).
 */
export function runState(runDir) {
  const f = runFiles(runDir);
  const exit = readJson(f.exit, null);
  if (exit) return { state: "exited", exit };
  const launch = readJson(f.launch, null);
  const runner = readJson(f.runner, null);
  const pid = runner?.runnerPid ?? launch?.runnerPid;
  const nonce = runner?.nonce ?? launch?.nonce;
  if (pid && verifyRunner(pid, nonce)) return { state: "running", pid };
  // The runner may have written its exit record and exited between the first
  // read and the liveness check.
  const lateExit = readJson(f.exit, null);
  if (lateExit) return { state: "exited", exit: lateExit };
  // Give a just-launched runner a moment to write its files.
  if (launch && !runner && Date.now() - Date.parse(launch.launchedAt) < 5000) return { state: "starting", pid };
  return { state: "lost", pid: pid ?? null };
}

export function verifyRunner(pid, nonce) {
  if (!pidAlive(pid)) return false;
  const sig = processSignature(pid);
  // The PID must still belong to *our* runner: its argv carries the nonce.
  return Boolean(sig && nonce && sig.includes(nonce) && sig.includes("runner.mjs"));
}

/** Cancel a run. Never signals a PID whose identity cannot be confirmed. */
export async function cancelRun(runDir, { waitMs = 15000 } = {}) {
  const f = runFiles(runDir);
  const runner = readJson(f.runner, null);
  const launch = readJson(f.launch, null);
  const pid = runner?.runnerPid ?? launch?.runnerPid;
  const nonce = runner?.nonce ?? launch?.nonce;
  const actions = [];
  if (pid && verifyRunner(pid, nonce)) {
    process.kill(pid, "SIGTERM");
    actions.push({ pid, signal: "SIGTERM", target: "runner" });
  } else if (runner?.childPid && pidAlive(runner.childPid)) {
    // Runner gone (crash). Only kill the child if its start time and command
    // still match what the runner recorded.
    const sig = processSignature(runner.childPid);
    if (sig && runner.childSignature && sig === runner.childSignature) {
      try { process.kill(-runner.childPid, "SIGTERM"); } catch { try { process.kill(runner.childPid, "SIGTERM"); } catch {} }
      actions.push({ pid: runner.childPid, signal: "SIGTERM", target: "orphan-child" });
    } else {
      actions.push({ pid: runner.childPid, skipped: "pid reused by another process; not signalled" });
    }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (readJson(f.exit, null)) break;
    if (!(pid && pidAlive(pid))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { actions, exit: readJson(f.exit, null) };
}
