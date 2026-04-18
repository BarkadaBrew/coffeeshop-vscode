import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import type { BridgeMessage, ConnectionState } from '../types';

/**
 * Minimal WebSocket client using raw HTTP upgrade.
 * Supports both ws:// and wss:// (HTTP and HTTPS upgrades).
 * Token sent via Authorization header.
 */
export class WsClient extends EventEmitter {
  private serverUrl: string;
  private token: string;
  private socket: import('net').Socket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private disconnecting = false; // guard against duplicate handleDisconnect
  // Pending WS-level pings awaiting pong. Keyed by a short nonce carried in
  // the ping payload so we can correlate request/response across overlapping
  // health probes.
  private pendingPings = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(serverUrl: string, token: string) {
    super();
    this.serverUrl = serverUrl;
    this.token = token;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.destroyed) return;
    this.disconnecting = false;
    this.setState('connecting');

    const wsUrl = this.serverUrl.replace(/^http/, 'ws');
    const parsed = new URL(`${wsUrl}/ws`);
    const isSecure = parsed.protocol === 'wss:';
    const mod = isSecure ? https : http;
    const defaultPort = isSecure ? 443 : 80;
    const key = crypto.randomBytes(16).toString('base64');

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || defaultPort,
      path: parsed.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(this.token
          ? { Authorization: `Bearer ${this.token}` }
          : {}),
      },
    });

    // Handle non-upgrade HTTP responses (401, 404, etc.)
    req.on('response', (res) => {
      res.resume(); // drain
      this.handleDisconnect();
    });

    req.on('upgrade', (_res, socket, _head) => {
      // Skip Sec-WebSocket-Accept validation — trusted LAN server
      // (daemon uses a non-standard GUID in its accept key computation)
      this.socket = socket;
      this.reconnectDelay = 1000;
      this.setState('connected');

      // Ping every 30s to keep alive
      this.pingInterval = setInterval(() => {
        this.send({ type: 'ping', payload: {}, timestamp: Date.now() });
      }, 30000);

      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const secondByte = buffer[1] & 0x7f;
          let payloadLength = secondByte;
          let offset = 2;

          if (secondByte === 126) {
            if (buffer.length < 4) break;
            payloadLength = buffer.readUInt16BE(2);
            offset = 4;
          } else if (secondByte === 127) {
            if (buffer.length < 10) break;
            payloadLength = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          if (buffer.length < offset + payloadLength) break;

          const opcode = buffer[0] & 0x0f;
          const payload = buffer.subarray(offset, offset + payloadLength);
          buffer = buffer.subarray(offset + payloadLength);

          if (opcode === 0x01) {
            try {
              const msg = JSON.parse(payload.toString()) as BridgeMessage;
              this.emit('message', msg);
            } catch {
              // ignore malformed messages
            }
          } else if (opcode === 0x08) {
            socket.end();
          } else if (opcode === 0x09) {
            // Peer ping — reply with pong echoing the payload
            this.sendFrame(0x0a, payload);
          } else if (opcode === 0x0a) {
            // Pong — resolve any matching pending ping. The nonce was written
            // as UTF-8 text into the ping payload; the server echoes it back.
            const nonce = payload.toString('utf8');
            this.resolvePing(nonce);
            this.emit('pong', nonce);
          }
        }
      });

      socket.on('close', () => this.handleDisconnect());
      socket.on('error', () => this.handleDisconnect());
    });

    req.on('error', () => this.handleDisconnect());
    req.setTimeout(10000, () => {
      req.destroy();
      // Don't call handleDisconnect here — req.on('error') will fire
    });
    req.end();
  }

  send(msg: BridgeMessage): void {
    if (!this.socket || this.state !== 'connected') return;
    const data = Buffer.from(JSON.stringify(msg));
    this.sendFrame(0x01, data);
  }

  /**
   * Send a WebSocket-level ping frame and await the matching pong.
   * Rejects on timeout, on socket error, or if the socket isn't connected.
   *
   * This is the real liveness check — unlike the HTTP /health endpoint,
   * this round-trips through the actual agent channel. If the socket is a
   * half-dead TCP zombie, this will time out even though /health returns 200.
   */
  ping(timeoutMs = 5000): Promise<void> {
    if (!this.socket || this.state !== 'connected') {
      return Promise.reject(new Error('WS not connected'));
    }
    const nonce = crypto.randomBytes(6).toString('hex');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(nonce);
        reject(new Error(`WS ping timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingPings.set(nonce, { resolve, reject, timer });
      try {
        this.sendFrame(0x09, Buffer.from(nonce, 'utf8'));
      } catch (err) {
        this.pendingPings.delete(nonce);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private resolvePing(nonce: string): void {
    const pending = this.pendingPings.get(nonce);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPings.delete(nonce);
    pending.resolve();
  }

  private rejectAllPings(reason: string): void {
    for (const [, pending] of this.pendingPings) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingPings.clear();
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (!this.socket) return;

    // Client frames must be masked per RFC 6455
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payload.length;
      mask.copy(header, 2);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      mask.copy(header, 10);
    }

    this.socket.write(Buffer.concat([header, masked]));
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAllPings('WS disconnected');
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.setState('disconnected');
  }

  private handleDisconnect(): void {
    // Guard: only process once per disconnect event
    if (this.disconnecting) return;
    this.disconnecting = true;

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.rejectAllPings('WS disconnected');
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    if (this.destroyed) {
      this.setState('disconnected');
      return;
    }

    this.setState('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.maxReconnectDelay
      );
      this.connect();
    }, this.reconnectDelay);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('stateChange', state);
  }
}
