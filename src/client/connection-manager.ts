import * as vscode from 'vscode';
import * as os from 'os';
import { HttpClient } from './http-client';
import { WsClient } from './ws-client';
import { getConfig, getBridgeToken, onTokenChange } from '../config';
import type { BridgeMessage, ConnectionState } from '../types';

const HEALTH_INTERVAL_MS = 15000;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
// Debounce reportFailure so a burst of timeouts doesn't trigger a probe storm.
const FAILURE_PROBE_DEBOUNCE_MS = 2000;

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
  private lastFailureProbeAt = 0;
  private failureProbeInFlight = false;

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

    // Re-read config on every connect so serverUrl changes take effect
    const config = getConfig();
    const token = (await getBridgeToken()) ?? '';

    // Rebuild HTTP client with current config
    this.http = new HttpClient(config.serverUrl, token);

    this.setState('connecting');

    try {
      const health = await this.http.health();
      if (health.status !== 'ok' && health.status !== 'healthy') {
        throw new Error(`Server unhealthy: ${health.status}`);
      }

      await this.http.tunnelRegister(`vscode-${os.hostname()}`).catch(() => {});

      this.reconnectAttempt = 0;
      this.setState('connected');

      // Start WebSocket using the same serverUrl as HTTP
      this.ws = new WsClient(config.serverUrl, token);
      this.ws.on('message', (msg: BridgeMessage) => this._onMessage.fire(msg));
      this.ws.on('error', () => {}); // Swallow raw errors — stateChange handles fallout
      // WS-aware watchdog: when the push channel drops, verify HTTP health and
      // tear down / rebuild the whole pipeline rather than relying on WsClient's
      // silent self-reconnect (which leaves the extension thinking it's connected).
      this.ws.on('stateChange', (wsState: ConnectionState) => {
        if (!this.shouldAutoReconnect) return;
        if (
          (wsState === 'reconnecting' || wsState === 'disconnected') &&
          this._state === 'connected'
        ) {
          void this.probeAndMaybeReconnect('ws dropped');
        }
      });
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

  /**
   * Called by request callers (chat, tools) when a request times out or fails
   * in a way that suggests the connection is actually broken. Kicks an
   * immediate health probe instead of waiting for the next watchdog tick.
   * Debounced so a burst of timeouts doesn't spam the daemon.
   */
  reportFailure(_err?: unknown): void {
    if (!this.shouldAutoReconnect) return;
    if (this._state !== 'connected') return; // already handling
    const now = Date.now();
    if (now - this.lastFailureProbeAt < FAILURE_PROBE_DEBOUNCE_MS) return;
    this.lastFailureProbeAt = now;
    void this.probeAndMaybeReconnect('request failure reported');
  }

  private async probeAndMaybeReconnect(_reason: string): Promise<void> {
    if (this.failureProbeInFlight) return;
    if (!this.shouldAutoReconnect) return;
    if (this._state !== 'connected') return;
    this.failureProbeInFlight = true;
    try {
      await this.http.health();
      // HTTP is fine but WS dropped — rebuild just the WS so push works again.
      if (this.ws && this.ws.connectionState !== 'connected') {
        try { this.ws.disconnect(); } catch { /* ignore */ }
        this.ws = null;
        // Full reconnect is cleaner than hand-patching WS — tear down the
        // whole pipeline and let doConnect re-establish HTTP + WS together.
        this.setState('reconnecting');
        this.scheduleReconnect();
      }
    } catch {
      // Health probe failed — treat as a real drop.
      if (this._state === 'connected') {
        this.setState('reconnecting');
        this.scheduleReconnect();
      }
    } finally {
      this.failureProbeInFlight = false;
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
