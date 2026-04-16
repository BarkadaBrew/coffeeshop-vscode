import * as vscode from 'vscode';
import { HttpClient } from './http-client';
import { WsClient } from './ws-client';
import type { BridgeMessage, ConnectionState } from '../types';

export class ConnectionManager {
  private http: HttpClient;
  private ws: WsClient | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private _state: ConnectionState = 'disconnected';
  private _onStateChange = new vscode.EventEmitter<ConnectionState>();
  private _onMessage = new vscode.EventEmitter<BridgeMessage>();

  readonly onStateChange = this._onStateChange.event;
  readonly onMessage = this._onMessage.event;

  constructor(serverUrl: string, token: string) {
    this.http = new HttpClient(serverUrl, token);
  }

  get state(): ConnectionState {
    return this._state;
  }

  get client(): HttpClient {
    return this.http;
  }

  async connect(): Promise<void> {
    this._state = 'connecting';
    this._onStateChange.fire('connecting');

    try {
      const health = await this.http.health();
      if (health.status !== 'ok' && health.status !== 'healthy') {
        throw new Error(`Server unhealthy: ${health.status}`);
      }

      // Register as a VS Code client
      const hostname = require('os').hostname();
      await this.http.tunnelRegister(`vscode-${hostname}`).catch(() => {
        // tunnel registration is optional — server may not support it
      });

      this._state = 'connected';
      this._onStateChange.fire('connected');

      // Start WebSocket for push events
      const config = vscode.workspace.getConfiguration('coffeeshop');
      const serverUrl = config.get<string>('serverUrl', 'http://10.0.100.232:3777');
      const { getBridgeToken } = require('../config');
      const token = (await getBridgeToken()) ?? '';

      this.ws = new WsClient(serverUrl, token);
      this.ws.on('message', (msg: BridgeMessage) => this._onMessage.fire(msg));
      this.ws.on('stateChange', (state: ConnectionState) => {
        // Only propagate WS disconnect if we were connected
        if (state === 'disconnected' && this._state === 'connected') {
          // WS disconnect doesn't mean HTTP is down — just log it
        }
      });
      this.ws.connect();

      // Periodic health check every 60s
      this.healthTimer = setInterval(async () => {
        try {
          await this.http.health();
        } catch {
          this._state = 'reconnecting';
          this._onStateChange.fire('reconnecting');
        }
      }, 60000);
    } catch (err) {
      this._state = 'disconnected';
      this._onStateChange.fire('disconnected');
      throw err;
    }
  }

  disconnect(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.ws) this.ws.disconnect();
    this._state = 'disconnected';
    this._onStateChange.fire('disconnected');
  }

  dispose(): void {
    this.disconnect();
    this._onStateChange.dispose();
    this._onMessage.dispose();
  }
}
