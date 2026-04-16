import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connection-manager';
import { TerminalCapture } from '../context/terminal-context';
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

    // Build workspace context
    const wsContext = await buildContext(terminal);
    const contextBlock = formatContextBlock(wsContext);
    const fileBlock = formatFileContent(wsContext);

    // Build messages
    const messages: ChatMessage[] = [];

    // System context with workspace info
    messages.push({
      role: 'system',
      content: [
        'You are Bree, an AI copilot in VS Code. You are helping Todd write, debug, and understand code.',
        'You have access to his workspace context below. Use it to give precise, contextual answers.',
        'When suggesting code changes, use fenced code blocks with the filename as the language tag comment.',
        'Be direct, concise, and mentor-like. Todd is a senior PM who codes — respect his intelligence but guide when helpful.',
        '',
        contextBlock,
        fileBlock ? '\n' + fileBlock : '',
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

    // Current user message — prepend slash command prompt if applicable
    const command = request.command;
    const slashPrompt = command ? SLASH_PROMPTS[command] : undefined;
    const userContent = slashPrompt
      ? `${slashPrompt}\n\n${request.prompt || '(see context above)'}`
      : request.prompt;

    messages.push({ role: 'user', content: userContent });

    // Stream the response
    try {
      const streamGen = connection.client.chatStream(messages);
      for await (const chunk of streamGen) {
        if (token.isCancellationRequested) break;
        stream.markdown(chunk);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`\n\n**Error:** ${msg}`);
    }
  });

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    'media',
    'bree-icon.png'
  );

  return participant;
}
