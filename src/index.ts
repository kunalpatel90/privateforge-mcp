#!/usr/bin/env node
// index.ts — pf-mcp entry point.
//
// Starts the MCP server in two modes (both can run together):
//   1. Local Streamable HTTP endpoint on http://127.0.0.1:7820/mcp
//      — lets any MCP client (Claude Desktop, Cursor, custom scripts) talk
//        to pf-mcp directly. Always on. Honors PF_MCP_HOST / PF_MCP_PORT.
//   2. Outbound WSS tunnel to PrivateForge cloud
//      — opt-in: only enabled when PF_GATEWAY_URL and PF_TOKEN are both set.
//
// We never read user inference credentials. Each wrapped CLI (claude, codex,
// gemini) authenticates itself against its own config dir; we just spawn it
// and capture stdout/stderr. That's the OpenClaw legal posture in code.

import { McpServer } from "./mcp-server.js";
import { startLocalServer } from "./local-server.js";
import { TunnelClient } from "./tunnel/client.js";
import { ClaudeAdapter } from "./adapters/claude/index.js";
import { CodexAdapter } from "./adapters/codex/index.js";
import { GeminiAdapter } from "./adapters/gemini/index.js";
import { HealthAdapter } from "./adapters/health/index.js";

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const server = new McpServer();
  const host = process.env.PF_MCP_HOST ?? "127.0.0.1";
  const port = readEnvNumber("PF_MCP_PORT", 7820);

  // Always start the local endpoint — it's how standalone MCP clients talk to us.
  startLocalServer(server, port, host);

  // Optionally bring up the cloud tunnel when configured.
  const gatewayUrl = process.env.PF_GATEWAY_URL;
  const token = process.env.PF_TOKEN;
  if (gatewayUrl && token) {
    // Build a tiny health probe so the cloud knows what's available.
    const claude = new ClaudeAdapter();
    const codex = new CodexAdapter();
    const gemini = new GeminiAdapter();
    const health = new HealthAdapter(claude, codex, gemini);
    const providerCapabilities = async () => {
      try {
        const snapshot = await health.providers();
        return snapshot as unknown as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    const tunnel = new TunnelClient(
      server,
      {
        gatewayUrl,
        token,
        machineId: process.env.PF_MACHINE_ID,
        pfAuthHeader: process.env.PF_AUTH_HEADER,
      },
      providerCapabilities,
    );
    tunnel.start();

    const shutdown = (signal: string) => {
      // eslint-disable-next-line no-console
      console.log(`[pf-mcp] received ${signal}, shutting down`);
      tunnel.stop();
      // Give the close frame a moment to flush before exiting.
      setTimeout(() => process.exit(0), 250);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[pf-mcp] tunnel disabled (set PF_GATEWAY_URL and PF_TOKEN to enable cloud mode)",
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[pf-mcp] fatal:", err);
  process.exit(1);
});
