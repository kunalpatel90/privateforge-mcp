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
//
// Health-check note (2026-04 perf fix): the previous probe ran a real
// `codex exec ping` LLM call which cost real tokens and could take 10s+ on
// a cold start. We now detect auth via env OPENAI_API_KEY OR the presence
// of non-empty credential files in ~/.codex/ (or CODEX_CONFIG_DIR). The
// chat path itself still validates auth on first call.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

    // Auth detection — file-based, not LLM-based. Two valid auth shapes:
    //   1. OPENAI_API_KEY env (instant authed).
    //   2. Credential files cached in ~/.codex/ (or CODEX_CONFIG_DIR).
    let authed = false;
    let hint: string | undefined;
    if (process.env.OPENAI_API_KEY) {
      authed = true;
    } else {
      const configDir = process.env.CODEX_CONFIG_DIR || path.join(os.homedir(), ".codex");
      const candidates = [
        path.join(configDir, "auth.json"),
        path.join(configDir, "credentials.json"),
        path.join(configDir, "oauth.json"),
        path.join(configDir, "session.json"),
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
        hint = `no credentials in ${configDir} and no OPENAI_API_KEY env. Run: codex login`;
      }
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
