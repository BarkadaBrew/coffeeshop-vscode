import type { WorkspaceContext } from '../types';
import { getActiveFileContext, getOpenFiles, getWorkspaceRoot } from './workspace-context';
import { getDiagnostics } from './diagnostics-context';
import { getGitState } from './git-context';
import { TerminalCapture } from './terminal-context';

export async function buildContext(
  terminal: TerminalCapture
): Promise<WorkspaceContext> {
  const [activeFile, gitState] = await Promise.all([
    Promise.resolve(getActiveFileContext()),
    getGitState(),
  ]);

  return {
    activeFile: activeFile ?? undefined,
    openFiles: getOpenFiles(),
    workspaceRoot: getWorkspaceRoot(),
    diagnostics: getDiagnostics(),
    gitState,
    terminalOutput: terminal.getRecentOutput(),
  };
}

export function formatContextBlock(ctx: WorkspaceContext): string {
  const parts: string[] = ['[VSCODE CONTEXT]'];

  if (ctx.activeFile) {
    parts.push(
      `File: ${ctx.activeFile.relativePath} (${ctx.activeFile.language}), cursor at line ${ctx.activeFile.cursorLine}`
    );
    if (ctx.activeFile.selection) {
      parts.push(
        `Selection: lines ${ctx.activeFile.selection.start}-${ctx.activeFile.selection.end}`
      );
    }
  }

  if (ctx.openFiles.length > 0) {
    parts.push(`Open tabs: ${ctx.openFiles.slice(0, 10).join(', ')}`);
  }

  if (ctx.gitState) {
    const g = ctx.gitState;
    const changes = [
      g.modified.length > 0 ? `${g.modified.length} modified` : '',
      g.staged.length > 0 ? `${g.staged.length} staged` : '',
      g.untracked.length > 0 ? `${g.untracked.length} untracked` : '',
    ]
      .filter(Boolean)
      .join(', ');

    parts.push(`Git: branch ${g.branch}${changes ? `, ${changes}` : ''}`);
  }

  if (ctx.diagnostics.length > 0) {
    const errors = ctx.diagnostics.filter((d) => d.severity === 'error');
    const warnings = ctx.diagnostics.filter((d) => d.severity === 'warning');
    const summary = [
      errors.length > 0 ? `${errors.length} errors` : '',
      warnings.length > 0 ? `${warnings.length} warnings` : '',
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(`Diagnostics: ${summary}`);

    for (const d of ctx.diagnostics.slice(0, 10)) {
      parts.push(`  ${d.severity}: ${d.file}:${d.line} — ${d.message}`);
    }
  }

  if (ctx.terminalOutput) {
    parts.push(`Terminal (recent):\n${ctx.terminalOutput.slice(-1000)}`);
  }

  parts.push('[/VSCODE CONTEXT]');
  return parts.join('\n');
}

export function formatFileContent(ctx: WorkspaceContext): string {
  if (!ctx.activeFile) return '';
  return `[ACTIVE FILE: ${ctx.activeFile.relativePath}]\n${ctx.activeFile.content}\n[/ACTIVE FILE]`;
}
