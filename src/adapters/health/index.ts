// HealthAdapter — pf.health.providers and pf.diag.envinfo.
//
// `pf.health.providers` is what the cloud reads to know which CLIs the user
// has installed and authenticated. It's also what the user's tray icon will
// surface in v2 ("Claude: ✅, Codex: ⚠️ login required").

import { ClaudeAdapter } from "../claude/index.js";
import { CodexAdapter } from "../codex/index.js";
import { GeminiAdapter } from "../gemini/index.js";
import type { ProviderHealth, ProviderKey } from "../../types.js";

export class HealthAdapter {
  constructor(
    private claude: ClaudeAdapter,
    private codex: CodexAdapter,
    private gemini: GeminiAdapter,
  ) {}

  async providers(): Promise<Record<ProviderKey, ProviderHealth>> {
    const [claude, codex, gemini] = await Promise.all([
      this.claude.health(),
      this.codex.health(),
      this.gemini.health(),
    ]);
    return { claude, codex, gemini };
  }

  envInfo(): {
    pf_mcp_version: string;
    node_version: string;
    platform: NodeJS.Platform;
    arch: string;
    home: string | undefined;
    debug: boolean;
  } {
    return {
      pf_mcp_version: "0.1.0",
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      home: process.env.HOME ?? process.env.USERPROFILE,
      debug: process.env.DEBUG === "1",
    };
  }
}
