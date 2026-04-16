import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connection-manager';
import { TerminalCapture } from '../context/terminal-context';
import { buildChatMessages, parseSlashCommand, SLASH_PROMPTS } from '../chat/message-builder';
import type { ChatMessage, ConnectionState } from '../types';

export class BreeChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'coffeeshop.chatView';

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abortController?: AbortController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connection: ConnectionManager,
    private readonly terminal: TerminalCapture
  ) {
    // Forward connection state changes to the webview
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
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    // Send initial connection state
    this.postMessage({
      type: 'connectionState',
      state: this.connection.state,
    });

    // Send available slash commands
    this.postMessage({
      type: 'slashCommands',
      commands: Object.keys(SLASH_PROMPTS).map((name) => ({
        name,
        description: SLASH_PROMPTS[name].split('.')[0],
      })),
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'sendMessage':
          await this.handleUserMessage(msg.text);
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
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (!text.trim()) return;

    if (this.connection.state !== 'connected') {
      this.postMessage({
        type: 'breeMessage',
        content: '**Not connected to CoffeeShop server.** Run `CoffeeShop: Connect to Bree` first.',
        done: true,
      });
      return;
    }

    const { command, prompt } = parseSlashCommand(text);

    // Build messages using shared logic
    let messages: ChatMessage[];
    try {
      messages = await buildChatMessages(this.terminal, prompt, command, this.history);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.postMessage({
        type: 'breeMessage',
        content: `**Error building context:** ${errMsg}`,
        done: true,
      });
      return;
    }

    // Add user message to local history
    this.history.push({ role: 'user', content: text });

    // Signal the webview to show typing indicator
    this.postMessage({ type: 'streamStart' });

    this.abortController = new AbortController();
    let fullResponse = '';

    try {
      const streamGen = this.connection.client.chatStream(messages, {
        signal: this.abortController.signal,
      });

      for await (const chunk of streamGen) {
        if (this.abortController.signal.aborted) break;
        fullResponse += chunk;
        this.postMessage({ type: 'streamChunk', content: chunk });
      }

      // Stream complete
      this.postMessage({ type: 'streamEnd' });

      // Save assistant response to history
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
      this.abortController = undefined;
    }
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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

/* Header */
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

/* Messages area */
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

/* Typing indicator */
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

/* Markdown rendering */
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

/* Code blocks */
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

/* Welcome */
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

/* Input area */
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
.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.input-hint {
  font-size: 10px;
  opacity: 0.5;
  text-align: right;
  padding-right: 4px;
}

/* Slash command autocomplete */
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

<script>
(function() {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const welcomeEl = document.getElementById('welcome');
  const inputEl = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const typingEl = document.getElementById('typingIndicator');
  const badgeEl = document.getElementById('connectionBadge');
  const slashMenuEl = document.getElementById('slashMenu');

  let slashCommands = [];
  let slashMenuIndex = -1;
  let isStreaming = false;
  let currentBreeBody = null;
  let currentBreeContent = '';

  // --- Markdown rendering ---

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMarkdown(text) {
    // Split into code blocks and non-code-block segments
    const parts = [];
    let remaining = text;
    const codeBlockRe = /\`\`\`(\w*)\n([\s\S]*?)(\`\`\`|$)/g;
    let match;
    let lastIndex = 0;

    // Reset regex
    codeBlockRe.lastIndex = 0;
    while ((match = codeBlockRe.exec(remaining)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: remaining.slice(lastIndex, match.index) });
      }
      parts.push({ type: 'code', lang: match[1] || '', content: match[2] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < remaining.length) {
      parts.push({ type: 'text', content: remaining.slice(lastIndex) });
    }

    return parts.map(part => {
      if (part.type === 'code') {
        return renderCodeBlock(part.lang, part.content);
      }
      return renderInlineMarkdown(part.content);
    }).join('');
  }

  function renderCodeBlock(lang, code) {
    const id = 'cb-' + Math.random().toString(36).slice(2, 9);
    const trimmed = code.replace(/\n$/, '');
    return '<div class="code-block-wrapper">' +
      '<div class="code-block-header">' +
        '<span class="code-block-lang">' + escapeHtml(lang || 'code') + '</span>' +
        '<button class="copy-btn" data-code-id="' + id + '" onclick="copyCode(this)" title="Copy code">Copy</button>' +
      '</div>' +
      '<pre><code id="' + id + '">' + escapeHtml(trimmed) + '</code></pre>' +
    '</div>';
  }

  function renderInlineMarkdown(text) {
    let html = escapeHtml(text);

    // Headers (must be at line start)
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" title="$2">$1</a>');

    // Unordered lists
    html = html.replace(/^(\s*)[*-]\s+(.+)$/gm, function(_match, indent, item) {
      return '<li>' + item + '</li>';
    });
    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Ordered lists
    html = html.replace(/^(\s*)\d+\.\s+(.+)$/gm, '<li>$2</li>');

    // Line breaks — double newline becomes paragraph, single becomes <br>
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph if not already block-level
    if (html && !html.startsWith('<h') && !html.startsWith('<ul') && !html.startsWith('<ol')) {
      html = '<p>' + html + '</p>';
    }

    // Clean up empty paragraphs
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p><br><\/p>/g, '');

    return html;
  }

  // --- Copy code ---
  window.copyCode = function(btn) {
    const codeId = btn.getAttribute('data-code-id');
    const codeEl = document.getElementById(codeId);
    if (!codeEl) return;

    const text = codeEl.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }).catch(() => {
      // Fallback: select text
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };

  // --- Scroll management ---
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  }

  // --- Add messages ---
  function addUserMessage(text) {
    welcomeEl.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'message user';
    div.innerHTML =
      '<div class="message-header">You</div>' +
      '<div class="message-body">' + escapeHtml(text) + '</div>';
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function startBreeMessage() {
    const div = document.createElement('div');
    div.className = 'message bree';
    div.innerHTML =
      '<div class="message-header">Bree</div>' +
      '<div class="message-body"></div>';
    messagesEl.appendChild(div);
    currentBreeBody = div.querySelector('.message-body');
    currentBreeContent = '';
    scrollToBottom();
  }

  function appendToCurrentBree(chunk) {
    if (!currentBreeBody) return;
    currentBreeContent += chunk;
    const shouldScroll = isNearBottom();
    currentBreeBody.innerHTML = renderMarkdown(currentBreeContent);
    if (shouldScroll) scrollToBottom();
  }

  function finishBreeMessage() {
    if (currentBreeBody && currentBreeContent) {
      currentBreeBody.innerHTML = renderMarkdown(currentBreeContent);
    }
    currentBreeBody = null;
    currentBreeContent = '';
    scrollToBottom();
  }

  // --- Slash command menu ---
  function updateSlashMenu(text) {
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\\n')) {
      slashMenuEl.classList.remove('visible');
      slashMenuIndex = -1;
      return;
    }

    const query = text.slice(1).toLowerCase();
    const matches = slashCommands.filter(c => c.name.startsWith(query));

    if (matches.length === 0) {
      slashMenuEl.classList.remove('visible');
      slashMenuIndex = -1;
      return;
    }

    slashMenuEl.innerHTML = matches.map((cmd, i) =>
      '<div class="slash-item' + (i === slashMenuIndex ? ' selected' : '') +
      '" data-name="' + cmd.name + '">' +
        '<span class="slash-item-name">/' + cmd.name + '</span>' +
        '<span class="slash-item-desc">' + escapeHtml(cmd.description) + '</span>' +
      '</div>'
    ).join('');

    slashMenuEl.classList.add('visible');

    // Click handlers
    slashMenuEl.querySelectorAll('.slash-item').forEach(item => {
      item.addEventListener('click', () => {
        inputEl.value = '/' + item.getAttribute('data-name') + ' ';
        slashMenuEl.classList.remove('visible');
        inputEl.focus();
      });
    });
  }

  // --- Input handling ---
  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;

    addUserMessage(text);
    inputEl.value = '';
    autoResize();
    slashMenuEl.classList.remove('visible');

    vscode.postMessage({ type: 'sendMessage', text: text });
  }

  inputEl.addEventListener('input', () => {
    autoResize();
    updateSlashMenu(inputEl.value);
  });

  inputEl.addEventListener('keydown', (e) => {
    // Slash menu navigation
    if (slashMenuEl.classList.contains('visible')) {
      const items = slashMenuEl.querySelectorAll('.slash-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuIndex = Math.min(slashMenuIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === slashMenuIndex));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
        items.forEach((el, i) => el.classList.toggle('selected', i === slashMenuIndex));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && slashMenuIndex >= 0)) {
        e.preventDefault();
        const selected = items[Math.max(slashMenuIndex, 0)];
        if (selected) {
          inputEl.value = '/' + selected.getAttribute('data-name') + ' ';
          slashMenuEl.classList.remove('visible');
          slashMenuIndex = -1;
        }
        return;
      }
      if (e.key === 'Escape') {
        slashMenuEl.classList.remove('visible');
        slashMenuIndex = -1;
        return;
      }
    }

    // Send on Enter, newline on Shift+Enter
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // --- Message handling from extension ---
  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'connectionState':
        badgeEl.textContent = msg.state;
        badgeEl.className = 'connection-badge ' + msg.state;
        break;

      case 'slashCommands':
        slashCommands = msg.commands;
        break;

      case 'streamStart':
        isStreaming = true;
        sendBtn.disabled = true;
        sendBtn.textContent = 'Stop';
        sendBtn.onclick = () => {
          vscode.postMessage({ type: 'cancelStream' });
        };
        typingEl.classList.add('visible');
        startBreeMessage();
        break;

      case 'streamChunk':
        typingEl.classList.remove('visible');
        appendToCurrentBree(msg.content);
        break;

      case 'streamEnd':
        isStreaming = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.onclick = sendMessage;
        typingEl.classList.remove('visible');
        finishBreeMessage();
        break;

      case 'breeMessage':
        // Non-streamed message (e.g., error)
        welcomeEl.style.display = 'none';
        startBreeMessage();
        appendToCurrentBree(msg.content);
        finishBreeMessage();
        break;

      case 'historyCleared':
        messagesEl.innerHTML = '';
        messagesEl.appendChild(welcomeEl);
        welcomeEl.style.display = '';
        break;
    }
  });

  // Focus input on load
  inputEl.focus();
})();
</script>

</body>
</html>`;
  }
}
