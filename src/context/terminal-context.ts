import * as vscode from 'vscode';

const MAX_BUFFER_LINES = 200;

/**
 * Captures terminal output from VS Code terminals.
 * Uses the onDidWriteTerminalData API when available,
 * falls back to a minimal buffer otherwise.
 */
export class TerminalCapture implements vscode.Disposable {
  private buffer: string[] = [];
  private disposables: vscode.Disposable[] = [];

  activate(): void {
    // Listen for terminal data if the API is available
    if ('onDidWriteTerminalData' in vscode.window) {
      const handler = (vscode.window as any).onDidWriteTerminalData(
        (e: { terminal: vscode.Terminal; data: string }) => {
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
    return this.buffer.slice(-maxLines).join('\n');
  }

  clear(): void {
    this.buffer = [];
  }

  async executeCommand(
    command: string,
    confirm: boolean
  ): Promise<boolean> {
    if (confirm) {
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
