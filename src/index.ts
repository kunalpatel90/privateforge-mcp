#!/usr/bin/env node
// index.ts — pf-mcp entry point.
//
// Three transport modes; any subset can run together:
//
//   1. stdio (auto-detected when stdin isn't a TTY, or forced with --stdio)
//      — used by Claude Code / Cursor / any MCP host that spawns plugins.
//      In stdio mode the local HTTP listener is OFF by default to keep
//      stdout clean; pass --http alongside --stdio to run both.
//
//   2. local Streamable HTTP on http://127.0.0.1:7820/mcp (default when
//      stdin IS a TTY, e.g. user ran `pf-mcp` in their terminal). Honors
//      PF_MCP_HOST / PF_MCP_PORT.
//
//   3. outbound WSS tunnel to PrivateForge cloud — opt-in: only enabled
//      when PF_GATEWAY_URL and PF_TOKEN are both set. Runs in any mode.
//
// We never read user inference credentials. Each wrapped CLI authenticates
// itself against its own config dir; we just spawn it and capture stdout.
// That's the OpenClaw legal posture in code.

import { McpServer } from "./mcp-server.js";
import { startLocalServer } from "./local-server.js";
import { startStdioServer } from "./stdio-server.js";
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

interface Modes {
  stdio: boolean;
  http: boolean;
}

function resolveModes(argv: string[]): Modes {
  const flags = new Set(argv.slice(2));
  const wantStdio = flags.has("--stdio");
  const wantHttp = flags.has("--http");
  const wantNoHttp = flags.has("--no-http");

  // Auto-detect: stdin attached to a non-TTY (pipe, socket) implies host-spawn.
  const stdinIsTty = Boolean((process.stdin as NodeJS.ReadStream).isTTY);
  const auto = !stdinIsTty;

  // Explicit flags win over auto-detection.
  if (wantStdio || wantHttp) {
    return { stdio: wantStdio, http: wantHttp };
  }

  if (auto) {
    // Spawned by a host — stdio only. HTTP would emit on stdout via console.log
    // and corrupt the JSON-RPC stream.
    return { stdio: true, http: false };
  }

  // Interactive terminal launch — HTTP only by default.
  return { stdio: false, http: !wantNoHttp };
}

async function main(): Promise<void> {
  const server = new McpServer();
  const modes = resolveModes(process.argv);

  if (modes.stdio) {
    startStdioServer(server);
  }

  if (modes.http) {
    const host = process.env.PF_MCP_HOST ?? "127.0.0.1";
    const port = readEnvNumber("PF_MCP_PORT", 7820);
    startLocalServer(server, port, host);
  }

  // Optionally bring up the cloud tunnel when configured. Independent of
  // stdio/http — the tunnel can run alongside either or both.
  const gatewayUrl = process.env.PF_GATEWAY_URL;
  const token = process.env.PF_TOKEN;
  if (gatewayUrl && token) {
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
      // In stdio mode, keep stdout clean — log to stderr only.
      process.stderr.write(`[pf-mcp] received ${signal}, shutting down\n`);
      tunnel.stop();
      setTimeout(() => process.exit(0), 250);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } else if (modes.http) {
    // Only chatter on stdout when we're already in HTTP mode — never in pure stdio.
    // eslint-disable-next-line no-console
    console.log(
      "[pf-mcp] tunnel disabled (set PF_GATEWAY_URL and PF_TOKEN to enable cloud mode)",
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[pf-mcp] fatal: ${err}\n`);
  process.exit(1);
});
