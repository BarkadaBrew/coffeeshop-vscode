import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConnectionManager } from '../client/connection-manager';
import { TerminalCapture } from '../context/terminal-context';
import { buildChatMessages, parseSlashCommand, SLASH_PROMPTS, DAEMON_MODEL } from '../chat/message-builder';
import type { ChatMessage } from '../types';

const log = vscode.window.createOutputChannel('CoffeeShop Chat');

export class BreeChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'coffeeshop.chatView';

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abortController?: AbortController;
  private isStreaming = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connection: ConnectionManager,
    private readonly terminal: TerminalCapture
  ) {
    connection.onStateChange((state) => {
      this.postMessage({ type: 'connectionState', state });
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    // Register message handler BEFORE setting HTML to avoid race
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      log.appendLine(`[webview] received: ${JSON.stringify(msg)}`);
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'ready':
          log.appendLine(`[webview] ready — connection state: ${this.connection.state}`);
          this.postMessage({
            type: 'connectionState',
            state: this.connection.state,
          });
          this.postMessage({
            type: 'slashCommands',
            commands: Object.keys(SLASH_PROMPTS).map((name) => ({
              name,
              description: SLASH_PROMPTS[name].split('.')[0],
            })),
          });
          for (const m of this.history) {
            this.postMessage({
              type: 'historyReplay',
              role: m.role,
              content: m.content,
            });
          }
          break;
        case 'sendMessage':
          log.appendLine(`[webview] sendMessage: "${msg.text}"`);
          if (typeof msg.text === 'string') {
            await this.handleUserMessage(msg.text);
          }
          break;
        case 'cancelStream':
          this.abortController?.abort();
          break;
        case 'clearHistory':
          this.history = [];
          this.postMessage({ type: 'historyCleared' });
          break;
      }
    });

    // Set HTML after handler is registered
    const nonce = crypto.randomBytes(16).toString('hex');
    webviewView.webview.html = this.getHtml(nonce);
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (!text.trim()) return;

    // Guard against overlapping requests
    if (this.isStreaming) return;

    if (this.connection.state !== 'connected') {
      this.postMessage({
        type: 'breeMessage',
        content: '**Not connected to CoffeeShop server.** Run `CoffeeShop: Connect to Bree` first.',
      });
      return;
    }

    const { command, prompt } = parseSlashCommand(text);

    let messages: ChatMessage[];
    try {
      messages = await buildChatMessages(this.terminal, prompt, command, this.history);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.postMessage({
        type: 'breeMessage',
        content: `**Error building context:** ${errMsg}`,
      });
      return;
    }

    // Store the expanded form in history so follow-up context is consistent
    const expandedContent = command
      ? `${SLASH_PROMPTS[command] ?? ''}\n\n${prompt || '(see context above)'}`
      : text;
    this.history.push({ role: 'user', content: expandedContent });

    this.isStreaming = true;
    this.postMessage({ type: 'streamStart' });

    this.abortController = new AbortController();
    let fullResponse = '';

    try {
      const streamGen = this.connection.client.chatStream(messages, {
        model: DAEMON_MODEL,
        signal: this.abortController.signal,
      });

      for await (const chunk of streamGen) {
        if (this.abortController.signal.aborted) break;
        fullResponse += chunk;
        this.postMessage({ type: 'streamChunk', content: chunk });
      }

      this.postMessage({ type: 'streamEnd' });

      if (fullResponse) {
        this.history.push({ role: 'assistant', content: fullResponse });
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        this.postMessage({ type: 'streamEnd' });
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      this.postMessage({
        type: 'streamChunk',
        content: `\n\n**Error:** ${errMsg}`,
      });
      this.postMessage({ type: 'streamEnd' });
    } finally {
      this.isStreaming = false;
      this.abortController = undefined;
    }
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(nonce: string): string {
    const webview = this.view!.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
    );
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}

body {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #333));
  flex-shrink: 0;
}

.header-title {
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.8;
}

