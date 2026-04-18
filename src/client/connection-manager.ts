import * as vscode from 'vscode';
import * as os from 'os';
import { HttpClient } from './http-client';
import { WsClient } from './ws-client';
import { getConfig, getBridgeToken, onTokenChange } from '../config';
import type { BridgeMessage, ConnectionState } from '../types';

// WebSocket-level ping is the primary liveness check — it round-trips through
// the actual agent channel, so a half-dead TCP socket that still accepts HTTP
// requests will still fail this probe.
const WS_PING_INTERVAL_MS = 15000;
const WS_PING_TIMEOUT_MS = 5000;
// HTTP /health is a secondary signal, run less often. It can't catch a dead
// WS (which is the whole point of this change), but it's useful for detecting
// a totally down daemon before we even try to ping.
const HTTP_HEALTH_INTERVAL_MS = 60000;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
// Circuit breaker: if we fail to re-establish the pipeline this many times
// in a row, we fall back to exponentially-backed-off retries capped at
// CIRCUIT_MAX_DELAY_MS to avoid thrashing the daemon and the UI.
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_MAX_DELAY_MS = 5 * 60 * 1000; // 5 minutes
// Debounce reportFailure so a burst of timeouts doesn't trigger a probe storm.
const FAILURE_PROBE_DEBOUNCE_MS = 2000;

export class ConnectionManager implements vscode.Disposable {
  private http: HttpClient;
  private ws: WsClient | null = null;
  private wsPingTimer: ReturnType<typeof setInterval> | null = null;
  private httpHealthTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  // Circuit breaker: counts consecutive failed connect attempts. Resets on
  // successful connect. When the breaker trips, we switch from the normal
  // RECONNECT_DELAYS ladder to an exponential backoff so repeated daemon
  // outages don't hammer the server.
  private consecutiveConnectFailures = 0;
  private _state: ConnectionState = 'disconnected';
  private _onStateChange = new vscode.EventEmitter<ConnectionState>();
  private _onMessage = new vscode.EventEmitter<BridgeMessage>();
  private disposables: vscode.Disposable[] = [];
  private shouldAutoReconnect = false;
  private lastFailureProbeAt = 0;
  private failureProbeInFlight = false;
  private wsPingInFlight = false;

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
    this.consecutiveConnectFailures = 0;
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

      // Start WebSocket using the same serverUrl as HTTP. We wait for it to
      // reach 'connected' below before flipping our own state, so a WS that
      // fails to upgrade is treated as a failed connect (not a silent success
      // where the extension thinks it's healthy but push is dead).
      this.ws = new WsClient(config.serverUrl, token);
      this.ws.on('message', (msg: BridgeMessage) => this._onMessage.fire(msg));
      this.ws.on('error', () => {}); // Swallow raw errors — stateChange handles fallout
      // WS-aware watchdog: when the push channel drops, rebuild the whole
      // pipeline rather than relying on WsClient's silent self-reconnect
      // (which leaves the extension thinking it's connected).
      this.ws.on('stateChange', (wsState: ConnectionState) => {
        if (!this.shouldAutoReconnect) return;
        if (
          (wsState === 'reconnecting' || wsState === 'disconnected') &&
          this._state === 'connected'
        ) {
          void this.probeAndMaybeReconnect('ws dropped');
        }
      });

      await this.waitForWsConnected(this.ws, 10000);

      this.reconnectAttempt = 0;
      this.consecutiveConnectFailures = 0;
      this.setState('connected');

      // Primary watchdog: WebSocket-level ping with short timeout. If the
      // socket is a TCP zombie (HTTP still answers, but agent channel dead),
      // this is the only probe that will notice.
      this.wsPingTimer = setInterval(() => {
        void this.wsPingCheck();
      }, WS_PING_INTERVAL_MS);

