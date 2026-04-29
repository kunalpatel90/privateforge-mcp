// ClaudeAdapter — wraps the `claude` CLI for pf.claude.chat.
//
// Behavior:
//   - calls `claude --print` (non-interactive, exits when complete)
//   - prompt is fed on stdin so it doesn't show up in `ps`
//   - env is sanitized: only the allowlist + a small set of CLAUDE_* vars
//     plus HOME (so the CLI finds ~/.claude/) make it through
//   - never reads ~/.claude/ ourselves; the CLI does
//
// Auth model: the user is expected to have already run `claude login`. If not,
// the chat path exits non-zero with a message; we surface that as-is.
//
// Health-check note (2026-04 perf fix): the previous probe ran a real
// `claude --print ping` LLM call which cost real tokens and could take 10s+
// on a cold start. We now detect auth via env API key OR the presence of
// non-empty credential files in ~/.claude/ (or CLAUDE_CONFIG_DIR). The chat
// path itself still validates auth on first call.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Adapter } from "../base.js";
import type { AdapterCallResult, ChatArgs, ProviderHealth } from "../../types.js";
import { runCli, buildSanitizedEnv, which } from "../../run-cli.js";

const CLAUDE_ENV_KEEP = [
  // Anthropic CLI honors these; we keep them so users who set them in their
  // shell rc still work. We do NOT inject any from our own process.
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
];

export class ClaudeAdapter implements Adapter {
  readonly id = "claude" as const;

  async health(): Promise<ProviderHealth> {
    const binary = await which("claude");
    if (!binary) {
      return {
        installed: false,
        authed: false,
        version: null,
        binary: null,
        hint: "claude CLI not found on PATH. Install from https://claude.ai/download",
      };
    }
    // Probe version. `claude --version` is fast and doesn't require auth.
    let version: string | null = null;
    try {
      const r = await runCli({
        binary,
        args: ["--version"],
        env: buildSanitizedEnv(CLAUDE_ENV_KEEP),
        idleTimeoutMs: 5_000,
      });
      if (r.exitCode === 0) {
        version = (r.stdout.trim() || r.stderr.trim()).split(/\s+/).pop() ?? null;
      }
    } catch {
      /* ignore — fall through with null version */
    }

    // Auth detection — file-based, not LLM-based. Two valid auth shapes:
    //   1. ANTHROPIC_AUTH_TOKEN env (instant authed).
    //   2. Credential files cached in ~/.claude/ (or CLAUDE_CONFIG_DIR).
    let authed = false;
    let hint: string | undefined;
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      authed = true;
    } else {
      const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
      const candidates = [
        path.join(configDir, ".credentials.json"),
        path.join(configDir, "credentials.json"),
        path.join(configDir, "auth.json"),
        path.join(configDir, "oauth.json"),
      ];
      for (const file of candidates) {
        try {
          const stat = await fs.stat(file);
          if (stat.isFile() && stat.size > 0) {
            authed = true;
            break;
          }
        } catch {
          /* file doesn't exist — try next */
        }
      }
      if (!authed) {
        hint = `no credentials in ${configDir} and no ANTHROPIC_AUTH_TOKEN env. Run: claude login`;
      }
    }

    return { installed: true, authed, version, binary, hint };
  }

  async chat(args: ChatArgs): Promise<AdapterCallResult> {
    const binary = await which("claude");
    if (!binary) throw new Error("claude CLI not found on PATH");

    const cliArgs: string[] = ["--print"];
    if (args.model) cliArgs.push("--model", args.model);
    if (args.systemPrompt) cliArgs.push("--system-prompt", args.systemPrompt);

    const r = await runCli({
      binary,
      args: cliArgs,
      stdin: args.prompt,
      env: buildSanitizedEnv(CLAUDE_ENV_KEEP),
      cwd: args.cwd,
      idleTimeoutMs: args.timeoutMs ?? 30_000,
    });

    if (r.exitCode !== 0) {
      throw new Error(
        `claude CLI exited ${r.exitCode}${r.timedOut ? " (idle timeout)" : ""}: ${
          r.stderr.slice(0, 400) || r.stdout.slice(0, 400)
        }`,
      );
    }
    return {
      text: r.stdout,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      rawStdout: process.env.DEBUG === "1" ? r.stdout : undefined,
      rawStderr: process.env.DEBUG === "1" ? r.stderr : undefined,
    };
  }
}
