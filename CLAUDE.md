# CLAUDE.md — coffeeshop-vscode

## Overview

VS Code extension that embeds Bree (CoffeeShop AI companion) as a copilot. Connects to the coffeeshop-server daemon at `10.0.100.232:3777` as the `vscode` channel.

## Architecture

- **Chat**: `@bree` chat participant in VS Code Chat panel
- **Connection**: HTTP REST for chat completions, WebSocket for push events
- **Context**: Sends active file, diagnostics, git state, terminal output to daemon
- **Cross-channel**: Uses `X-Channel-Id: vscode` header — daemon records in shared chat history
- **Auth**: Bridge token stored in VS Code SecretStorage

## Build

```bash
npm install
npm run build      # webpack production bundle
npm run watch      # development with watch
npm run package    # .vsix for distribution
```

## Debug

Open in VS Code, press F5 to launch Extension Development Host.

## Key Files

| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point — activate/deactivate |
| `src/client/http-client.ts` | REST client for daemon API |
| `src/client/ws-client.ts` | WebSocket client for bridge protocol |
| `src/chat/chat-participant.ts` | `@bree` chat participant handler |
| `src/context/context-builder.ts` | Workspace context assembly |

## Server Dependency

Requires coffeeshop-server with `vscode` in the `ChannelId` type union. Two-line change:
- `src/memory/chat-history.ts` — add `'vscode'` to ChannelId
- `src/routes/chat-gateway.ts` — add `'vscode'` to normalizeChannelId
