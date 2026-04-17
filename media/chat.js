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

  function sanitizeUrl(url) {
    try {
      var parsed = new URL(url, 'https://placeholder.invalid');
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return escapeHtml(url);
      }
    } catch (e) {}
    return '#';
  }

  // --- Markdown rendering ---

  function renderMarkdown(text) {
    var parts = [];
    var remaining = text;
    var codeBlockRe = /```(\w*)\n([\s\S]*?)(```|$)/g;
    var lastIndex = 0;
    var match;

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

    return parts.map(function(part) {
      if (part.type === 'code') {
        return renderCodeBlock(part.lang, part.content);
      }
      return renderInlineMarkdown(part.content);
    }).join('');
  }

  function renderCodeBlock(lang, code) {
    var id = 'cb-' + Math.random().toString(36).slice(2, 9);
    var trimmed = code.replace(/\n$/, '');
    return '<div class="code-block-wrapper">' +
      '<div class="code-block-header">' +
        '<span class="code-block-lang">' + escapeHtml(lang || 'code') + '</span>' +
        '<button class="copy-btn" data-code-id="' + id + '" title="Copy code">Copy</button>' +
      '</div>' +
      '<pre><code id="' + id + '">' + escapeHtml(trimmed) + '</code></pre>' +
    '</div>';
  }

  function renderInlineMarkdown(text) {
    var blocks = text.split(/\n\n+/);
    var html = '';

    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b].trim();
      if (!block) continue;

      var headerMatch = block.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        var level = headerMatch[1].length;
        html += '<h' + level + '>' + renderInline(headerMatch[2]) + '</h' + level + '>';
        continue;
      }

      if (/^[*-]\s+/.test(block)) {
        var items = block.split(/\n/).filter(function(l) { return l.trim(); });
        html += '<ul>';
        for (var i = 0; i < items.length; i++) {
          html += '<li>' + renderInline(items[i].replace(/^\s*[*-]\s+/, '')) + '</li>';
        }
        html += '</ul>';
        continue;
      }

      if (/^\d+\.\s+/.test(block)) {
        var items = block.split(/\n/).filter(function(l) { return l.trim(); });
        html += '<ol>';
        for (var i = 0; i < items.length; i++) {
          html += '<li>' + renderInline(items[i].replace(/^\s*\d+\.\s+/, '')) + '</li>';
        }
        html += '</ol>';
        continue;
      }

      html += '<p>' + renderInline(block).replace(/\n/g, '<br>') + '</p>';
    }

    return html;
  }

  function renderInline(text) {
    var s = escapeHtml(text);
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_m, label, url) {
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
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) {
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

  // Signal extension that JS is ready to receive messages
  vscode.postMessage({ type: 'ready' });
})();
