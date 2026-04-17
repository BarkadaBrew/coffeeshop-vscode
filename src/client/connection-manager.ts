import * as vscode from 'vscode';
import * as os from 'os';
import { HttpClient } from './http-client';
import { WsClient } from './ws-client';
import { getConfig, getBridgeToken, onTokenChange } from '../config';
import type { BridgeMessage, ConnectionState } from '../types';

const HEALTH_INTERVAL_MS = 30000;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

export class ConnectionManager implements vscode.Disposable {
  private http: HttpClient;
  private ws: WsClient | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private _state: ConnectionState = 'disconnected';
  private _onStateChange = new vscode.EventEmitter<ConnectionState>();
  private _onMessage = new vscode.EventEmitter<BridgeMessage>();
  private disposables: vscode.Disposable[] = [];
  private shouldAutoReconnect = false;

  readonly onStateChange = this._onStateChange.event;
  readonly onMessage = this._onMessage.event;

  constructor(serverUrl: string, token: string) {
    this.http = new HttpClient(serverUrl, token);

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
    this.shouldAutoReconnect = true;
    this.reconnectAttempt = 0;
    await this.doConnect();
  }

  private async doConnect(): Promise<void> {
    this.teardown();

    this.setState('connecting');

    try {
      const health = await this.http.health();
      if (health.status !== 'ok' && health.status !== 'healthy') {
        throw new Error(`Server unhealthy: ${health.status}`);
      }

      await this.http.tunnelRegister(`vscode-${os.hostname()}`).catch(() => {});

      this.reconnectAttempt = 0;
      this.setState('connected');

      // Start WebSocket for push events
      const config = getConfig();
      const token = (await getBridgeToken()) ?? '';

      this.ws = new WsClient(config.serverUrl, token);
      this.ws.on('message', (msg: BridgeMessage) => this._onMessage.fire(msg));
      this.ws.connect();

      // Health check + auto-reconnect watchdog
      this.healthTimer = setInterval(async () => {
        try {
          await this.http.health();
          if (this._state === 'reconnecting') {
            this.reconnectAttempt = 0;
            this.setState('connected');
          }
        } catch {
          if (this._state === 'connected') {
            this.setState('reconnecting');
            this.scheduleReconnect();
          }
        }
      }, HEALTH_INTERVAL_MS);
    } catch (err) {
      if (this.shouldAutoReconnect) {
        this.setState('reconnecting');
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
      throw err;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = RECONNECT_DELAYS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
    ];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldAutoReconnect) return;

      try {
        await this.doConnect();
      } catch {
        // doConnect will schedule another reconnect
      }
    }, delay);
  }

  private teardown(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
  }

  disconnect(): void {
    this.shouldAutoReconnect = false;
    this.teardown();
    this.setState('disconnected');
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this._onStateChange.fire(state);
  }

  dispose(): void {
    this.disconnect();
    this.disposables.forEach((d) => d.dispose());
    this._onStateChange.dispose();
    this._onMessage.dispose();
  }
}
