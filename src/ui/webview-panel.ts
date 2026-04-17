import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConnectionManager } from '../client/connection-manager';
import { TerminalCapture } from '../context/terminal-context';
import { buildChatMessages, parseSlashCommand, SLASH_PROMPTS, DAEMON_MODEL } from '../chat/message-builder';
import type { ChatMessage } from '../types';

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
      localResourceRoots: [this.extensionUri],
    };

    const nonce = crypto.randomBytes(16).toString('hex');
    webviewView.webview.html = this.getHtml(nonce);

    // Send initial state
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

    // Replay history into the new view
    for (const msg of this.history) {
      this.postMessage({
        type: 'historyReplay',
        role: msg.role,
        content: msg.content,
      });
    }

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'sendMessage':
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
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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

<script nonce="${nonce}">
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

  // --- Sanitization ---

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Only allow http/https URLs — block javascript:, data:, etc. */
  function sanitizeUrl(url) {
    try {
      const parsed = new URL(url, 'https://placeholder.invalid');
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return escapeHtml(url);
      }
    } catch {}
    return '#';
  }

  // --- Markdown rendering ---

  function renderMarkdown(text) {
    const parts = [];
    let remaining = text;
    const codeBlockRe = /\`\`\`(\w*)\n([\s\S]*?)(\`\`\`|$)/g;
    let lastIndex = 0;

    codeBlockRe.lastIndex = 0;
    let match;
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

    return parts.map(function(part) {
      if (part.type === 'code') {
        return renderCodeBlock(part.lang, part.content);
      }
      return renderInlineMarkdown(part.content);
    }).join('');
  }

  function renderCodeBlock(lang, code) {
    var id = 'cb-' + Math.random().toString(36).slice(2, 9);
    var trimmed = code.replace(/\\n$/, '');
    return '<div class="code-block-wrapper">' +
      '<div class="code-block-header">' +
        '<span class="code-block-lang">' + escapeHtml(lang || 'code') + '</span>' +
        '<button class="copy-btn" data-code-id="' + id + '" title="Copy code">Copy</button>' +
      '</div>' +
      '<pre><code id="' + id + '">' + escapeHtml(trimmed) + '</code></pre>' +
    '</div>';
  }

  function renderInlineMarkdown(text) {
    // Process by blocks (split on double newlines)
    var blocks = text.split(/\\n\\n+/);
    var html = '';

    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b].trim();
      if (!block) continue;

      // Headers
      var headerMatch = block.match(/^(#{1,6})\\s+(.+)$/);
      if (headerMatch) {
        var level = headerMatch[1].length;
        html += '<h' + level + '>' + renderInline(headerMatch[2]) + '</h' + level + '>';
        continue;
      }

      // Unordered list
      if (/^[*-]\\s+/.test(block)) {
        var items = block.split(/\\n/).filter(function(l) { return l.trim(); });
        html += '<ul>';
        for (var i = 0; i < items.length; i++) {
          html += '<li>' + renderInline(items[i].replace(/^\\s*[*-]\\s+/, '')) + '</li>';
        }
        html += '</ul>';
        continue;
      }

      // Ordered list
      if (/^\\d+\\.\\s+/.test(block)) {
        var items = block.split(/\\n/).filter(function(l) { return l.trim(); });
        html += '<ol>';
        for (var i = 0; i < items.length; i++) {
          html += '<li>' + renderInline(items[i].replace(/^\\s*\\d+\\.\\s+/, '')) + '</li>';
        }
        html += '</ol>';
        continue;
      }

      // Paragraph
      html += '<p>' + renderInline(block).replace(/\\n/g, '<br>') + '</p>';
    }

    return html;
  }

  function renderInline(text) {
    var s = escapeHtml(text);
    // Bold + italic
    s = s.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
    // Bold
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // Inline code
    s = s.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');
    // Links — sanitize URLs
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function(_m, label, url) {
      return '<a href="' + sanitizeUrl(url) + '" title="' + escapeHtml(url) + '">' + label + '</a>';
    });
    return s;
  }

  // --- Copy code ---
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.copy-btn');
    if (!btn) return;
    var codeId = btn.getAttribute('data-code-id');
    var codeEl = document.getElementById(codeId);
    if (!codeEl) return;

    var text = codeEl.textContent || '';
    navigator.clipboard.writeText(text).then(function() {
      var original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = original; }, 2000);
    }).catch(function() {
      var range = document.createRange();
      range.selectNodeContents(codeEl);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  });

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
    var div = document.createElement('div');
    div.className = 'message user';
    var header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = 'You';
    var body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = text;
    div.appendChild(header);
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function startBreeMessage() {
    var div = document.createElement('div');
    div.className = 'message bree';
    var header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = 'Bree';
    var body = document.createElement('div');
    body.className = 'message-body';
    div.appendChild(header);
    div.appendChild(body);
    messagesEl.appendChild(div);
    currentBreeBody = body;
    currentBreeContent = '';
    scrollToBottom();
  }

  function appendToCurrentBree(chunk) {
    if (!currentBreeBody) return;
    currentBreeContent += chunk;
    var shouldScroll = isNearBottom();
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

    var query = text.slice(1).toLowerCase();
    var matches = slashCommands.filter(function(c) { return c.name.startsWith(query); });

    if (matches.length === 0) {
      slashMenuEl.classList.remove('visible');
      slashMenuIndex = -1;
      return;
    }

    slashMenuEl.innerHTML = matches.map(function(cmd, i) {
      return '<div class="slash-item' + (i === slashMenuIndex ? ' selected' : '') +
        '" data-name="' + escapeHtml(cmd.name) + '">' +
          '<span class="slash-item-name">/' + escapeHtml(cmd.name) + '</span>' +
          '<span class="slash-item-desc">' + escapeHtml(cmd.description) + '</span>' +
        '</div>';
    }).join('');

    slashMenuEl.classList.add('visible');

    slashMenuEl.querySelectorAll('.slash-item').forEach(function(item) {
      item.addEventListener('click', function() {
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

  function setStreamingMode(streaming) {
    isStreaming = streaming;
    if (streaming) {
      sendBtn.textContent = 'Stop';
      sendBtn.onclick = function() {
        vscode.postMessage({ type: 'cancelStream' });
      };
    } else {
      sendBtn.textContent = 'Send';
      sendBtn.onclick = sendMessage;
    }
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isStreaming) return;

    addUserMessage(text);
    inputEl.value = '';
    autoResize();
    slashMenuEl.classList.remove('visible');

    vscode.postMessage({ type: 'sendMessage', text: text });
  }

  inputEl.addEventListener('input', function() {
    autoResize();
    updateSlashMenu(inputEl.value);
  });

  inputEl.addEventListener('keydown', function(e) {
    if (slashMenuEl.classList.contains('visible')) {
      var items = slashMenuEl.querySelectorAll('.slash-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuIndex = Math.min(slashMenuIndex + 1, items.length - 1);
        items.forEach(function(el, i) { el.classList.toggle('selected', i === slashMenuIndex); });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
        items.forEach(function(el, i) { el.classList.toggle('selected', i === slashMenuIndex); });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && slashMenuIndex >= 0)) {
        e.preventDefault();
        var selected = items[Math.max(slashMenuIndex, 0)];
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // --- Message handling from extension ---
  window.addEventListener('message', function(event) {
    var msg = event.data;

    switch (msg.type) {
      case 'connectionState':
        badgeEl.textContent = msg.state;
        badgeEl.className = 'connection-badge ' + msg.state;
        break;

      case 'slashCommands':
        slashCommands = msg.commands;
        break;

      case 'streamStart':
        setStreamingMode(true);
        typingEl.classList.add('visible');
        startBreeMessage();
        break;

      case 'streamChunk':
        typingEl.classList.remove('visible');
        appendToCurrentBree(msg.content);
        break;

      case 'streamEnd':
        setStreamingMode(false);
        typingEl.classList.remove('visible');
        finishBreeMessage();
        break;

      case 'breeMessage':
        welcomeEl.style.display = 'none';
        startBreeMessage();
        appendToCurrentBree(msg.content);
        finishBreeMessage();
        break;

      case 'historyReplay':
        welcomeEl.style.display = 'none';
        if (msg.role === 'user') {
          addUserMessage(msg.content);
        } else {
          startBreeMessage();
          appendToCurrentBree(msg.content);
          finishBreeMessage();
        }
        break;

      case 'historyCleared':
        messagesEl.innerHTML = '';
        messagesEl.appendChild(welcomeEl);
        welcomeEl.style.display = '';
        break;
    }
  });

  inputEl.focus();
})();
</script>

</body>
</html>`;
  }
}