.connection-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}
.connection-badge.connected {
  background: var(--vscode-testing-iconPassed, #28a745);
  color: #fff;
}
.connection-badge.disconnected {
  background: var(--vscode-testing-iconFailed, #d73a49);
  color: #fff;
}
.connection-badge.connecting,
.connection-badge.reconnecting {
  background: var(--vscode-editorWarning-foreground, #e2b93d);
  color: #000;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  scroll-behavior: smooth;
}

.message {
  margin-bottom: 12px;
  line-height: 1.5;
}

.message-header {
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
  opacity: 0.7;
}

.message.user .message-header { color: var(--vscode-textLink-foreground, #3794ff); }
.message.bree .message-header { color: var(--vscode-terminal-ansiMagenta, #c678dd); }

.message-body {
  padding: 8px 12px;
  border-radius: 6px;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.message.user .message-body {
  background: var(--vscode-input-background, #1e1e1e);
  border: 1px solid var(--vscode-input-border, #333);
}

.message.bree .message-body {
  background: var(--vscode-editor-background, #1e1e1e);
  border: 1px solid var(--vscode-panel-border, #333);
}

.typing-indicator {
  display: none;
  padding: 8px 12px;
  margin-bottom: 12px;
}

.typing-indicator.visible { display: flex; align-items: center; gap: 8px; }

.typing-dots {
  display: flex;
  gap: 4px;
}

.typing-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-foreground);
  opacity: 0.4;
  animation: typingBounce 1.4s infinite;
}
.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typingBounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

.typing-label {
  font-size: 12px;
  opacity: 0.6;
  font-style: italic;
}

.message-body h1, .message-body h2, .message-body h3,
.message-body h4, .message-body h5, .message-body h6 {
  margin: 8px 0 4px;
  color: var(--vscode-foreground);
}
.message-body h1 { font-size: 1.3em; }
.message-body h2 { font-size: 1.15em; }
.message-body h3 { font-size: 1.05em; }

.message-body p { margin: 4px 0; }

.message-body ul, .message-body ol {
  margin: 4px 0;
  padding-left: 20px;
}

.message-body li { margin: 2px 0; }

.message-body a {
  color: var(--vscode-textLink-foreground, #3794ff);
  text-decoration: none;
}
.message-body a:hover { text-decoration: underline; }

.message-body code {
  font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
  font-size: 0.9em;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
}

.message-body strong { font-weight: 600; }
.message-body em { font-style: italic; }

.code-block-wrapper {
  position: relative;
  margin: 8px 0;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border, #333);
}

.code-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 10px;
  font-size: 11px;
  background: var(--vscode-titleBar-activeBackground, rgba(255,255,255,0.04));
  border-bottom: 1px solid var(--vscode-panel-border, #333);
}

.code-block-lang {
  opacity: 0.6;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.5px;
}

.copy-btn {
  background: none;
  border: 1px solid var(--vscode-button-border, transparent);
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
  opacity: 0.7;
  display: flex;
  align-items: center;
  gap: 4px;
}
.copy-btn:hover {
  opacity: 1;
  background: var(--vscode-button-hoverBackground, rgba(255,255,255,0.1));
}

.code-block-wrapper pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
}

.code-block-wrapper pre code {
  padding: 0;
  background: none;
  font-size: 12px;
  line-height: 1.5;
}

.welcome {
  text-align: center;
  padding: 32px 20px;
  opacity: 0.6;
}
.welcome-icon { font-size: 32px; margin-bottom: 12px; }
.welcome h3 { margin-bottom: 8px; font-weight: 600; }
.welcome p { font-size: 12px; line-height: 1.6; }
.welcome .slash-hint {
  margin-top: 12px;
  font-size: 11px;
  text-align: left;
  display: inline-block;
}
.welcome .slash-hint code {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
  padding: 1px 4px;
  border-radius: 3px;
}

.input-area {
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #333));
  padding: 8px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input-row {
  display: flex;
  gap: 6px;
  align-items: flex-end;
}

#messageInput {
  flex: 1;
  resize: none;
  min-height: 36px;
  max-height: 150px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-input-border, #333);
  border-radius: 4px;
  background: var(--vscode-input-background, #1e1e1e);
  color: var(--vscode-input-foreground, var(--vscode-foreground));
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  line-height: 1.4;
  outline: none;
}

#messageInput:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}

#messageInput::placeholder {
  color: var(--vscode-input-placeholderForeground, #666);
}

.send-btn {
  padding: 8px 14px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  flex-shrink: 0;
  height: 36px;
}
.send-btn:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}

.input-hint {
  font-size: 10px;
  opacity: 0.5;
  text-align: right;
  padding-right: 4px;
}

.slash-menu {
  display: none;
  border: 1px solid var(--vscode-panel-border, #333);
  border-radius: 4px;
  background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background, #252526));
  overflow: hidden;
  margin-bottom: 4px;
}

.slash-menu.visible { display: block; }

.slash-item {
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.slash-item:hover,
.slash-item.selected {
  background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
}
.slash-item-name {
  font-weight: 600;
  color: var(--vscode-textLink-foreground, #3794ff);
}
.slash-item-desc {
  opacity: 0.6;
  font-size: 11px;
  flex: 1;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
</head>
<body>

<div class="header">
  <span class="header-title">Bree</span>
  <span id="connectionBadge" class="connection-badge disconnected">disconnected</span>
</div>

<div class="messages" id="messages">
  <div class="welcome" id="welcome">
    <div class="welcome-icon">&#9749;</div>
    <h3>Bree</h3>
    <p>Your AI coding copilot.</p>
    <div class="slash-hint">
      <p>Slash commands:</p>
      <p><code>/explain</code> &mdash; Explain code</p>
      <p><code>/fix</code> &mdash; Fix errors</p>
      <p><code>/test</code> &mdash; Generate tests</p>
      <p><code>/commit</code> &mdash; Suggest commit message</p>
      <p><code>/review</code> &mdash; Review code</p>
    </div>
  </div>
</div>

<div class="typing-indicator" id="typingIndicator">
  <div class="typing-dots"><span></span><span></span><span></span></div>
  <span class="typing-label">Bree is thinking...</span>
</div>

<div class="input-area">
  <div class="slash-menu" id="slashMenu"></div>
  <div class="input-row">
    <textarea id="messageInput" rows="1" placeholder="Ask Bree..." autocomplete="off"></textarea>
    <button class="send-btn" id="sendBtn" title="Send message">Send</button>
  </div>
  <div class="input-hint">Enter to send / Shift+Enter for new line</div>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>

</body>
</html>`;
  }
}
