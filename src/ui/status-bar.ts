import * as vscode from 'vscode';
import type { ConnectionState } from '../types';

const STATE_ICONS: Record<ConnectionState, string> = {
  disconnected: '$(debug-disconnect)',
  connecting: '$(sync~spin)',
  connected: '$(coffee)',
  reconnecting: '$(sync~spin)',
};

const STATE_TEXT: Record<ConnectionState, string> = {
  disconnected: 'Bree: Offline',
  connecting: 'Bree: Connecting...',
  connected: 'Bree: Online',
  reconnecting: 'Bree: Reconnecting...',
};

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'coffeeshop.connect';
    this.update('disconnected');
    this.item.show();
  }

  update(state: ConnectionState): void {
    this.item.text = `${STATE_ICONS[state]} ${STATE_TEXT[state]}`;
    this.item.tooltip = state === 'connected'
      ? 'Connected to CoffeeShop — click to reconnect'
      : 'Click to connect to Bree';

    this.item.backgroundColor =
      state === 'disconnected'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
