import * as http from 'http';
import * as https from 'https';
import type {
  ChatMessage,
  ChatResponse,
  HealthResponse,
  ToolResult,
} from '../types';

export class HttpClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  updateToken(token: string): void {
    this.token = token;
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  async chat(
    messages: ChatMessage[],
    options?: { model?: string; temperature?: number; max_tokens?: number }
  ): Promise<ChatResponse> {
    return this.request<ChatResponse>('POST', '/v1/chat/completions', {
      messages,
      stream: false,
      ...options,
    });
  }

  async *chatStream(
    messages: ChatMessage[],
    options?: { model?: string; temperature?: number; max_tokens?: number }
  ): AsyncGenerator<string> {
    const body = JSON.stringify({
      messages,
      stream: true,
      ...options,
    });

    const url = new URL(this.baseUrl + '/v1/chat/completions');
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const req = mod.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...this.channelHeaders(),
              ...(this.token
                ? { Authorization: `Bearer ${this.token}` }
                : {}),
            },
          },
          resolve
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      }
    );

    if (response.statusCode !== 200) {
      const text = await this.readBody(response);
      throw new Error(`Chat stream failed (${response.statusCode}): ${text}`);
    }

    let buffer = '';
    for await (const chunk of response) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.request<ToolResult>('POST', '/v1/tools/execute', {
      name,
      arguments: args,
    });
  }

  async tunnelRegister(clientId: string): Promise<void> {
    await this.request('POST', '/v1/tunnel/register', {
      clientId,
      clientType: 'vscode',
    });
  }

  private channelHeaders(): Record<string, string> {
    return {
      'X-Channel-Id': 'vscode',
      'X-Client-Name': 'coffeeshop-vscode',
      'X-History-Mode': 'server',
      'X-Bree-Chat-Mode': 'tools',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    return new Promise<T>((resolve, reject) => {
      const req = mod.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...this.channelHeaders(),
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
        },
        async (res) => {
          const text = await this.readBody(res);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`${method} ${path} failed (${res.statusCode}): ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Invalid JSON from ${path}: ${text.slice(0, 200)}`));
          }
        }
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private readBody(res: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(data));
    });
  }
}
