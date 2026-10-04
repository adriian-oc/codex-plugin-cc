#!/usr/bin/env node
// Command-line helper for installation, diagnostics and manual capacity input.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stateHome } from "../src/config.mjs";
import { capacityStatus, createContext, doctor, recordManualCapacity, taskStatus } from "../src/orchestrator.mjs";
import { initCoordinatorConfig, installCodexConfig, installStatusline, uninstallCodexConfig, uninstallStatusline } from "../src/install.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "ccd-mcp.mjs");
const bridgePath = path.join(here, "ccd-statusline.mjs");
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const print = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

const usage = `codex-claude-director (unofficial)

  ccd install [--dry-run] [--with-statusline]   Configure the coordinator and register the MCP server in ~/.codex/config.toml
  ccd uninstall                                  Remove the MCP block and the status line bridge (backups are kept)
  ccd statusline install|uninstall               Claude Code status line bridge (official rate_limits fields)
  ccd doctor                                     Diagnose binaries, auth/billing mode and state
  ccd capacity [--refresh]                       Show capacity readings, reservations and headroom
  ccd capacity set --provider claude|codex --window five_hour|seven_day --used <0-100> [--resets <ISO>]
  ccd tasks                                      List tasks
State home: ${stateHome()}`;

try {
  switch (cmd) {
    case "install": {
      const cfg = initCoordinatorConfig();
      const codex = installCodexConfig({ serverPath, dryRun: flag("dry-run") });
      const out = { coordinatorConfig: cfg, codexConfig: flag("dry-run") ? { file: codex.file, preview: codex.next } : codex };
      if (flag("with-statusline") && !flag("dry-run")) out.statusline = installStatusline({ bridgePath });
      print(out);
      break;
    }
    case "uninstall":
      print({ codex: uninstallCodexConfig(), statusline: uninstallStatusline({ bridgePath }) });
      break;
    case "statusline":
      print(rest[0] === "uninstall" ? uninstallStatusline({ bridgePath }) : installStatusline({ bridgePath }));
      break;
    case "doctor":
      print(await doctor(createContext()));
      break;
    case "capacity": {
      const ctx = createContext();
      if (rest[0] === "set") {
        print(recordManualCapacity(ctx, { provider: opt("provider"), window: opt("window"), usedPercent: Number(opt("used")), resetsAt: opt("resets"), note: "ccd capacity set" }));
      } else {
        print(await capacityStatus(ctx, { refresh: flag("refresh") }));
      }
      break;
    }
    case "tasks":
      print(await taskStatus(createContext(), {}));
      break;
    default:
      process.stdout.write(`${usage}\n`);
      process.exitCode = cmd ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}
