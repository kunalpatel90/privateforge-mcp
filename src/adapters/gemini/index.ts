// GeminiAdapter — wraps the `gemini` CLI for pf.gemini.chat.
//
// Non-interactive invocation:
//
//   gemini --prompt '<prompt>'   (or stdin)
//
// The Gemini CLI reads from ~/.gemini/ for OAuth state. As with Claude/Codex,
// we don't touch those files.
//
// Health check note: the `gemini --prompt ping` probe is a real LLM call and
// can take 10–20s on first cold start, which exceeds any sane health-check
// budget. We instead inspect ~/.gemini/oauth_creds.json (or the env API key)
// to decide `authed`. The actual chat path still validates auth on first call.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

    // Auth detection — file-based, not LLM-based. Two valid auth shapes:
    //   1. Env API key (GEMINI_API_KEY / GOOGLE_API_KEY) — instant authed.
    //   2. OAuth credentials cached at ~/.gemini/oauth_creds.json.
    // The Gemini CLI also accepts a custom config dir via GEMINI_CONFIG_DIR.
    let authed = false;
    let hint: string | undefined;
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      authed = true;
    } else {
      const configDir = process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), ".gemini");
      const candidates = [
        path.join(configDir, "oauth_creds.json"),
        // Newer CLI builds may use these; check defensively so a future rename
        // doesn't silently regress us back to the slow probe.
        path.join(configDir, "credentials.json"),
        path.join(configDir, "auth.json"),
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
        hint = `no credentials in ${configDir} and no GEMINI_API_KEY/GOOGLE_API_KEY env. Run: gemini auth`;
      }
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
