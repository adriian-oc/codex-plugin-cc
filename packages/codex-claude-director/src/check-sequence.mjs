#!/usr/bin/env node
// Runs configured checks one after another (argv only, no shell), each with
// its own timeout and output cap, killing the whole process group on timeout.
// Invoked through runner.mjs so the sequence itself can be cancelled.
//
// Usage: node check-sequence.mjs <spec.json>
import { spawn } from "node:child_process";
import fs from "node:fs";

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const results = [];
let current = null;

function save() {
  const tmp = `${spec.resultsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ results, finished: results.length === spec.checks.length }, null, 2));
  fs.renameSync(tmp, spec.resultsFile);
}

function killGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
}

process.on("SIGINT", () => { if (current) killGroup(current, "SIGTERM"); });
process.on("SIGTERM", () => { if (current) killGroup(current, "SIGKILL"); process.exit(143); });

function runOne(check) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(check.argv[0], check.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ name: check.name, exitCode: null, passed: false, error: error.message, durationMs: 0, output: "" });
      return;
    }
    current = child;
    const onData = (chunk) => {
      if (output.length >= spec.maxOutputBytes) { truncated = true; return; }
      output = Buffer.concat([output, chunk.subarray(0, spec.maxOutputBytes - output.length)]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 3000).unref();
    }, (check.timeoutSec ?? spec.defaultTimeoutSec) * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ name: check.name, exitCode: null, passed: false, error: error.message, durationMs: Date.now() - started, output: "" });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      killGroup(child, "SIGKILL"); // leftover grandchildren
      current = null;
      resolve({
        name: check.name,
        argv: check.argv,
        required: check.required,
        exitCode: code,
        signal,
        timedOut,
        passed: code === 0 && !timedOut,
        durationMs: Date.now() - started,
        outputTruncated: truncated,
        output: output.toString("utf8")
      });
    });
  });
}

for (const check of spec.checks) {
  results.push(await runOne(check));
  save();
}
save();
