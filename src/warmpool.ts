// warmpool.ts — keep claude / codex / gemini CLIs warm.
//
// Why this exists:
//
// PrivateForge orchestration plans round-robin between providers across many
// agent steps. A typical run spends ~3 minutes on chatgpt+codex while claude
// sits idle, then suddenly needs claude again — and the claude CLI has gone
// "cold" by then. Cold = the binary's not in OS page cache, the JIT'd code is
// gone, and the OAuth refresh state may need a roundtrip. First-token latency
// jumps from <2s (warm) to 30–90s (cold), which trips upstream timeouts.
//
// The CLIs are one-shot — claude/codex/gemini all exit when their --print /
// exec / --prompt invocation finishes, so we can't keep a single long-lived
// process around the way you would with a REPL. What we *can* do is run a
// real, tiny chat call periodically. That keeps:
//
//   - the binary + its node_modules in the OS page cache (instant re-exec)
//   - the OAuth token cache in ~/.<cli>/ fresh (no mid-call refresh stalls)
//   - whatever first-call lazy init the CLI does already done
//
// Cost per warm call is one or two tokens — under subscription auth this is
// effectively free; under BYOK it's fractions of a cent per CLI per minute.
// We skip warm calls when a real call has happened recently (configurable
// staleness threshold, default 45s) so a busy fleet doesn't pay double.
//
// Design notes:
//
//   - Each adapter has its own staleness clock (`markUsed` is called from
//     the adapter's chat path on every successful real call).
//   - The pre-warm fires once at startup, all three CLIs concurrently. We
//     don't block startup on it — failures here don't matter (the CLI may
//     not be authed yet, the user may install creds in 30s, etc.).
//   - The keepalive ticker runs every PF_MCP_WARM_INTERVAL_MS (default 60s)
//     and only fires per-CLI when stale.
//   - Gracefully no-ops when the CLI isn't installed/authed — health() is
//     cheap (file-based since 5f0ff5c), so we re-check each tick.
//   - All output is on stderr to keep MCP stdio clean.

import type { Adapter } from "./adapters/base.js";

interface WarmPoolOptions {
  /** Periodic interval between keepalive sweeps, ms. */
  intervalMs?: number;
  /** A CLI is considered "stale" if its last successful call was longer ago than this. */
  staleAfterMs?: number;
  /** Hard cap on how long a single warm call may take before we abandon it. */
  warmTimeoutMs?: number;
  /** Skip the keepalive entirely (still does pre-warm). Set via PF_MCP_WARM_DISABLE=1. */
  disabled?: boolean;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 45_000;
const DEFAULT_WARM_TIMEOUT_MS = 20_000;

/** Tiny prompt that round-trips a single token. We expect any model to reply with "ok"
 * or similar; we don't validate the content — we only care that the call succeeded. */
const WARM_PROMPT = "Reply with the single word: ok";

interface AdapterEntry {
  adapter: Adapter;
  /** epoch ms of last call (real or warm) we know succeeded. 0 = never. */
  lastUsedAt: number;
  /** true while a warm call is in flight — prevents overlap if a sweep is slow. */
  warming: boolean;
}

export class WarmPool {
  private readonly entries = new Map<string, AdapterEntry>();
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly warmTimeoutMs: number;
  private readonly disabled: boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(adapters: Adapter[], opts: WarmPoolOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.warmTimeoutMs = opts.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS;
    this.disabled = opts.disabled ?? false;
    for (const adapter of adapters) {
      this.entries.set(adapter.id, {
        adapter,
        lastUsedAt: 0,
        warming: false,
      });
    }
  }

  /** Mark a CLI as just-used. Adapters call this from their chat() success path. */
  markUsed(adapterId: string): void {
    const entry = this.entries.get(adapterId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  /**
   * Fire one warm call per CLI immediately, in parallel. Doesn't await — caller
   * gets control back as soon as the calls are dispatched. Errors are logged
   * to stderr and otherwise swallowed. Safe to call before health() has ever
   * been run; we re-check installed+authed inside.
   */
  preWarm(): void {
    for (const entry of this.entries.values()) {
      void this.warmOne(entry, "prewarm");
    }
  }

  /** Begin the periodic keepalive ticker. Idempotent. */
  startTicker(): void {
    if (this.disabled) {
      process.stderr.write("[pf-mcp] warmpool: keepalive disabled by env\n");
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the event loop alive on a clean exit.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.warming) continue;
      if (now - entry.lastUsedAt < this.staleAfterMs) continue;
      void this.warmOne(entry, "tick");
    }
  }

  private async warmOne(entry: AdapterEntry, reason: "prewarm" | "tick"): Promise<void> {
    if (entry.warming) return;
    entry.warming = true;
    const startedAt = Date.now();
    try {
      // Skip if not installed / not authed. health() is file-based now (~ms).
      const h = await entry.adapter.health();
      if (!h.installed || !h.authed) {
        // Don't spam — single line per skip.
        process.stderr.write(
          `[pf-mcp] warmpool: skip ${entry.adapter.id} (${h.installed ? "unauthed" : "not-installed"}) reason=${reason}\n`,
        );
        return;
      }
      // chat() is the only public method we have; running a tiny prompt is the
      // cheapest way to keep the CLI's first-token path warm.
      await entry.adapter.chat({
        prompt: WARM_PROMPT,
        timeoutMs: this.warmTimeoutMs,
      });
      entry.lastUsedAt = Date.now();
      process.stderr.write(
        `[pf-mcp] warmpool: ${entry.adapter.id} warm-call ok (${Date.now() - startedAt}ms, ${reason})\n`,
      );
    } catch (err) {
      // A failed warm call is not fatal; we'll try again next tick.
      const msg = (err as Error).message ?? String(err);
      process.stderr.write(
        `[pf-mcp] warmpool: ${entry.adapter.id} warm-call failed (${Date.now() - startedAt}ms, ${reason}): ${msg.slice(0, 120)}\n`,
      );
    } finally {
      entry.warming = false;
    }
  }
}
