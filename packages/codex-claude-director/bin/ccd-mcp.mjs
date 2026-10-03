#!/usr/bin/env node
// Entry point registered in Codex (~/.codex/config.toml) as a stdio MCP server.
import { serveStdio } from "../src/mcp-server.mjs";

serveStdio();
