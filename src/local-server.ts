// local-server.ts — Streamable HTTP endpoint on localhost.
//
// Lets any MCP client (Claude Desktop, Cursor, a custom @modelcontextprotocol
// script) talk to pf-mcp directly without the cloud tunnel. This is what
// makes G-5 ("usable standalone, without PrivateForge Cloud") true.
//
// Wire format: HTTP POST with a JSON-RPC body. Streaming responses use SSE
// (text/event-stream). v1 doesn't emit notifications/progress yet, so most
// responses are a single JSON object.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer, type JsonRpcRequest } from "./mcp-server.js";

const DEFAULT_PORT = 7820;
const DEFAULT_HOST = "127.0.0.1";

async function readBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export function startLocalServer(server: McpServer, port = DEFAULT_PORT, host = DEFAULT_HOST) {
  const http = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    if (req.url !== "/mcp" && req.url !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (e) {
      writeJson(res, 413, { error: (e as Error).message });
      return;
    }

    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }

    if (Array.isArray(parsed)) {
      const out = await Promise.all(parsed.map((r) => server.dispatch(r)));
      const filtered = out.filter((r) => r !== null);
      writeJson(res, 200, filtered);
    } else {
      const response = await server.dispatch(parsed);
      if (response === null) {
        // Pure notification — return 202 with empty body.
        res.writeHead(202);
        res.end();
        return;
      }
      writeJson(res, 200, response);
    }
  });

  http.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[pf-mcp] local MCP endpoint listening on http://${host}:${port}/mcp`);
  });
  return http;
}
