import * as vscode from 'vscode';

export interface CoffeeShopConfig {
  serverUrl: string;
  bridgeToken: string;
  autoConnect: boolean;
  contextBudget: number;
  confirmTerminalCommands: boolean;
}

export interface HealthResponse {
  status: string;
  uptime: number;
  version?: string;
  persona?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  id: string;
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface WorkspaceContext {
  activeFile?: FileContext;
  openFiles: string[];
  workspaceRoot?: string;
  diagnostics: DiagnosticInfo[];
  gitState?: GitState;
  terminalOutput?: string;
}

export interface FileContext {
  path: string;
  relativePath: string;
  language: string;
  content: string;
  cursorLine: number;
  selection?: { start: number; end: number; text: string };
}

export interface DiagnosticInfo {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code?: string;
}

export interface GitState {
  branch: string;
  remote?: string;
  aheadBehind?: { ahead: number; behind: number };
  modified: string[];
  staged: string[];
  untracked: string[];
  recentCommits: string[];
}

export interface BridgeMessage {
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionEvent {
  state: ConnectionState;
  error?: string;
}
