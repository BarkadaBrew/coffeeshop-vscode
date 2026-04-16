import * as vscode from 'vscode';

const MAX_BUFFER_LINES = 200;

/**
 * Secret patterns to redact from terminal output before sending to server.
 */
const SECRET_PATTERNS = [
  /(?:password|passwd|pwd|secret|token|api.?key|auth|bearer)\s*[:=]\s*\S+/gi,
  /(?:AWS_|GITHUB_|NPM_|DOCKER_|SSH_|GPG_)\w+\s*=\s*\S+/gi,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/g, // JWT tokens
  /ghp_[A-Za-z0-9_]+/g, // GitHub PATs
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI/Anthropic keys
  /AKIA[A-Z0-9]{16}/g, // AWS access keys
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Captures terminal output from VS Code terminals.
 * Redacts secrets before making output available.
 */
export class TerminalCapture implements vscode.Disposable {
  private buffer: string[] = [];
  private disposables: vscode.Disposable[] = [];

  activate(): void {
    if (vscode.window.onDidWriteTerminalData) {
      const handler = vscode.window.onDidWriteTerminalData(
        (e: vscode.TerminalDataWriteEvent) => {
          const lines = e.data.split('\n');
          this.buffer.push(...lines);
          if (this.buffer.length > MAX_BUFFER_LINES) {
            this.buffer = this.buffer.slice(-MAX_BUFFER_LINES);
          }
        }
      );
      this.disposables.push(handler);
    }
  }

  getRecentOutput(maxLines = 50): string {
    const raw = this.buffer.slice(-maxLines).join('\n');
    return redactSecrets(raw);
  }

  clear(): void {
    this.buffer = [];
  }

  /**
   * Terminal command allowlist — only commands matching these prefixes
   * can be executed. Prevents arbitrary remote shell execution.
   */
  private static readonly ALLOWED_PREFIXES = [
    'npm ', 'npx ', 'node ', 'git ', 'tsc ', 'eslint ',
    'prettier ', 'vitest ', 'jest ', 'cargo ', 'go ',
    'python ', 'pip ', 'make ', 'cmake ', 'ls ', 'cat ',
    'grep ', 'find ', 'echo ', 'pwd', 'which ', 'env',
  ];

  async executeCommand(
    command: string,
    confirm: boolean
  ): Promise<boolean> {
    // Validate against allowlist
    const trimmed = command.trim();
    const allowed = TerminalCapture.ALLOWED_PREFIXES.some(
      (p) => trimmed.startsWith(p) || trimmed === p.trim()
    );
    if (!allowed) {
      const answer = await vscode.window.showWarningMessage(
        `Bree wants to run a non-allowlisted command: ${trimmed.slice(0, 100)}`,
        { modal: true },
        'Allow Once',
        'Block'
      );
      if (answer !== 'Allow Once') return false;
    } else if (confirm) {
      const answer = await vscode.window.showWarningMessage(
        `Bree wants to run: ${command}`,
        { modal: true },
        'Run',
        'Cancel'
      );
      if (answer !== 'Run') return false;
    }

    const terminal =
      vscode.window.activeTerminal ??
      vscode.window.createTerminal('Bree');
    terminal.show();
    terminal.sendText(command);
    return true;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
