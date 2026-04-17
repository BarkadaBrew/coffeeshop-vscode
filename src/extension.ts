import * as vscode from 'vscode';
import { initConfig, getConfig, getBridgeToken } from './config';
import { ConnectionManager } from './client/connection-manager';
import { TerminalCapture } from './context/terminal-context';
import { StatusBar } from './ui/status-bar';
import { BreeChatViewProvider } from './ui/webview-panel';
import { registerCommands } from './commands/commands';
import { registerChatParticipant } from './chat/chat-participant';
import { handleBridgeMessage } from './ui/notification-handler';

const log = vscode.window.createOutputChannel('CoffeeShop');

let connection: ConnectionManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initConfig(context);

  const config = getConfig();
  const token = (await getBridgeToken()) ?? '';

  log.appendLine(`[coffeeshop] activate: server=${config.serverUrl} token=${token ? 'set' : 'empty'} autoConnect=${config.autoConnect}`);

  connection = new ConnectionManager(config.serverUrl, token);
  const terminal = new TerminalCapture();
  const statusBar = new StatusBar();

  terminal.activate();

  context.subscriptions.push(connection, terminal, statusBar, log);

  registerCommands(context, connection, statusBar);

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

  if (typeof vscode.chat?.createChatParticipant === 'function') {
    try {
      const chatParticipant = registerChatParticipant(context, connection, terminal);
      context.subscriptions.push(chatParticipant);
    } catch {
      // not available
    }
  }

  connection.onMessage((msg) => handleBridgeMessage(msg));

  // Always auto-connect — don't gate on token being present
  if (config.autoConnect) {
    log.appendLine('[coffeeshop] auto-connecting...');
    try {
      await connection.connect();
      statusBar.update('connected');
      log.appendLine('[coffeeshop] connected successfully');
    } catch (err) {
      statusBar.update('disconnected');
      const msg = err instanceof Error ? err.message : String(err);
      log.appendLine(`[coffeeshop] connect failed: ${msg}`);
    }
  }
}

export function deactivate(): void {
  if (connection) {
    connection.disconnect();
  }
}
