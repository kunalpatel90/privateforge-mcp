// Shared types for the pf-mcp server.

/** Result of a single CLI invocation. */
export interface AdapterCallResult {
  text: string;
  exitCode: number;
  durationMs: number;
  /** Included only when DEBUG=1. Useful for adapter test scripts. */
  rawStdout?: string;
  rawStderr?: string;
}

export type AdapterId =
  | "claude"
  | "codex"
  | "gemini"
  | "fs"
  | "shell"
  | "session"
  | "health"
  | "diag";

export interface ChatArgs {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  /** Idle timeout. Streaming chunks reset the timer. Defaults to 30_000. */
  timeoutMs?: number;
}

export interface ProviderHealth {
  installed: boolean;
  authed: boolean;
  version: string | null;
  binary: string | null;
  /** When `installed=false` or `authed=false`, a short hint for the user. */
  hint?: string;
}

/** MCP content part. We only emit `text` parts in v1. */
export interface McpContentPart {
  type: "text";
  text: string;
}

/** MCP tools/call response. */
export interface McpCallToolResult {
  content: McpContentPart[];
  isError?: boolean;
}

/** MCP tool descriptor used in tools/list. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A registered tool — descriptor + handler. */
export interface McpTool {
  descriptor: McpToolDescriptor;
  handler: (args: Record<string, unknown>) => Promise<McpCallToolResult>;
}

/** Provider-cli identity, surfaced via pf.health.providers. */
export type ProviderKey = "claude" | "codex" | "gemini";
