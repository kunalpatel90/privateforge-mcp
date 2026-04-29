// GeminiAdapter — wraps the `gemini` CLI for pf.gemini.chat.
//
// Non-interactive invocation:
//
//   gemini --prompt '<prompt>'   (or stdin)
//
// The Gemini CLI reads from ~/.gemini/ for OAuth state. As with Claude/Codex,
// we don't touch those files.

import type { Adapter } from "../base.js";
import type { AdapterCallResult, ChatArgs, ProviderHealth } from "../../types.js";
import { runCli, buildSanitizedEnv, which } from "../../run-cli.js";

const GEMINI_ENV_KEEP = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_CONFIG_DIR",
];

export class GeminiAdapter implements Adapter {
  readonly id = "gemini" as const;

  async health(): Promise<ProviderHealth> {
    const binary = await which("gemini");
    if (!binary) {
      return {
        installed: false,
        authed: false,
        version: null,
        binary: null,
        hint: "gemini CLI not found on PATH. Install with: npm install -g @google/generative-ai-cli",
      };
    }
    let version: string | null = null;
    try {
      const r = await runCli({
        binary,
        args: ["--version"],
        env: buildSanitizedEnv(GEMINI_ENV_KEEP),
        idleTimeoutMs: 5_000,
      });
      if (r.exitCode === 0) {
        version = (r.stdout.trim() || r.stderr.trim()).split(/\s+/).pop() ?? null;
      }
    } catch {
      /* ignore */
    }

    let authed = false;
    let hint: string | undefined;
    try {
      const probe = await runCli({
        binary,
        args: ["--prompt", "ping"],
        env: buildSanitizedEnv(GEMINI_ENV_KEEP),
        idleTimeoutMs: 8_000,
      });
      authed = probe.exitCode === 0;
      if (!authed) hint = (probe.stderr || probe.stdout).slice(0, 200) || "gemini CLI returned non-zero exit";
    } catch (e) {
      hint = (e as Error).message?.slice(0, 200);
    }

    return { installed: true, authed, version, binary, hint };
  }

  async chat(args: ChatArgs): Promise<AdapterCallResult> {
    const binary = await which("gemini");
    if (!binary) throw new Error("gemini CLI not found on PATH");

    const fullPrompt = args.systemPrompt
      ? `${args.systemPrompt}\n\n---\n\n${args.prompt}`
      : args.prompt;

    const cliArgs: string[] = ["--prompt", fullPrompt];
    if (args.model) cliArgs.push("--model", args.model);

    const r = await runCli({
      binary,
      args: cliArgs,
      env: buildSanitizedEnv(GEMINI_ENV_KEEP),
      cwd: args.cwd,
      idleTimeoutMs: args.timeoutMs ?? 30_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `gemini CLI exited ${r.exitCode}${r.timedOut ? " (idle timeout)" : ""}: ${
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
