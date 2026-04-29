# pf-mcp — PrivateForge local MCP server

A small, hand-rolled [Model Context Protocol](https://modelcontextprotocol.io/) server that wraps the **Claude**, **Codex**, and **Gemini** CLIs you already have installed and exposes them under a stable `pf.*` tool namespace.

It's the local-side companion to [PrivateForge Cloud](https://privateforge.ai), but it works **standalone** with any MCP client (Claude Desktop, Cursor, custom scripts) — no PrivateForge account required.

## Why

Vendor CLIs change their flags, output format, and auth flows constantly. `pf-mcp` pins them behind a stable tool surface so cloud orchestrators and other MCP clients don't have to care.

It also enforces a strict legal posture: **pf-mcp never reads or proxies your AI provider credentials.** Each wrapped CLI authenticates itself against its own config dir. We just spawn it and capture stdout. Your subscription pays for inference; nothing leaves your machine except the prompt and response.

## Install

```bash
npm install -g @privateforge/mcp
```

You also need at least one of these CLIs installed and signed in:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `claude --print`
- [Codex CLI](https://github.com/openai/codex) — `codex exec --skip-git-repo-check`
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini --prompt`

## Run

### Standalone (local MCP only)

```bash
pf-mcp
# [pf-mcp] local MCP endpoint listening on http://127.0.0.1:7820/mcp
# [pf-mcp] tunnel disabled (set PF_GATEWAY_URL and PF_TOKEN to enable cloud mode)
```

Point any MCP client at `http://127.0.0.1:7820/mcp`. Tools available:

| Tool | Description |
|---|---|
| `pf.claude.chat` | Single-shot chat via the `claude` CLI |
| `pf.codex.chat` | Single-shot chat via the `codex` CLI |
| `pf.gemini.chat` | Single-shot chat via the `gemini` CLI |
| `pf.fs.read` | Read a file (absolute path; refuses system paths) |
| `pf.fs.write` | Write a file (absolute path) |
| `pf.fs.glob` | Glob files |
| `pf.fs.grep` | Regex grep across a directory |
| `pf.shell.exec` | Run a binary (allowlisted by default) |
| `pf.health.providers` | Snapshot of CLI install/auth status |
| `pf.diag.envinfo` | Runner host diagnostics |

### As a Claude Code plugin

Clone this repo somewhere stable, then point Claude Code at it:

```bash
git clone https://github.com/kunalpatel90/privateforge-mcp.git ~/.claude/plugins/pf-mcp
```

The `.mcp.json` and `.claude-plugin/plugin.json` are wired so Claude Code's plugin loader spawns `pf-mcp` over stdio (`node dist/index.js --stdio`). On first run the `start:plugin` script installs deps and builds. From a Claude Code session:

```
/plugin install pf-mcp
/reload-plugins
```

Claude can now call `pf.codex.chat`, `pf.gemini.chat`, etc. — useful for cross-model orchestration without leaving Claude Code.

### Cloud mode (PrivateForge tunnel)

Set two env vars to enable the outbound WSS tunnel:

```bash
PF_GATEWAY_URL=wss://api.privateforge.ai \
PF_TOKEN=<desktop session token> \
pf-mcp
```

The cloud orchestrator can now route `pf.*` tool calls to your machine.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PF_MCP_HOST` | `127.0.0.1` | Local HTTP bind address |
| `PF_MCP_PORT` | `7820` | Local HTTP port |
| `PF_GATEWAY_URL` | — | When set with `PF_TOKEN`, opens a tunnel to PrivateForge cloud |
| `PF_TOKEN` | — | Bearer token for the tunnel |
| `PF_MACHINE_ID` | — | Optional stable identifier for socket dedup |
| `PF_AUTH_HEADER` | — | Optional `X-PF-Auth` HMAC header value |
| `DANGEROUS_PATHS_ALLOWED` | `0` | Set `1` to relax the system-path guard in `pf.fs.*` |
| `SHELL_EXEC_ALLOW_ALL` | `0` | Set `1` to disable the `pf.shell.exec` allowlist |
| `DEBUG` | `0` | Verbose logging |

## Security model

- pf-mcp is a **local process under your user account** — same trust boundary as the CLIs it wraps.
- It listens on **loopback only** (`127.0.0.1`) by default. Don't bind it to `0.0.0.0` unless you understand the consequences.
- It does **not** read or transmit credentials from `~/.config/claude`, `~/.codex`, or any vendor config dir.
- `pf.fs.*` refuses absolute paths under `/etc`, `/System`, `~/.ssh`, etc. (override with `DANGEROUS_PATHS_ALLOWED=1`).
- `pf.shell.exec` allowlists common dev binaries by default (override with `SHELL_EXEC_ALLOW_ALL=1`).
- See [`SECURITY.md`](./SECURITY.md) for vulnerability reporting.

## Build from source

```bash
git clone https://github.com/kunalpatel90/privateforge-mcp.git
cd privateforge-mcp
npm install
npm run build
node dist/index.js
```

## License

MIT — see [`LICENSE`](./LICENSE).
