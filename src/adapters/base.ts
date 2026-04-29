// Adapter interface — common surface for all CLI adapters.
//
// Each adapter knows how to spawn its CLI for a single-shot chat. Future
// commits will add `code` (multi-turn session) and `review` (read-only
// file/diff review). v1 ships chat only.

import type { AdapterCallResult, AdapterId, ChatArgs, ProviderHealth } from "../types.js";

export interface Adapter {
  readonly id: AdapterId;
  /** Resolves the CLI binary path; returns null if not found. */
  health(): Promise<ProviderHealth>;
  /** Single-shot chat — spawn-per-call, prompt fed via stdin. */
  chat(args: ChatArgs): Promise<AdapterCallResult>;
}
