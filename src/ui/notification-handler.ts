import * as vscode from 'vscode';
import type { BridgeMessage } from '../types';

export function handleBridgeMessage(msg: BridgeMessage): void {
  switch (msg.type) {
    case 'notification': {
      const text = String(msg.payload.text ?? msg.payload.message ?? '');
      if (!text) return;
      vscode.window.showInformationMessage(`Bree: ${text}`);
      break;
    }

    case 'alert': {
      const text = String(msg.payload.text ?? msg.payload.message ?? '');
      if (!text) return;
      vscode.window.showWarningMessage(`Bree: ${text}`);
      break;
    }

    case 'pong':
    case 'ping':
      // heartbeat — ignore
      break;

    default:
      // unknown message types are silently ignored
      break;
  }
}
