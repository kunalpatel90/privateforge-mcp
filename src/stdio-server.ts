// stdio-server.ts — MCP over stdio (newline-delimited JSON-RPC).
//
// This is what lets pf-mcp run as a Claude Code plugin (or any other host
// that spawns its servers and communicates over stdin/stdout). The host
// pipes one JSON object per line to stdin; we write one JSON object per
// line to stdout. stderr is free for diagnostic logging.
//
// Same dispatch core as the local HTTP and tunnel transports — just a
// different I/O surface.

import { McpServer, type JsonRpcRequest } from "./mcp-server.js";

export function startStdioServer(server: McpServer): void {
  // Buffer partial lines — stdin chunks don't always align with frames.
  let buffer = "";
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        void handleLine(server, line);
      }
      idx = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    // Host closed stdin — exit cleanly so the parent doesn't see a hang.
    process.exit(0);
  });

  // Stay quiet on stdout until we have a real frame to emit.
  process.stderr.write("[pf-mcp] stdio MCP server ready\n");
}

async function handleLine(server: McpServer, line: string): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeFrame({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    return;
  }
  try {
    const response = await server.dispatch(req);
    if (response !== null) writeFrame(response);
  } catch (e) {
    writeFrame({
      jsonrpc: "2.0",
      id: (req.id ?? null) as number | string | null,
      error: { code: -32603, message: (e as Error).message },
    });
  }
}

function writeFrame(frame: unknown): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}
