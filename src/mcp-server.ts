// mcp-server.ts — minimal MCP JSON-RPC dispatcher.
//
// We hand-roll the MCP wire surface (initialize, tools/list, tools/call) to
// avoid pulling in @modelcontextprotocol/sdk. The server is transport-agnostic
// — both the local Streamable HTTP endpoint and the cloud tunnel feed JSON-RPC
// frames into `dispatch()` and write responses back the same way.
//
// Notifications (notifications/progress, etc.) are not yet emitted. v2.

import { createHash } from "node:crypto";
import { buildTools } from "./tools.js";
import type { McpTool } from "./types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: number | string;
      result: Record<string, unknown> | unknown[];
    }
  | {
      jsonrpc: "2.0";
      id: number | string | null;
      error: { code: number; message: string; data?: unknown };
    };

export class McpServer {
  private tools: Map<string, McpTool> = new Map();
  private toolsListCache: { result: { tools: McpTool["descriptor"][] }; hash: string } | null = null;
  public readonly serverInfo = { name: "pf-mcp", version: "0.1.0" };

  constructor() {
    for (const t of buildTools()) {
      this.tools.set(t.descriptor.name, t);
    }
    this.toolsListCache = this.computeToolsList();
  }

  /** SHA-256 hex of the tools/list response — used for the cloud's mcp_hello. */
  toolRegistryHash(): string {
    return this.toolsListCache?.hash ?? this.computeToolsList().hash;
  }

  private computeToolsList(): NonNullable<typeof this.toolsListCache> {
    const tools = Array.from(this.tools.values()).map((t) => t.descriptor);
    const result = { tools };
    const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    return { result, hash };
  }

  /** Dispatch a single JSON-RPC frame. Returns the response, or null for notifications. */
  async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Notification (no id) — we don't emit responses but we still process them.
    const isNotification = req.id === undefined || req.id === null;
    const id = (req.id ?? null) as number | string | null;

    try {
      switch (req.method) {
        case "initialize": {
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id: id!,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: this.serverInfo,
            },
          };
        }
        case "notifications/initialized":
          // Standard MCP handshake completion; nothing to do.
          return null;
        case "tools/list": {
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id: id!,
            result: this.toolsListCache!.result,
          };
        }
        case "tools/call": {
          if (isNotification) return null;
          const params = req.params ?? {};
          const name = String(params.name ?? "");
          const tool = this.tools.get(name);
          if (!tool) {
            return {
              jsonrpc: "2.0",
              id: id!,
              error: { code: -32602, message: `tool not found: ${name}` },
            };
          }
          const args = (params.arguments as Record<string, unknown>) ?? {};
          const result = await tool.handler(args);
          return { jsonrpc: "2.0", id: id!, result: result as unknown as Record<string, unknown> };
        }
        case "ping": {
          if (isNotification) return null;
          return { jsonrpc: "2.0", id: id!, result: {} };
        }
        default: {
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id: id!,
            error: { code: -32601, message: `method not found: ${req.method}` },
          };
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: id!,
        error: { code: -32603, message },
      };
    }
  }
}
