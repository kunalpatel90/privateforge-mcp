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
// on a cold start. We now detect auth via env API key OR the macOS Keychain
// OR the presence of non-empty credential files in ~/.claude/ (or
// CLAUDE_CONFIG_DIR). The chat path itself still validates auth on first call.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Adapter } from "../base.js";
import type { AdapterCallResult, ChatArgs, ProviderHealth } from "../../types.js";
import { runCli, buildSanitizedEnv, which } from "../../run-cli.js";

const CLAUDE_ENV_KEEP = [
  // Anthropic CLI honors these; we keep them so users who set them in their
  // shell rc still work. We do NOT inject any from our own process.
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

/** Result of the auth detection probe. Pure data, easy to test. */
export interface AuthProbeResult {
  authed: boolean;
  hint?: string;
}

/** Injectable dependencies for `detectAuth` so tests don't shell out or hit disk. */
export interface AuthProbeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  /** Resolves true iff `file` exists, is a regular file, and is non-empty. */
  fileExistsNonEmpty: (file: string) => Promise<boolean>;
  /** Resolves true iff the macOS Keychain has a "Claude Code-credentials" entry. */
  keychainHasClaudeEntry: () => Promise<boolean>;
}

/**
 * Detect whether Claude Code is authenticated, in the order specified:
 *   1. ANTHROPIC_AUTH_TOKEN env
 *   2. ANTHROPIC_API_KEY env
 *   3. CLAUDE_CODE_OAUTH_TOKEN env
 *   4. macOS Keychain entry (darwin only)
 *   5. credential files in ~/.claude/ (or CLAUDE_CONFIG_DIR)
 */
export async function detectAuth(deps: AuthProbeDeps): Promise<AuthProbeResult> {
  if (deps.env.ANTHROPIC_AUTH_TOKEN) return { authed: true };
  if (deps.env.ANTHROPIC_API_KEY) return { authed: true };
  if (deps.env.CLAUDE_CODE_OAUTH_TOKEN) return { authed: true };

  if (deps.platform === "darwin") {
    try {
      if (await deps.keychainHasClaudeEntry()) return { authed: true };
    } catch {
      /* fall through to file-based check */
    }
  }

  const configDir = deps.env.CLAUDE_CONFIG_DIR || path.join(deps.homedir(), ".claude");
  const candidates = [
    path.join(configDir, ".credentials.json"),
    path.join(configDir, "credentials.json"),
    path.join(configDir, "auth.json"),
    path.join(configDir, "oauth.json"),
  ];
  for (const file of candidates) {
    if (await deps.fileExistsNonEmpty(file)) return { authed: true };
  }

  const hint =
    deps.platform === "darwin"
      ? "no Claude Code credentials in macOS Keychain (Keychain Access > 'Claude Code') and no env auth. Run: claude /login"
      : `no credentials in ${configDir} and no ANTHROPIC_AUTH_TOKEN env. Run: claude login`;
  return { authed: false, hint };
}

async function defaultFileExistsNonEmpty(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Probe the macOS Keychain for the Claude Code credentials entry. Uses
 * `security find-generic-password` without `-w` so the secret is never
 * printed. Exit code 0 means the entry exists. Short timeout because the
 * `security` binary is local and instant.
 */
function defaultKeychainHasClaudeEntry(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const account = process.env.USER || process.env.LOGNAME || "";
    const args = ["find-generic-password", "-s", "Claude Code-credentials"];
    if (account) args.push("-a", account);
    let child;
    try {
      child = spawn("/usr/bin/security", args, {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 3_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

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

    const { authed, hint } = await detectAuth({
      platform: process.platform,
      env: process.env,
      homedir: os.homedir,
      fileExistsNonEmpty: defaultFileExistsNonEmpty,
      keychainHasClaudeEntry: defaultKeychainHasClaudeEntry,
    });

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
