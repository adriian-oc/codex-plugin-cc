#!/usr/bin/env node
// Claude Code status line bridge. Claude Code pipes documented session JSON to
// this command; we keep ONLY the `rate_limits` object (no transcript path,
// no prompts) and then run the user's previous status line, if any.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { paths, stateHome } from "../src/config.mjs";
import { readJson, writeJsonAtomic } from "../src/util.mjs";

const input = fs.readFileSync(0, "utf8");
const home = stateHome();
let data = null;
try {
  data = JSON.parse(input);
} catch {}

if (data && data.rate_limits && typeof data.rate_limits === "object") {
  const keep = {};
  for (const [k, v] of Object.entries(data.rate_limits)) {
    if (v && typeof v === "object" && typeof v.used_percentage === "number") {
      keep[k] = { used_percentage: v.used_percentage, resets_at: v.resets_at ?? null };
    }
  }
  try {
    writeJsonAtomic(paths(home).statuslineSnapshot, { capturedAt: new Date().toISOString(), claudeVersion: data.version ?? null, rate_limits: keep });
  } catch {}
}

const chain = readJson(path.join(home, "statusline-chain.json"), null);
const previous = chain?.previous?.command;
if (previous) {
  // The previous command is the user's own status line, which Claude Code
  // itself ran through a shell; run it the same way with the same input.
  const r = spawnSync("/bin/sh", ["-c", previous], { input, encoding: "utf8", timeout: 5000 });
  process.stdout.write(r.stdout ?? "");
} else if (data?.rate_limits) {
  const fmt = (w) => (typeof w?.used_percentage === "number" ? `${Math.round(w.used_percentage)}%` : "?");
  process.stdout.write(`5h ${fmt(data.rate_limits.five_hour)} · 7d ${fmt(data.rate_limits.seven_day)}`);
}
