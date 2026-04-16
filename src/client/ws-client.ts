import { EventEmitter } from 'events';
import * as http from 'http';
import * as crypto from 'crypto';
import type { BridgeMessage, ConnectionState } from '../types';

/**
 * Minimal WebSocket client using raw HTTP upgrade.
 * No external dependencies — follows coffeeshop-server's zero-dep pattern.
 */
export class WsClient extends EventEmitter {
  private url: string;
  private token: string;
  private socket: import('net').Socket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(serverUrl: string, token: string) {
    super();
    const wsUrl = serverUrl.replace(/^http/, 'ws');
    this.url = `${wsUrl}/ws?token=${encodeURIComponent(token)}`;
    this.token = token;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.destroyed) return;
    this.setState('connecting');

    const parsed = new URL(this.url);
    const key = crypto.randomBytes(16).toString('base64');

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (_res, socket, _head) => {
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
        // Simple text frame parser (no fragmentation support needed for JSON messages)
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
            // Text frame
            try {
              const msg = JSON.parse(payload.toString()) as BridgeMessage;
              this.emit('message', msg);
            } catch {
              // ignore malformed messages
            }
          } else if (opcode === 0x08) {
            // Close frame
            socket.end();
          } else if (opcode === 0x09) {
            // Ping — send pong
            this.sendFrame(0x0a, payload);
          }
        }
      });

      socket.on('close', () => this.handleDisconnect());
      socket.on('error', () => this.handleDisconnect());
    });

    req.on('error', () => this.handleDisconnect());
    req.end();
  }

  send(msg: BridgeMessage): void {
    if (!this.socket || this.state !== 'connected') return;
    const data = Buffer.from(JSON.stringify(msg));
    this.sendFrame(0x01, data);
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
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.setState('disconnected');
  }

  private handleDisconnect(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.socket = null;

    if (this.destroyed) {
      this.setState('disconnected');
      return;
    }

    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
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
