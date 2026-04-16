import * as vscode from 'vscode';
import type { GitState } from '../types';

// Use the official Git extension API types
// See: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
interface GitExtensionExports {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: GitRepository[];
}

interface GitRepository {
  state: {
    HEAD?: { name?: string; upstream?: { name?: string; remote?: string } };
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
    mergeChanges: GitChange[];
  };
  log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
}

interface GitChange {
  uri: vscode.Uri;
  status: number; // See Status enum in git extension
}

interface GitCommit {
  message: string;
  hash: string;
}

// Git extension Status enum values
const GIT_STATUS_UNTRACKED = 7;

export async function getGitState(): Promise<GitState | undefined> {
  const gitExt = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!gitExt) return undefined;

  // Activate the git extension if not already active
  if (!gitExt.isActive) {
    try {
      await gitExt.activate();
    } catch {
      return undefined;
    }
  }

  const git = gitExt.exports.getAPI(1);
  if (!git || git.repositories.length === 0) return undefined;

  const repo = git.repositories[0];
  const head = repo.state.HEAD;

  const relativize = (uri: vscode.Uri) =>
    vscode.workspace.asRelativePath(uri, false);

  // Separate untracked from modified in workingTreeChanges
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const change of repo.state.workingTreeChanges) {
    if (change.status === GIT_STATUS_UNTRACKED) {
      untracked.push(relativize(change.uri));
    } else {
      modified.push(relativize(change.uri));
    }
  }

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
    modified,
    staged: repo.state.indexChanges.map((c) => relativize(c.uri)),
    untracked,
    recentCommits,
  };
}
