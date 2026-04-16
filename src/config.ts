import * as vscode from 'vscode';
import type { CoffeeShopConfig } from './types';

const SECTION = 'coffeeshop';
const TOKEN_KEY = 'coffeeshop.bridgeToken';

let secretStorage: vscode.SecretStorage;

export function initConfig(context: vscode.ExtensionContext): void {
  secretStorage = context.secrets;
}

export function getConfig(): Omit<CoffeeShopConfig, 'bridgeToken'> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    serverUrl: cfg.get<string>('serverUrl', 'http://10.0.100.232:3777'),
    autoConnect: cfg.get<boolean>('autoConnect', true),
    contextBudget: cfg.get<number>('contextBudget', 5000),
    confirmTerminalCommands: cfg.get<boolean>('confirmTerminalCommands', true),
  };
}

export async function getBridgeToken(): Promise<string | undefined> {
  return secretStorage.get(TOKEN_KEY);
}

export async function setBridgeToken(token: string): Promise<void> {
  await secretStorage.store(TOKEN_KEY, token);
}

export async function getFullConfig(): Promise<CoffeeShopConfig> {
  const base = getConfig();
  const bridgeToken = (await getBridgeToken()) ?? '';
  return { ...base, bridgeToken };
}
