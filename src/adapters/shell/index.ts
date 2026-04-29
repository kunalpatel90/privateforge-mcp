// ShellAdapter — pf.shell.exec.
//
// Runs a command on the user's machine under their own account. The
// allowlist is intentionally tight; the adapter rejects anything not on it
// unless SHELL_EXEC_ALLOW_ALL=1.

import { runCli, buildSanitizedEnv, which } from "../../run-cli.js";

const DEFAULT_ALLOWED_BINARIES = new Set([
  "git",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "pip",
  "pip3",
  "make",
  "cargo",
  "rustc",
  "go",
  "java",
  "mvn",
  "gradle",
  "ls",
  "cat",
  "echo",
  "grep",
  "find",
  "rg",
  "fd",
]);

export class ShellAdapter {
  async exec(args: {
    binary: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    stdin?: string;
  }): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    if (!args.binary) throw new Error("pf.shell.exec: binary required");
    if (process.env.SHELL_EXEC_ALLOW_ALL !== "1" && !DEFAULT_ALLOWED_BINARIES.has(args.binary)) {
      throw new Error(
        `pf.shell.exec: '${args.binary}' not in allowlist. Set SHELL_EXEC_ALLOW_ALL=1 to override.`,
      );
    }
    const resolved = await which(args.binary);
    if (!resolved) throw new Error(`pf.shell.exec: '${args.binary}' not on PATH`);

    const r = await runCli({
      binary: resolved,
      args: args.args ?? [],
      stdin: args.stdin,
      env: buildSanitizedEnv([]),
      cwd: args.cwd,
      idleTimeoutMs: args.timeoutMs ?? 60_000,
    });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    };
  }
}
