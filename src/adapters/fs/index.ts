// FsAdapter — pf.fs.{read,write,glob,grep}.
//
// Direct-OS implementation, no CLI shells. We deliberately don't sandbox
// with a chroot because the user is already running pf-mcp under their own
// account: file access is governed by OS permissions, not by us.
//
// Soft safety: refuse paths that look obviously dangerous (writing into
// /etc, /System, /usr) unless DANGEROUS_PATHS_ALLOWED=1 is set.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

const DANGEROUS_PREFIXES = [
  "/etc/",
  "/System/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/private/",
  "C:\\Windows\\",
  "C:\\Program Files\\",
];

function checkSafePath(path: string): void {
  if (process.env.DANGEROUS_PATHS_ALLOWED === "1") return;
  const norm = normalize(path);
  for (const p of DANGEROUS_PREFIXES) {
    if (norm.startsWith(p)) {
      throw new Error(
        `pf.fs refusing to touch '${norm}' (system path). Set DANGEROUS_PATHS_ALLOWED=1 to override.`,
      );
    }
  }
}

export class FsAdapter {
  async read(args: { path: string; maxBytes?: number }): Promise<string> {
    if (!args.path) throw new Error("pf.fs.read: path required");
    if (!isAbsolute(args.path)) throw new Error("pf.fs.read: path must be absolute");
    checkSafePath(args.path);
    const buf = await readFile(args.path);
    const limit = args.maxBytes ?? 1024 * 1024;
    if (buf.byteLength > limit) {
      return buf.subarray(0, limit).toString("utf8") + "\n[file truncated]";
    }
    return buf.toString("utf8");
  }

  async write(args: { path: string; content: string; createDirs?: boolean }): Promise<{ bytes: number }> {
    if (!args.path) throw new Error("pf.fs.write: path required");
    if (!isAbsolute(args.path)) throw new Error("pf.fs.write: path must be absolute");
    checkSafePath(args.path);
    if (args.createDirs) await mkdir(dirname(args.path), { recursive: true });
    const buf = Buffer.from(args.content, "utf8");
    await writeFile(args.path, buf);
    return { bytes: buf.byteLength };
  }

  async glob(args: { pattern: string; cwd?: string }): Promise<string[]> {
    if (!args.pattern) throw new Error("pf.fs.glob: pattern required");
    const { glob } = await import("node:fs/promises");
    const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
    if (args.cwd) checkSafePath(cwd);
    const out: string[] = [];
    // node 22's fs.glob is async iterable.
    for await (const entry of glob(args.pattern, { cwd })) {
      out.push(entry);
      if (out.length >= 5000) break; // safety cap
    }
    return out;
  }

  async grep(args: { pattern: string; cwd: string; ignoreCase?: boolean }): Promise<
    Array<{ path: string; line: number; text: string }>
  > {
    if (!args.pattern) throw new Error("pf.fs.grep: pattern required");
    if (!args.cwd || !isAbsolute(args.cwd)) {
      throw new Error("pf.fs.grep: cwd must be an absolute path");
    }
    checkSafePath(args.cwd);
    const { glob } = await import("node:fs/promises");
    const re = new RegExp(args.pattern, args.ignoreCase ? "i" : undefined);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for await (const entry of glob("**/*", { cwd: args.cwd })) {
      if (matches.length >= 1000) break;
      const full = resolve(args.cwd, entry);
      try {
        const buf = await readFile(full);
        if (buf.byteLength > 4 * 1024 * 1024) continue; // skip huge files
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({ path: entry, line: i + 1, text: lines[i].slice(0, 400) });
            if (matches.length >= 1000) break;
          }
        }
      } catch {
        /* not a file or unreadable */
      }
    }
    return matches;
  }
}
