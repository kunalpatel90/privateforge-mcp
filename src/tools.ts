// tools.ts — wires every adapter into the pf.* tool surface.
//
// A v1 minimum: chat for each CLI provider, fs read/write/glob/grep, shell
// exec, health, and diag. That's enough for the cloud orchestrator to drive
// a build end-to-end. `pf.{provider}.code/review/plan` and pf.session.*
// land in the next milestone.

import { ClaudeAdapter } from "./adapters/claude/index.js";
import { CodexAdapter } from "./adapters/codex/index.js";
import { GeminiAdapter } from "./adapters/gemini/index.js";
import { FsAdapter } from "./adapters/fs/index.js";
import { ShellAdapter } from "./adapters/shell/index.js";
import { HealthAdapter } from "./adapters/health/index.js";
import { WarmPool } from "./warmpool.js";
import type { McpTool, McpCallToolResult } from "./types.js";

const claude = new ClaudeAdapter();
const codex = new CodexAdapter();
const gemini = new GeminiAdapter();
const fs = new FsAdapter();
const shell = new ShellAdapter();
const health = new HealthAdapter(claude, codex, gemini);

// Single warm-pool instance shared by all chat tools. Real chat calls call
// markUsed() so the keepalive ticker skips a CLI that's already being driven.
// Configuration via env so we don't need a redeploy to tune.
const warmPool = new WarmPool([claude, codex, gemini], {
  intervalMs: Number(process.env.PF_MCP_WARM_INTERVAL_MS) || undefined,
  staleAfterMs: Number(process.env.PF_MCP_WARM_STALE_MS) || undefined,
  warmTimeoutMs: Number(process.env.PF_MCP_WARM_TIMEOUT_MS) || undefined,
  disabled: process.env.PF_MCP_WARM_DISABLE === "1",
});

/** Exposed so index.ts can pre-warm at boot and start the keepalive ticker. */
export function getWarmPool(): WarmPool {
  return warmPool;
}

function asText(text: string): McpCallToolResult {
  return { content: [{ type: "text", text }] };
}

function asJson(value: unknown): McpCallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function asError(err: unknown): McpCallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

const chatInputSchema = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string", description: "User prompt to send to the CLI." },
    model: { type: "string", description: "Optional model override (e.g. 'claude-sonnet-4-5')." },
    systemPrompt: { type: "string", description: "Optional system prompt." },
    cwd: { type: "string", description: "Optional working directory." },
    timeoutMs: {
      type: "number",
      description: "Idle timeout in ms (resets on each output chunk). Default 30000.",
    },
  },
} as const;

export function buildTools(): McpTool[] {
  const tools: McpTool[] = [];

  // pf.claude.chat / pf.codex.chat / pf.gemini.chat
  for (const [name, adapter] of [
    ["pf.claude.chat", claude],
    ["pf.codex.chat", codex],
    ["pf.gemini.chat", gemini],
  ] as const) {
    tools.push({
      descriptor: {
        name,
        description: `Single-shot chat via the ${adapter.id} CLI. Reads ${adapter.id}'s OAuth from its own config dir; pf-mcp never touches credentials.`,
        inputSchema: chatInputSchema as unknown as Record<string, unknown>,
      },
      handler: async (raw) => {
        try {
          const r = await adapter.chat({
            prompt: String(raw.prompt ?? ""),
            model: typeof raw.model === "string" ? raw.model : undefined,
            systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : undefined,
            cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
            timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
          });
          // Mark as used so the keepalive ticker doesn't fire a redundant warm
          // call on top of an already-active CLI.
          warmPool.markUsed(adapter.id);
          return asText(r.text);
        } catch (e) {
          return asError(e);
        }
      },
    });
  }

  // pf.fs.read
  tools.push({
    descriptor: {
      name: "pf.fs.read",
      description: "Read a file from disk. Path must be absolute. Refuses system paths.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          maxBytes: { type: "number", description: "Truncation cap. Default 1 MiB." },
        },
      },
    },
    handler: async (raw) => {
      try {
        const text = await fs.read({
          path: String(raw.path ?? ""),
          maxBytes: typeof raw.maxBytes === "number" ? raw.maxBytes : undefined,
        });
        return asText(text);
      } catch (e) {
        return asError(e);
      }
    },
  });

  // pf.fs.write
  tools.push({
    descriptor: {
      name: "pf.fs.write",
      description: "Write a file. Path must be absolute. Refuses system paths.",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          createDirs: { type: "boolean", description: "mkdir -p the parent. Default false." },
        },
      },
    },
    handler: async (raw) => {
      try {
        const r = await fs.write({
          path: String(raw.path ?? ""),
          content: String(raw.content ?? ""),
          createDirs: raw.createDirs === true,
        });
        return asJson(r);
      } catch (e) {
        return asError(e);
      }
    },
  });

  // pf.fs.glob
  tools.push({
    descriptor: {
      name: "pf.fs.glob",
      description: "Glob files relative to cwd (defaults to current dir).",
      inputSchema: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "e.g. '**/*.ts'" },
          cwd: { type: "string" },
        },
      },
    },
    handler: async (raw) => {
      try {
        const r = await fs.glob({
          pattern: String(raw.pattern ?? ""),
          cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
        });
        return asJson(r);
      } catch (e) {
        return asError(e);
      }
    },
  });

  // pf.fs.grep
  tools.push({
    descriptor: {
      name: "pf.fs.grep",
      description: "Regex grep across a directory tree.",
      inputSchema: {
        type: "object",
        required: ["pattern", "cwd"],
        properties: {
          pattern: { type: "string" },
          cwd: { type: "string", description: "Absolute path." },
          ignoreCase: { type: "boolean" },
        },
      },
    },
    handler: async (raw) => {
      try {
        const r = await fs.grep({
          pattern: String(raw.pattern ?? ""),
          cwd: String(raw.cwd ?? ""),
          ignoreCase: raw.ignoreCase === true,
        });
        return asJson(r);
      } catch (e) {
        return asError(e);
      }
    },
  });

  // pf.shell.exec
  tools.push({
    descriptor: {
      name: "pf.shell.exec",
      description:
        "Execute a binary on the user's machine. Allowlisted by default (git, node, python, ...). Set SHELL_EXEC_ALLOW_ALL=1 to disable the allowlist.",
      inputSchema: {
        type: "object",
        required: ["binary"],
        properties: {
          binary: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
          stdin: { type: "string" },
        },
      },
    },
    handler: async (raw) => {
      try {
        const r = await shell.exec({
          binary: String(raw.binary ?? ""),
          args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
          cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
          timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
          stdin: typeof raw.stdin === "string" ? raw.stdin : undefined,
        });
        return asJson(r);
      } catch (e) {
        return asError(e);
      }
    },
  });

  // pf.health.providers
  tools.push({
    descriptor: {
      name: "pf.health.providers",
      description: "Snapshot of installed/authed status for all wrapped CLIs.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      try {
        const r = await health.providers();
        return asJson(r);
      } catch (e) {
        return asError(e);
      }
    },
  });

  // pf.diag.envinfo
  tools.push({
    descriptor: {
      name: "pf.diag.envinfo",
      description: "Diagnostic snapshot of the runner host (version, platform, arch).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      try {
        return asJson(health.envInfo());
      } catch (e) {
        return asError(e);
      }
    },
  });

  return tools;
}
