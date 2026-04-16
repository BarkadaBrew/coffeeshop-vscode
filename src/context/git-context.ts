import * as vscode from 'vscode';
import type { GitState } from '../types';

interface GitExtensionAPI {
  repositories: Array<{
    state: {
      HEAD?: { name?: string; upstream?: { name?: string; remote?: string } };
      workingTreeChanges: Array<{ uri: vscode.Uri }>;
      indexChanges: Array<{ uri: vscode.Uri }>;
      untrackedChanges?: Array<{ uri: vscode.Uri }>;
    };
    log(options?: { maxEntries?: number }): Promise<Array<{ message: string; hash: string }>>;
  }>;
}

export async function getGitState(): Promise<GitState | undefined> {
  const gitExt = vscode.extensions.getExtension<{ getAPI(version: number): GitExtensionAPI }>(
    'vscode.git'
  );
  if (!gitExt) return undefined;

  const git = gitExt.isActive ? gitExt.exports.getAPI(1) : undefined;
  if (!git || git.repositories.length === 0) return undefined;

  const repo = git.repositories[0];
  const head = repo.state.HEAD;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  const relativize = (uri: vscode.Uri) =>
    root ? uri.fsPath.replace(root + '/', '') : uri.fsPath;

  let recentCommits: string[] = [];
  try {
    const log = await repo.log({ maxEntries: 5 });
    recentCommits = log.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
  } catch {
    // git log may fail on empty repos
  }

  return {
    branch: head?.name ?? 'detached',
    remote: head?.upstream?.remote,
    modified: repo.state.workingTreeChanges.map((c) => relativize(c.uri)),
    staged: repo.state.indexChanges.map((c) => relativize(c.uri)),
    untracked: (repo.state.untrackedChanges ?? []).map((c) => relativize(c.uri)),
    recentCommits,
  };
}
