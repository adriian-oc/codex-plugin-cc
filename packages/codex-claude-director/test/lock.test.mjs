import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withLock } from "../src/util.mjs";
import { tmpdir } from "./helpers.mjs";

test("lock held by a crashed process is broken; lock held by a live process is respected", async () => {
  const dir = tmpdir();
  const lock = path.join(dir, "l.lock");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: Number(dead.stdout), at: Date.now(), host: os.hostname(), token: "dead" }));
  assert.equal(withLock(lock, () => "acquired"), "acquired");
  assert.equal(fs.existsSync(lock), false);

  const live = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 100));
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: live.pid, at: Date.now(), host: os.hostname(), token: "live" }));
  assert.throws(() => withLock(lock, () => "nope", { timeoutMs: 300 }), /Timed out/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, "live");
  live.kill();
});

test("many processes incrementing a counter under the lock never lose an update", async () => {
  const dir = tmpdir();
  const worker = path.join(dir, "w.mjs");
  const util = new URL("../src/util.mjs", import.meta.url).href;
  fs.writeFileSync(worker, `import fs from "node:fs"; import { withLock } from ${JSON.stringify(util)};
const d = process.argv[2]; for (let i = 0; i < 60; i++) withLock(d + "/lock", () => { const f = d + "/c"; const v = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0; fs.writeFileSync(f, String(v + 1)); });`);
  await Promise.all(Array.from({ length: 6 }, () => new Promise((res) => spawn(process.execPath, [worker, dir], { stdio: "ignore" }).on("close", res))));
  assert.equal(Number(fs.readFileSync(path.join(dir, "c"), "utf8")), 360);
});
