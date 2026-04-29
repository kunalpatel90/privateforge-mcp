// tunnel/client.ts — outbound WSS tunnel to PrivateForge cloud.
//
// Wire surface (matches server/routes-proxy.ts on the cloud):
//
//   pf-mcp -> SaaS:
//     { type: "mcp_hello",    v, tool_registry_hash, provider_capabilities }
//     { type: "mcp_response", reqId, ok, result?, error? }
//     { type: "mcp_progress", reqId, progress }
//     { type: "pong" }     — reply to server pings
//     { type: "ping" }     — also accepted, server replies with pong
//
//   SaaS -> pf-mcp:
//     { type: "mcp_request", reqId, method, params }
//     { type: "ping" }
//
// Connection lifecycle:
//   1. open WSS to <gatewayUrl>/v1/proxy with Authorization: Bearer <token>
//   2. on open: emit mcp_hello with version + tool_registry_hash + provider_caps
//   3. for each inbound mcp_request: dispatch via McpServer, emit mcp_response
//   4. exponential backoff reconnect on close (1s -> 30s ceiling)

import WebSocket from "ws";
import { McpServer, type JsonRpcRequest } from "../mcp-server.js";

export interface TunnelOpts {
  /** e.g. "wss://api.privateforge.ai" — `/v1/proxy` is appended */
  gatewayUrl: string;
  /** desktop session token (long-lived) used as Bearer auth */
  token: string;
  /** Stable machine identity. Cloud uses this to dedupe sockets. */
  machineId?: string;
  /** Optional X-PF-Auth nonce HMAC header (when PF_REQUIRE_NONCE=1 cloud-side). */
  pfAuthHeader?: string;
}

interface TunnelFrame {
  type: string;
  reqId?: string;
  method?: string;
  params?: unknown;
}

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Outbound app-level keepalive cadence. The cloud sends pings every 25s and
 * we reply with `pong`; we ALSO send our own pings on the same cadence so
 * intermediaries (Cloudflare/Render) that key idle on either-direction traffic
 * see continuous activity. Belt and suspenders. */
const KEEPALIVE_MS = 25_000;

export class TunnelClient {
  private ws: WebSocket | null = null;
  private closing = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  /** Cached provider snapshot. Reused on fast reconnects so we don't block
   * the WS upgrade window while running CLI probes. Refreshed asynchronously
   * after each successful open. */
  private lastCaps: Record<string, unknown> | null = null;

  private fastInstalledCaps(): Record<string, unknown> {
    // Optimistic stub — claims providers are present; cloud uses optimistic
    // fallback for healthy state until the refresh hello arrives.
    return {
      claude: { installed: true, authed: true, version: null, lastSuccessAt: null },
      codex:  { installed: true, authed: true, version: null, lastSuccessAt: null },
      gemini: { installed: true, authed: false, version: null, lastSuccessAt: null },
    };
  }

  constructor(
    private readonly server: McpServer,
    private readonly opts: TunnelOpts,
    private readonly providerCapabilities: () => Promise<Record<string, unknown>>,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.ws) {
      try {
        this.ws.close(1000, "client shutdown");
      } catch {
        /* ignore */
      }
    }
  }

  private connect(): void {
    if (this.closing) return;
    let url = this.opts.gatewayUrl.replace(/\/+$/, "") + "/v1/proxy";
    if (this.opts.machineId) {
      url += `?machineId=${encodeURIComponent(this.opts.machineId)}`;
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.token}`,
    };
    if (this.opts.pfAuthHeader) headers["x-pf-auth"] = this.opts.pfAuthHeader;

    // eslint-disable-next-line no-console
    console.log(`[pf-mcp] tunnel: connecting to ${url}`);
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectMs = RECONNECT_INITIAL_MS;
      // eslint-disable-next-line no-console
      console.log("[pf-mcp] tunnel: connected; sending mcp_hello (fast)");
      // Start outbound keepalive. Idle WSS connections through Cloudflare are
      // closed with code 1006 after their idle threshold; periodic pings keep
      // the path warm even if the cloud's heartbeat misfires.
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
        } catch {
          /* close handler will run */
        }
      }, KEEPALIVE_MS);
      // Send a minimal hello IMMEDIATELY so the cloud upserts the runner row
      // and registers capabilities, without waiting on slow CLI probes that
      // could let intermediaries (Cloudflare/Render) close an idle WS.
      try {
        const fastCaps = this.lastCaps ?? this.fastInstalledCaps();
        const hello = {
          type: "mcp_hello",
          v: this.server.serverInfo.version,
          tool_registry_hash: this.server.toolRegistryHash(),
          provider_capabilities: fastCaps,
        };
        ws.send(JSON.stringify(hello));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[pf-mcp] tunnel: fast-hello failed: ${(e as Error).message}`);
      }
      // Then asynchronously run the real provider health check and emit a
      // refreshed mcp_hello with full installed+authed snapshot.
      void (async () => {
        try {
          const caps = await this.providerCapabilities();
          this.lastCaps = caps;
          if (ws.readyState !== WebSocket.OPEN) return;
          const hello = {
            type: "mcp_hello",
            v: this.server.serverInfo.version,
            tool_registry_hash: this.server.toolRegistryHash(),
            provider_capabilities: caps,
          };
          ws.send(JSON.stringify(hello));
          // eslint-disable-next-line no-console
          console.log("[pf-mcp] tunnel: refreshed mcp_hello with full caps");
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[pf-mcp] tunnel: refresh-hello failed: ${(e as Error).message}`);
        }
      })();
    });

    ws.on("message", async (raw) => {
      let frame: TunnelFrame;
      try {
        frame = JSON.parse(raw.toString()) as TunnelFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== "string") return;

      switch (frame.type) {
        case "ping":
          try {
            ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
          } catch {
            /* ignore */
          }
          return;
        case "pong":
          return;
        case "mcp_request": {
          if (typeof frame.reqId !== "string" || typeof frame.method !== "string") return;
          await this.handleRequest(ws, frame.reqId, frame.method, frame.params);
          return;
        }
        default:
          return;
      }
    });

    ws.on("close", (code, reason) => {
      // eslint-disable-next-line no-console
      console.log(
        `[pf-mcp] tunnel: closed code=${code} reason=${reason?.toString() || ""}`,
      );
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
      this.ws = null;
      if (this.closing) return;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error(`[pf-mcp] tunnel: socket error: ${err.message}`);
    });
  }

  private async handleRequest(
    ws: WebSocket,
    reqId: string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const rpc: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: reqId,
      method,
      params: (params as Record<string, unknown>) ?? {},
    };
    try {
      const response = await this.server.dispatch(rpc);
      if (response === null) return; // notification — nothing to send
      if ("error" in response) {
        ws.send(
          JSON.stringify({
            type: "mcp_response",
            reqId,
            ok: false,
            error: response.error,
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "mcp_response",
            reqId,
            ok: true,
            result: response.result,
          }),
        );
      }
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "mcp_response",
          reqId,
          ok: false,
          error: { code: -32603, message: (e as Error).message },
        }),
      );
    }
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    // eslint-disable-next-line no-console
    console.log(`[pf-mcp] tunnel: reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
