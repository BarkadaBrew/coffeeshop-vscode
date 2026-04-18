import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connection-manager';
import { TerminalCapture } from '../context/terminal-context';
import { buildChatMessages, DAEMON_MODEL } from './message-builder';
import type { ChatMessage } from '../types';

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

    // Build history from prior turns
    const history: ChatMessage[] = [];
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        history.push({ role: 'user', content: turn.prompt });
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
          history.push({ role: 'assistant', content: parts });
        }
      }
    }

    const command = request.command;
    const messages = await buildChatMessages(
      terminal,
      request.prompt,
      command,
      history
    );

    // Create an AbortController tied to the cancellation token
    const abort = new AbortController();
    const cancelListener = token.onCancellationRequested(() => abort.abort());

    try {
      const streamGen = connection.client.chatStream(messages, { model: DAEMON_MODEL, signal: abort.signal });
      for await (const chunk of streamGen) {
        if (token.isCancellationRequested) break;
        stream.markdown(chunk);
      }
    } catch (err) {
      if (token.isCancellationRequested) return; // user cancelled
      const msg = err instanceof Error ? err.message : String(err);
      // Surface the failure to the watchdog so it probes + reconnects.
      connection.reportFailure(err);
      stream.markdown(`\n\n**Error:** ${msg}`);
    } finally {
      cancelListener.dispose();
    }
  });

  // Icon is optional
  const iconUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'bree-icon.png');
  vscode.workspace.fs.stat(iconUri).then(
    () => { participant.iconPath = iconUri; },
    () => { /* no icon file */ }
  );

  return participant;
}
