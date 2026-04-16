import * as vscode from 'vscode';
import type { DiagnosticInfo } from '../types';

const SEVERITY_MAP: Record<number, DiagnosticInfo['severity']> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

export function getDiagnostics(fileOnly?: string): DiagnosticInfo[] {
  const all = vscode.languages.getDiagnostics();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const results: DiagnosticInfo[] = [];

  for (const [uri, diagnostics] of all) {
    const filePath = root
      ? uri.fsPath.replace(root + '/', '')
      : uri.fsPath;

    if (fileOnly && filePath !== fileOnly && uri.fsPath !== fileOnly) {
      continue;
    }

    for (const d of diagnostics) {
      // Only include errors and warnings by default
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;

      results.push({
        file: filePath,
        line: d.range.start.line + 1,
        severity: SEVERITY_MAP[d.severity] ?? 'info',
        message: d.message,
        code: typeof d.code === 'object' ? String(d.code.value) : d.code?.toString(),
      });
    }
  }

  return results.slice(0, 50); // cap at 50 diagnostics
}
