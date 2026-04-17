# CLAUDE.md — coffeeshop-vscode

## Overview

VS Code / VS Codium extension that embeds Bree (CoffeeShop AI companion) as a copilot. Connects to the coffeeshop-server daemon at `10.0.100.232:3777` as the `vscode` channel. Requests `model: "bree"` which triggers the daemon's character path — soul.md, memory, RAG vault context, and tools are all injected server-side.

**Repo**: [BarkadaBrew/coffeeshop-vscode](https://github.com/BarkadaBrew/coffeeshop-vscode)

## Architecture

```
VS Codium (Mac 10.0.100.134)
  └─ coffeeshop-vscode extension
       ├─ Webview sidebar (media/chat.js) — primary UI
       ├─ HTTP client → POST /v1/chat/completions (model=bree)
       ├─ WebSocket client → /ws (push events, bridge protocol)
       └─ @bree chat participant (VS Code only, not VS Codium)
              ↓
         coffeeshop-server daemon (10.0.100.232:3777)
           ├─ Character path: soul.md + memory + RAG + tools
           ├─ Cross-channel history (X-Channel-Id: vscode)
           └─ Shared with Telegram, Obsidian, email channels
```

### Key Design Decisions

- **External script file** (`media/chat.js`): Webview JS must be in an external file, not inline in a template literal. Inline JS regexes have backslashes eaten by template string interpolation, causing parse failures. This was the hardest bug to find (Codex identified it).
- **model: "bree"**: The extension doesn't carry persona instructions — it requests `model: "bree"` and the daemon injects soul.md, memory, personality, and tools automatically. Same mechanism as the Obsidian plugin.
- **Token fallback**: Bridge token is read from VS Code SecretStorage first, then falls back to `coffeeshop.bridgeToken` in settings.json. SecretStorage gets wiped on extension reinstalls, so settings.json is the durable store.
- **Terminal capture disabled**: `onDidWriteTerminalData` is a proposed API in VS Codium. Wrapped in try/catch to degrade gracefully.
- **WS Accept validation skipped**: The daemon uses a non-standard WebSocket GUID in its accept key computation. The client skips `Sec-WebSocket-Accept` validation since it's a trusted LAN connection.

## Compatibility

| Editor | Status | Notes |
|--------|--------|-------|
| VS Codium | Primary target | Full webview sidebar, no competing AI |
| VS Code | Works | Both webview sidebar and @bree chat participant |
| Cursor | Works | Webview sidebar (Cursor's AI is separate) |

## Build & Deploy

```bash
# On the server (10.0.100.232)
cd ~/Projects/coffeeshop-vscode
npm install
npm run build
npx @vscode/vsce package --allow-missing-repository

# Deploy to Mac
scp coffeeshop-vscode-*.vsix toddwalderman@10.0.100.134:/tmp/
ssh toddwalderman@10.0.100.134 'export PATH="/opt/homebrew/bin:$PATH" && codium --install-extension /tmp/coffeeshop-vscode-*.vsix --force'
```

### Development cycle

1. Edit source on server at `~/Projects/coffeeshop-vscode`
2. `npm run build` → webpack bundles to `dist/extension.js`
3. `npx @vscode/vsce package --allow-missing-repository` → creates `.vsix`
4. `scp` to Mac, `codium --install-extension` to install
5. Reload VS Codium window to activate

## Key Files

| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point — activate/deactivate, auto-connect |
| `src/ui/webview-panel.ts` | Webview sidebar provider (HTML/CSS only — JS is external) |
| `media/chat.js` | Webview JavaScript — chat UI, markdown renderer, slash commands |
| `src/chat/message-builder.ts` | Shared message construction (context + slash commands) |
| `src/chat/chat-participant.ts` | `@bree` chat participant (VS Code only) |
| `src/client/http-client.ts` | REST client for daemon API with timeouts |
| `src/client/ws-client.ts` | WebSocket client for bridge protocol |
| `src/client/connection-manager.ts` | Connection lifecycle, health watchdog, auto-reconnect |
| `src/context/context-builder.ts` | Workspace context assembly |
| `src/context/workspace-context.ts` | Active file, open tabs, cursor position |
| `src/context/diagnostics-context.ts` | VS Code errors/warnings |
| `src/context/git-context.ts` | Branch, modified files, recent commits |
| `src/context/terminal-context.ts` | Terminal output capture with secret redaction |
| `src/config.ts` | Settings reader, bridge token management |
| `src/ui/status-bar.ts` | Connection status in status bar |

## Configuration

VS Codium settings (`Cmd+Shift+P` → Preferences: Open Settings):

| Setting | Default | Description |
|---------|---------|-------------|
| `coffeeshop.serverUrl` | `http://10.0.100.232:3777` | Daemon URL |
| `coffeeshop.bridgeToken` | `""` | Bridge auth token (durable fallback for SecretStorage) |
| `coffeeshop.autoConnect` | `true` | Connect on startup |
| `coffeeshop.contextBudget` | `5000` | Max tokens of workspace context per message |
| `coffeeshop.confirmTerminalCommands` | `true` | Prompt before running terminal commands |

## Connection & Reconnect

- Auto-connects on startup when `autoConnect` is true
- Health check every 30 seconds
- On connection drop: auto-reconnect with backoff (1s → 2s → 5s → 10s → 30s max)
- On send while disconnected: auto-reconnect attempt before showing error
- Status bar shows connection state (connected/disconnected/reconnecting)
- Webview badge mirrors connection state

## Headers Sent to Daemon

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Channel-Id` | `vscode` | Channel identification for cross-channel history |
| `X-Client-Name` | `coffeeshop-vscode` | Client identification |
| `X-History-Mode` | `server` | Daemon manages conversation history |
| `X-Bree-Chat-Mode` | `tools` | Enable tool use |
| `Authorization` | `Bearer <token>` | Bridge token auth |

## Security

- Bridge token stored in VS Code SecretStorage (encrypted) with settings.json fallback
- Terminal output redacted for secrets (JWT, API keys, AWS keys, GitHub PATs) before sending
- Terminal command execution has allowlist — non-allowlisted commands require modal confirmation
- CSP: `script-src 'nonce-...'` + webview cspSource (no `unsafe-inline`)
- Markdown links validated to http/https only (blocks javascript:, data: protocols)
- User messages rendered via textContent (no innerHTML XSS)

## Server-Side Requirements

Three changes in coffeeshop-server:

1. **`src/memory/chat-history.ts`** — Add `'vscode'` to ChannelId type union
2. **`src/routes/chat-gateway.ts`** — Add `'vscode'` to `normalizeChannelId()` function
3. **`src/memory/memory-bus.ts:78`** — Fix missing `await` on `searchAndFormatWithCitations()` (affects all channels, not just VS Code — causes `get_memory_context` to return nulls)

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Cmd+Shift+Alt+B` | Ask Bree (opens chat) |
| `Cmd+Shift+Alt+E` | Explain selection |
| `Cmd+Shift+Alt+F` | Fix errors |

## Slash Commands

Type in the chat input — autocomplete menu appears:

| Command | Description |
|---------|-------------|
| `/explain` | Explain selected code |
| `/fix` | Fix errors in current file |
| `/test` | Generate tests |
| `/commit` | Suggest commit message from git diff |
| `/review` | Review code for bugs/security/performance |

## Mac Environment

- SSH: `toddwalderman@10.0.100.134` (not `todd@`)
- PATH needs: `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"`
- VS Codium: `/Applications/VSCodium.app`, CLI at `/opt/homebrew/bin/codium`
- Node: v25.8.1, npm: 11.11.0
- Settings: `~/Library/Application Support/VSCodium/User/settings.json`
- Extension installed at: `~/.vscode-oss/extensions/barkadabrew.coffeeshop-vscode-*/`

## Known Issues

- Terminal capture (`onDidWriteTerminalData`) is a proposed API in VS Codium — silently disabled, terminal context not available
- WebSocket uses `Authorization: Bearer` header for auth (daemon's `extractBridgeTokenFromRequest` supports this)
- Daemon's WS server uses non-standard WebSocket GUID — client skips accept validation

## Installed Extensions (VS Codium)

Curated for Bree + coding workflow:
- **AI**: coffeeshop-vscode (Bree)
- **Languages**: TypeScript, Python, Go, YAML, Markdown, Jupyter
- **DX**: ESLint, Prettier, ErrorLens, Pretty TS Errors, GitLens, Docker, indent-rainbow, bookmarks, TODO tree, snippets
- **Theme**: Gruvbox Dark Hard + Material icons
- **Remote**: Open Remote SSH

Removed: Cline, Continue (competing AI), Foam (use Obsidian), emoji, extra themes, meta-packs
