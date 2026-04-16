import * as vscode from 'vscode';
import * as os from 'os';
import { HttpClient } from './http-client';
import { WsClient } from './ws-client';
import { getConfig, getBridgeToken, onTokenChange } from '../config';
import type { BridgeMessage, ConnectionState } from '../types';

export class ConnectionManager implements vscode.Disposable {
  private http: HttpClient;
  private ws: WsClient | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private _state: ConnectionState = 'disconnected';
  private _onStateChange = new vscode.EventEmitter<ConnectionState>();
  private _onMessage = new vscode.EventEmitter<BridgeMessage>();
  private disposables: vscode.Disposable[] = [];

  readonly onStateChange = this._onStateChange.event;
  readonly onMessage = this._onMessage.event;

  constructor(serverUrl: string, token: string) {
    this.http = new HttpClient(serverUrl, token);

    // Update HTTP client when token changes
    this.disposables.push(
      onTokenChange((newToken) => {
        this.http.updateToken(newToken);
      })
    );
  }

  get state(): ConnectionState {
    return this._state;
  }

  get client(): HttpClient {
    return this.http;
  }

  async connect(): Promise<void> {
    // Tear down any existing connection first (idempotent)
    this.teardown();

    this._state = 'connecting';
    this._onStateChange.fire('connecting');

    try {
      const health = await this.http.health();
      if (health.status !== 'ok' && health.status !== 'healthy') {
        throw new Error(`Server unhealthy: ${health.status}`);
      }

      // Register as a VS Code client
      await this.http.tunnelRegister(`vscode-${os.hostname()}`).catch(() => {
        // tunnel registration is optional — server may not support it
      });

      this._state = 'connected';
      this._onStateChange.fire('connected');

      // Start WebSocket for push events
      const config = getConfig();
      const token = (await getBridgeToken()) ?? '';

      this.ws = new WsClient(config.serverUrl, token);
      this.ws.on('message', (msg: BridgeMessage) => this._onMessage.fire(msg));
      this.ws.connect();

      // Periodic health check every 60s with recovery
      this.healthTimer = setInterval(async () => {
        try {
          await this.http.health();
          // Recover from transient reconnecting state
          if (this._state === 'reconnecting') {
            this._state = 'connected';
            this._onStateChange.fire('connected');
          }
        } catch {
          if (this._state === 'connected') {
            this._state = 'reconnecting';
            this._onStateChange.fire('reconnecting');
          }
        }
      }, 60000);
    } catch (err) {
      this._state = 'disconnected';
      this._onStateChange.fire('disconnected');
      throw err;
    }
  }

  private teardown(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
  }

  disconnect(): void {
    this.teardown();
    this._state = 'disconnected';
    this._onStateChange.fire('disconnected');
  }

  dispose(): void {
    this.disconnect();
    this.disposables.forEach((d) => d.dispose());
    this._onStateChange.dispose();
    this._onMessage.dispose();
  }
}
