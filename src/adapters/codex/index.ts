// CodexAdapter — wraps the OpenAI `codex` CLI for pf.codex.chat.
//
// `codex` is OpenAI's official agentic CLI (the successor to ChatGPT CLI).
// Non-interactive invocation pattern:
//
//   codex exec --skip-git-repo-check --json -p '<prompt>'
//
// We use `exec` (one-shot) and prefer reading the prompt from stdin where
// supported. If the installed codex version doesn't accept stdin, we fall
// back to passing -p inline.

import type { Adapter } from "../base.js";
import type { AdapterCallResult, ChatArgs, ProviderHealth } from "../../types.js";
import { runCli, buildSanitizedEnv, which } from "../../run-cli.js";

const CODEX_ENV_KEEP = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "CODEX_CONFIG_DIR",
];

export class CodexAdapter implements Adapter {
  readonly id = "codex" as const;

  async health(): Promise<ProviderHealth> {
    const binary = await which("codex");
    if (!binary) {
      return {
        installed: false,
        authed: false,
        version: null,
        binary: null,
        hint: "codex CLI not found on PATH. Install with: npm install -g @openai/codex",
      };
    }
    let version: string | null = null;
    try {
      const r = await runCli({
        binary,
        args: ["--version"],
        env: buildSanitizedEnv(CODEX_ENV_KEEP),
        idleTimeoutMs: 5_000,
      });
      if (r.exitCode === 0) {
        version = (r.stdout.trim() || r.stderr.trim()).split(/\s+/).pop() ?? null;
      }
    } catch {
      /* ignore */
    }

    // Auth check: run a fast `codex exec` with a no-op prompt. Codex returns
    // non-zero when not logged in.
    let authed = false;
    let hint: string | undefined;
    try {
      const probe = await runCli({
        binary,
        args: ["exec", "--skip-git-repo-check", "ping"],
        env: buildSanitizedEnv(CODEX_ENV_KEEP),
        idleTimeoutMs: 8_000,
      });
      authed = probe.exitCode === 0;
      if (!authed) hint = (probe.stderr || probe.stdout).slice(0, 200) || "codex CLI returned non-zero exit";
    } catch (e) {
      hint = (e as Error).message?.slice(0, 200);
    }

    return { installed: true, authed, version, binary, hint };
  }

  async chat(args: ChatArgs): Promise<AdapterCallResult> {
    const binary = await which("codex");
    if (!binary) throw new Error("codex CLI not found on PATH");

    // The system prompt is glued into the user prompt for codex (no first-class
    // --system flag in `codex exec` as of early 2026; revisit when one exists).
    const fullPrompt = args.systemPrompt
      ? `${args.systemPrompt}\n\n---\n\n${args.prompt}`
      : args.prompt;

    const cliArgs: string[] = ["exec", "--skip-git-repo-check"];
    if (args.model) cliArgs.push("--model", args.model);
    cliArgs.push(fullPrompt);

    const r = await runCli({
      binary,
      args: cliArgs,
      env: buildSanitizedEnv(CODEX_ENV_KEEP),
      cwd: args.cwd,
      idleTimeoutMs: args.timeoutMs ?? 30_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `codex CLI exited ${r.exitCode}${r.timedOut ? " (idle timeout)" : ""}: ${
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
