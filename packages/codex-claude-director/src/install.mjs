// Installation helpers that never overwrite user configuration blindly:
// every change is delimited by markers, preceded by a timestamped backup and
// reversible.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, paths, stateHome } from "./config.mjs";
import { deepMerge, readJson, writeJsonAtomic } from "./util.mjs";

export const BEGIN = "# >>> codex-claude-director >>>";
export const END = "# <<< codex-claude-director <<<";
export const SERVER_NAME = "claude_director";

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.bak-ccd-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function codexBlock({ nodePath, serverPath, home }) {
  return [
    BEGIN,
    "# Unofficial extension: lets Codex delegate tasks to Claude Code. Remove this block to disable.",
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(serverPath)}]`,
    `env = { CCD_HOME = ${tomlString(home)} }`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    END,
    ""
  ].join("\n");
}

export function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return { text, found: false };
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error("Found the start marker but not the end marker in config.toml; refusing to edit. Fix it by hand.");
  const after = text.slice(end + END.length).replace(/^\r?\n/, "");
  return { text: text.slice(0, start) + after, found: true };
}

export function installCodexConfig({ codexHome = path.join(os.homedir(), ".codex"), nodePath = process.execPath, serverPath, home = stateHome(), dryRun = false } = {}) {
  const file = path.join(codexHome, "config.toml");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const { text: withoutOurs } = stripBlock(current);
  if (new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, "m").test(withoutOurs)) {
    throw new Error(`config.toml already defines [mcp_servers.${SERVER_NAME}] outside our markers; not touching it.`);
  }
  const block = codexBlock({ nodePath, serverPath, home });
  const next = `${withoutOurs.replace(/\s*$/, "")}${withoutOurs.trim() ? "\n\n" : ""}${block}`;
  if (dryRun) return { file, next };
  fs.mkdirSync(codexHome, { recursive: true });
  const bak = backup(file);
  fs.writeFileSync(file, next);
  return { file, backup: bak };
}

export function uninstallCodexConfig({ codexHome = path.join(os.homedir(), ".codex") } = {}) {
  const file = path.join(codexHome, "config.toml");
  if (!fs.existsSync(file)) return { file, removed: false };
  const current = fs.readFileSync(file, "utf8");
  const { text, found } = stripBlock(current);
  if (!found) return { file, removed: false };
  const bak = backup(file);
  fs.writeFileSync(file, text);
  return { file, removed: true, backup: bak };
}

function which(bin) {
  const r = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Create/merge the coordinator config, pinning absolute binary paths. */
export function initCoordinatorConfig(home = stateHome()) {
  const p = paths(home);
  const existing = readJson(p.config, null);
  const merged = deepMerge(DEFAULT_CONFIG, existing ?? {});
  const claude = which("claude");
  const codex = which("codex");
  if (claude && (!existing?.claude?.bin || existing.claude.bin === "claude")) merged.claude.bin = claude;
  if (codex && (!existing?.codex?.bin || existing.codex.bin === "codex")) merged.codex.bin = codex;
  const bak = existing ? backup(p.config) : null;
  writeJsonAtomic(p.config, merged);
  return { file: p.config, backup: bak, claude, codex };
}

// --- Claude Code status line bridge ---------------------------------------

export function installStatusline({ claudeHome = path.join(os.homedir(), ".claude"), nodePath = process.execPath, bridgePath, home = stateHome() } = {}) {
  const file = path.join(claudeHome, "settings.json");
  const settings = readJson(file, {}) ?? {};
  const ours = `${JSON.stringify(nodePath)} ${JSON.stringify(bridgePath)}`;
  const chainFile = path.join(home, "statusline-chain.json");
  if (settings.statusLine?.command && settings.statusLine.command.includes(bridgePath)) return { file, alreadyInstalled: true };
  // Keep the user's previous status line and run it after capturing data.
  const previous = settings.statusLine ?? null;
  writeJsonAtomic(chainFile, { previous, savedAt: new Date().toISOString() });
  const bak = backup(file);
  settings.statusLine = { type: "command", command: `CCD_HOME=${JSON.stringify(home)} ${ours}` };
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, backup: bak, chained: Boolean(previous) };
}

export function uninstallStatusline({ claudeHome = path.join(os.homedir(), ".claude"), home = stateHome(), bridgePath } = {}) {
  const file = path.join(claudeHome, "settings.json");
  const settings = readJson(file, null);
  if (!settings?.statusLine?.command?.includes(bridgePath)) return { file, removed: false };
  const chain = readJson(path.join(home, "statusline-chain.json"), null);
  const bak = backup(file);
  if (chain?.previous) settings.statusLine = chain.previous;
  else delete settings.statusLine;
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, removed: true, restored: Boolean(chain?.previous), backup: bak };
}
