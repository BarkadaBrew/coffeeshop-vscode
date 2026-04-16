import * as vscode from 'vscode';
import type { FileContext } from '../types';

const MAX_CONTENT_CHARS = 8000;
const CONTEXT_LINES_AROUND_CURSOR = 100;

export function getActiveFileContext(): FileContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;

  const doc = editor.document;
  const cursor = editor.selection.active;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // Extract content around cursor
  const startLine = Math.max(0, cursor.line - CONTEXT_LINES_AROUND_CURSOR);
  const endLine = Math.min(
    doc.lineCount - 1,
    cursor.line + CONTEXT_LINES_AROUND_CURSOR
  );
  const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
  let content = doc.getText(range);

  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS) + '\n... (truncated)';
  }

  // Add line numbers
  const lines = content.split('\n');
  content = lines
    .map((line, i) => `${startLine + i + 1} | ${line}`)
    .join('\n');

  const result: FileContext = {
    path: doc.uri.fsPath,
    relativePath: workspaceRoot
      ? doc.uri.fsPath.replace(workspaceRoot + '/', '')
      : doc.uri.fsPath,
    language: doc.languageId,
    content,
    cursorLine: cursor.line + 1,
  };

  // Include selection if present
  if (!editor.selection.isEmpty) {
    const selText = doc.getText(editor.selection);
    result.selection = {
      start: editor.selection.start.line + 1,
      end: editor.selection.end.line + 1,
      text: selText.slice(0, MAX_CONTENT_CHARS),
    };
  }

  return result;
}

export function getOpenFiles(): string[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) {
        const p = input.uri.fsPath;
        return root ? p.replace(root + '/', '') : p;
      }
      return null;
    })
    .filter((p): p is string => p !== null);
}

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
