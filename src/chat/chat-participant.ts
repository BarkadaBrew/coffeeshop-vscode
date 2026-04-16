import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connection-manager';
import { TerminalCapture } from '../context/terminal-context';
import { getConfig } from '../config';
import { buildContext, formatContextBlock, formatFileContent } from '../context/context-builder';
import type { ChatMessage } from '../types';

const SLASH_PROMPTS: Record<string, string> = {
  explain:
    'Explain the following code clearly. Break down what it does, why, and any non-obvious details.',
  fix: 'Fix the errors in this file. Show the corrected code with a brief explanation of each fix.',
  test: 'Generate unit tests for the selected code. Use the testing framework already in use in this project if detectable.',
  commit:
    'Based on the current git diff, suggest a concise commit message. Follow conventional commits style if the project uses it.',
  review:
    'Review this code for bugs, performance issues, security concerns, and readability. Be direct and actionable.',
};

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  connection: ConnectionManager,
  terminal: TerminalCapture
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant('bree', async (request, chatContext, stream, token) => {
    if (connection.state !== 'connected') {
      stream.markdown(
        '**Not connected to CoffeeShop server.** Run `CoffeeShop: Connect to Bree` first.'
      );
      return;
    }

    const config = getConfig();

    // Build workspace context
    const wsContext = await buildContext(terminal);
    const contextBlock = formatContextBlock(wsContext);
    const fileBlock = formatFileContent(wsContext);

    // Trim context to budget
    let contextContent = contextBlock;
    if (fileBlock) contextContent += '\n' + fileBlock;
    if (contextContent.length > config.contextBudget * 4) {
      // Rough char-to-token ratio ~4:1
      contextContent = contextContent.slice(0, config.contextBudget * 4) + '\n... (context truncated to budget)';
    }

    // Build messages
    const messages: ChatMessage[] = [];

    messages.push({
      role: 'system',
      content: [
        'You are Bree, an AI copilot in VS Code. You are helping Todd write, debug, and understand code.',
        'You have access to his workspace context below. Use it to give precise, contextual answers.',
        'When suggesting code changes, use fenced code blocks with the filename as the language tag comment.',
        'Be direct, concise, and mentor-like. Todd is a senior PM who codes — respect his intelligence but guide when helpful.',
        '',
        contextContent,
      ].join('\n'),
    });

    // Include prior turns from this chat session
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({ role: 'user', content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const parts = turn.response
          .map((p) => {
            if (p instanceof vscode.ChatResponseMarkdownPart) {
              return p.value.value;
            }
            return '';
          })
          .join('');
        if (parts) {
          messages.push({ role: 'assistant', content: parts });
        }
      }
    }

    // Current user message
    const command = request.command;
    const slashPrompt = command ? SLASH_PROMPTS[command] : undefined;
    const userContent = slashPrompt
      ? `${slashPrompt}\n\n${request.prompt || '(see context above)'}`
      : request.prompt;

    messages.push({ role: 'user', content: userContent });

    // Create an AbortController tied to the cancellation token
    const abort = new AbortController();
    const cancelListener = token.onCancellationRequested(() => abort.abort());

    try {
      const streamGen = connection.client.chatStream(messages, { signal: abort.signal });
      for await (const chunk of streamGen) {
        if (token.isCancellationRequested) break;
        stream.markdown(chunk);
      }
    } catch (err) {
      if (token.isCancellationRequested) return; // user cancelled — no error
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`\n\n**Error:** ${msg}`);
    } finally {
      cancelListener.dispose();
    }
  });

  // Icon is optional — gracefully handle missing file
  const iconUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'bree-icon.png');
  vscode.workspace.fs.stat(iconUri).then(
    () => { participant.iconPath = iconUri; },
    () => { /* no icon file — use default */ }
  );

  return participant;
}
