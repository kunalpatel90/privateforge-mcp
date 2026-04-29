# Security

## Reporting a Vulnerability

If you find a security issue in `pf-mcp`, please email **security@privateforge.ai**
instead of filing a public issue. We respond within 72 hours and aim to ship
a fix within 7 days for high-severity issues.

## What `pf-mcp` Does and Doesn't Touch

By design, `pf-mcp`:

- **Does NOT read** `~/.claude/`, `~/.codex/`, or `~/.gemini/` credential files.
- **Does NOT proxy** Anthropic / OpenAI / Google API keys or OAuth tokens.
- **Does NOT modify** any provider configuration on your machine.

The only credential `pf-mcp` handles is its own **device JWT**, used to
authenticate the outbound tunnel to PrivateForge cloud. That JWT is scoped
solely to the tunnel and is stored in the OS keychain (keytar / Keychain /
Credential Manager). It is never written to disk in plain text.

## Process Boundaries

Each CLI invocation (`claude`, `codex`, `gemini`) is spawned as a child
process under the user's own OS account. We pass an explicitly cleared
environment (see `src/adapters/<provider>/env-clear.ts`) so the CLI sees
its own credential files but not arbitrary environment variables.

## Tunnel

The cloud tunnel is **outbound only** (TLS 1.3 WebSocket on port 443). No
inbound ports. No firewall holes. The user's machine initiates the
connection and holds it open.

## Audit

`pf-mcp` is MIT-licensed and runnable from source. You can verify all of
the above by reading the code in `src/adapters/` and `src/tunnel/`.
