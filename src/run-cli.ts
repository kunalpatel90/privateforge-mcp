// run-cli.ts — child process spawn helper used by all three CLI adapters.
//
// Concerns owned here:
//   - applying a sanitized env (we let each adapter decide which vars to keep)
//   - capturing stdout/stderr without unbounded growth
//   - enforcing an idle timeout (chunks reset it; total stalls do not)
//   - never writing the prompt to argv (always feed it on stdin) so it doesn't
//     show up in `ps -ef`

import { spawn, type ChildProcess } from "node:child_process";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB cap per stream

export interface RunCliOpts {
  binary: string;
  args: string[];
  /** Optional stdin payload (e.g. the prompt). */
  stdin?: string;
  /** Sanitized environment for the child. */
  env: NodeJS.ProcessEnv;
  /** cwd for the child process. */
  cwd?: string;
  /** Idle timeout in ms — reset on every stdout/stderr chunk. */
  idleTimeoutMs?: number;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** True when the child was killed for exceeding idleTimeoutMs. */
  timedOut: boolean;
}

export async function runCli(opts: RunCliOpts): Promise<RunCliResult> {
  const startedAt = Date.now();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;

  return new Promise<RunCliResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.binary, opts.args, {
        env: opts.env,
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(e);
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, idleTimeoutMs);
    };

    resetIdleTimer();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n[stdout truncated]";
        }
      }
      resetIdleTimer();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n[stderr truncated]";
        }
      }
      resetIdleTimer();
    });

    child.on("error", (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      reject(err);
    });

    child.on("close", (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Build a sanitized env that keeps a small allowlist plus the per-CLI
 * credential vars the adapter needs. Everything else is dropped — this is the
 * "OpenClaw env-clearing" pattern: we deliberately don't pass arbitrary
 * environment variables (API keys, project secrets) into the CLI child.
 */
export function buildSanitizedEnv(keep: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // Required for any CLI to function.
  const baseAllow = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "TERM", "TMPDIR"];
  for (const k of [...baseAllow, ...keep]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Resolve a CLI binary by name on PATH. Returns null if not found. */
export async function which(binary: string): Promise<string | null> {
  // Pure-Node implementation — avoids depending on `which` package.
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  const { access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const { join } = await import("node:path");
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}
