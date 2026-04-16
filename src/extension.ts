import * as vscode from 'vscode';
import { initConfig, getConfig, getBridgeToken } from './config';
import { ConnectionManager } from './client/connection-manager';
import { TerminalCapture } from './context/terminal-context';
import { StatusBar } from './ui/status-bar';
import { BreeChatViewProvider } from './ui/webview-panel';
import { registerCommands } from './commands/commands';
import { registerChatParticipant } from './chat/chat-participant';
import { handleBridgeMessage } from './ui/notification-handler';

let connection: ConnectionManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initConfig(context);

  const config = getConfig();
  const token = (await getBridgeToken()) ?? '';

  // Core services
  connection = new ConnectionManager(config.serverUrl, token);
  const terminal = new TerminalCapture();
  const statusBar = new StatusBar();

  terminal.activate();

  // Register disposables
  context.subscriptions.push(connection, terminal, statusBar);

  // Register commands
  registerCommands(context, connection, statusBar);

  // Always register the webview sidebar — works in VS Code and VS Codium
  const chatViewProvider = new BreeChatViewProvider(
    context.extensionUri,
    connection,
    terminal
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      BreeChatViewProvider.viewType,
      chatViewProvider
    )
  );

  // Conditionally register @bree chat participant only when Copilot Chat API exists
  // In VS Codium or VS Code without Copilot, vscode.chat is undefined
  if (typeof vscode.chat?.createChatParticipant === 'function') {
    try {
      const chatParticipant = registerChatParticipant(context, connection, terminal);
      context.subscriptions.push(chatParticipant);
    } catch {
      // Chat Participant API not available — webview is the fallback
    }
  }

  // Handle push messages from the server
  connection.onMessage((msg) => handleBridgeMessage(msg));

  // Auto-connect on startup
  if (config.autoConnect && token) {
    try {
      await connection.connect();
      statusBar.update('connected');
    } catch {
      statusBar.update('disconnected');
      // Silent fail on auto-connect — user can manually connect
    }
  }
}

export function deactivate(): void {
  if (connection) {
    connection.disconnect();
  }
}