      // Secondary signal: HTTP /health at a slower cadence. Can't catch a
      // dead WS on its own, but detects total daemon outage before the next
      // WS ping tick, and confirms the server is actually up when deciding
      // whether to rebuild WS vs full reconnect.
      this.httpHealthTimer = setInterval(async () => {
        try {
          await this.http.health();
        } catch {
          if (this._state === 'connected') {
            this.setState('reconnecting');
            this.scheduleReconnect();
          }
        }
      }, HTTP_HEALTH_INTERVAL_MS);
    } catch (err) {
      this.consecutiveConnectFailures++;
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
   * Wait for a WsClient to reach the 'connected' state or fail.
   * Resolves on 'connected', rejects on timeout or on a terminal state
   * (disconnected from destruction).
   */
  private waitForWsConnected(ws: WsClient, timeoutMs: number): Promise<void> {
    if (ws.connectionState === 'connected') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeListener('stateChange', onState);
        reject(new Error(`WS connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onState = (s: ConnectionState) => {
        if (s === 'connected') {
          clearTimeout(timer);
          ws.removeListener('stateChange', onState);
          resolve();
        }
      };
      ws.on('stateChange', onState);
      ws.connect();
    });
  }

  /**
   * Run one WS-level ping with a short timeout. On failure, tear down the
   * socket and kick a full reconnect. This is the primary liveness check.
   */
  private async wsPingCheck(): Promise<void> {
    if (this.wsPingInFlight) return;
    if (!this.shouldAutoReconnect) return;
    if (this._state !== 'connected') return;
    if (!this.ws || this.ws.connectionState !== 'connected') {
      // WS isn't even up — let the stateChange handler or probe path handle it.
      void this.probeAndMaybeReconnect('ws not connected at ping tick');
      return;
    }
    this.wsPingInFlight = true;
    try {
      await this.ws.ping(WS_PING_TIMEOUT_MS);
    } catch {
      // Real WS-level failure — the agent channel is dead even if /health
      // still returns 200. Tear down and rebuild the whole pipeline.
      void this.probeAndMaybeReconnect('ws ping failed');
    } finally {
      this.wsPingInFlight = false;
    }
  }

  /**
   * Called by request callers (chat, tools) when a request times out or fails
   * in a way that suggests the connection is actually broken. Kicks an
   * immediate WS-level probe instead of waiting for the next watchdog tick.
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
      // Use WS ping as the authoritative probe — an HTTP /health pass here
      // would be misleading, since the whole point of this fix is that HTTP
      // stays green while the WS is dead.
      if (!this.ws || this.ws.connectionState !== 'connected') {
        this.setState('reconnecting');
        this.scheduleReconnect();
        return;
      }
      try {
        await this.ws.ping(WS_PING_TIMEOUT_MS);
        // WS is alive — false alarm, leave things alone.
      } catch {
        // WS is dead. Tear down the whole pipeline and let doConnect rebuild
        // HTTP + WS together on the reconnect ladder.
        if (this._state === 'connected') {
          this.setState('reconnecting');
          this.scheduleReconnect();
        }
      }
    } finally {
      this.failureProbeInFlight = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = this.nextReconnectDelay();
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

  /**
   * Choose the next reconnect delay.
   *
   * Below the circuit-breaker threshold we walk the normal RECONNECT_DELAYS
   * ladder (fast for transient drops). Once the breaker trips — meaning we've
   * failed N consecutive connect attempts — we switch to an exponential
   * backoff capped at CIRCUIT_MAX_DELAY_MS so a prolonged outage doesn't
   * cause us to hammer the daemon at 30s forever.
   */
  private nextReconnectDelay(): number {
    if (this.consecutiveConnectFailures < CIRCUIT_BREAKER_THRESHOLD) {
      return RECONNECT_DELAYS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ];
    }
    const over = this.consecutiveConnectFailures - CIRCUIT_BREAKER_THRESHOLD;
    const base = RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]; // 30s
    const delay = base * Math.pow(2, over);
    return Math.min(delay, CIRCUIT_MAX_DELAY_MS);
  }

  private teardown(): void {
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
    if (this.httpHealthTimer) {
      clearInterval(this.httpHealthTimer);
      this.httpHealthTimer = null;
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
