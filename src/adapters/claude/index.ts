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
// `claude --print` will exit non-zero with a message; we surface that as-is.

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

    // Authed-check: a no-op `claude --print` that exits quickly. We send a
    // benign prompt and a 5s idle timeout. If the CLI prompts for login, it
    // exits non-zero with "Please run claude login" or similar.
    let authed = false;
    let hint: string | undefined;
    try {
      const probe = await runCli({
        binary,
        args: ["--print", "ping"],
        stdin: "",
        env: buildSanitizedEnv(CLAUDE_ENV_KEEP),
        idleTimeoutMs: 8_000,
      });
      authed = probe.exitCode === 0;
      if (!authed) hint = (probe.stderr || probe.stdout).slice(0, 200) || "claude CLI returned non-zero exit";
    } catch (e) {
      hint = (e as Error).message?.slice(0, 200);
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
