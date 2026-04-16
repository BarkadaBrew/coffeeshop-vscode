import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connection-manager';
import { setBridgeToken, getBridgeToken, getConfig } from '../config';
import { StatusBar } from '../ui/status-bar';

export function registerCommands(
  context: vscode.ExtensionContext,
  connection: ConnectionManager,
  statusBar: StatusBar
): void {
  // Connect
  context.subscriptions.push(
    vscode.commands.registerCommand('coffeeshop.connect', async () => {
      try {
        const token = await getBridgeToken();
        if (!token) {
          const answer = await vscode.window.showWarningMessage(
            'No bridge token set. Set one now?',
            'Set Token',
            'Cancel'
          );
          if (answer === 'Set Token') {
            await vscode.commands.executeCommand('coffeeshop.setToken');
          }
          return;
        }

        statusBar.update('connecting');
        await connection.connect();
        statusBar.update('connected');
        vscode.window.showInformationMessage('Connected to Bree');
      } catch (err) {
        statusBar.update('disconnected');
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to connect: ${msg}`);
      }
    })
  );

  // Disconnect
  context.subscriptions.push(
    vscode.commands.registerCommand('coffeeshop.disconnect', () => {
      connection.disconnect();
      statusBar.update('disconnected');
      vscode.window.showInformationMessage('Disconnected from Bree');
    })
  );

  // Set Token
  context.subscriptions.push(
    vscode.commands.registerCommand('coffeeshop.setToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter CoffeeShop bridge token',
        password: true,
        placeHolder: 'Bridge token from coffeeshop-server',
      });
      if (token) {
        await setBridgeToken(token);
        vscode.window.showInformationMessage('Bridge token saved');
      }
    })
  );

  // Ask Bree (opens chat panel)
  context.subscriptions.push(
    vscode.commands.registerCommand('coffeeshop.askBree', () => {
      vscode.commands.executeCommand('workbench.action.chat.open', '@bree ');
    })
  );

  // Explain Selection
  context.subscriptions.push(
    vscode.commands.registerCommand('coffeeshop.explainSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select some code first');
        return;
      }
      const text = editor.document.getText(editor.selection);
      vscode.commands.executeCommand(
        'workbench.action.chat.open',
        `@bree /explain ${text.slice(0, 500)}`
      );
    })
  );

  // Fix Errors
  context.subscriptions.push(
    vscode.commands.registerCommand('coffeeshop.fixErrors', () => {
      vscode.commands.executeCommand(
        'workbench.action.chat.open',
        '@bree /fix'
      );
    })
  );

  // React to connection state changes
  connection.onStateChange((state) => {
    statusBar.update(state);
  });
}
