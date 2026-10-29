// HTTP client for the backend's control plane (/teamclaude/*). Built on
// node:http rather than fetch so the request carries exactly the headers set
// here: the control plane refuses requests that look like they came from a web
// page (Origin / Sec-Fetch-Site), and a desktop app is not one.
//
// The legacy /teamclaude/ prefix is used on purpose: every backend version
// answers to it, while /teamrouter/ exists only from the rename onward.

import http from 'node:http';

export type ControlPath =
  | '/teamclaude/reload'
  | '/teamclaude/probe'
  | '/teamclaude/switch'
  | '/teamclaude/priority'
  | '/teamclaude/disable'
  | '/teamclaude/threshold';

export type ProbeResult =
  | { kind: 'teamclaude'; raw: Record<string, unknown> }
  | { kind: 'foreign'; detail: string }
  | { kind: 'auth-required'; detail: string }
  | { kind: 'down'; detail: string };

export interface ControlResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  error: string | null;
}

interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface Requester {
  (options: { host: string; port: number; method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<RawResponse>;
}

const MAX_BODY = 8 * 1024 * 1024;

/** Default requester: one node:http request with a hard timeout and size cap. */
export const httpRequester: Requester = ({ host, port, method, path, headers, body, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path, headers, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

export interface BackendClientOptions {
  host: string;
  port: number;
  apiKey: string | null;
  timeoutMs?: number;
  requester?: Requester;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Does this look like a /teamclaude/status payload rather than some other server's JSON? */
export function looksLikeStatus(body: Record<string, unknown> | null): body is Record<string, unknown> {
  return !!body && Array.isArray(body.accounts) && ('switchThreshold' in body || 'server' in body);
}

export class BackendClient {
  readonly host: string;
  readonly port: number;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly request: Requester;

  constructor(options: BackendClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.request = options.requester ?? httpRequester;
  }

  get baseUrl(): string {
    const host = this.host.includes(':') ? `[${this.host}]` : this.host;
    return `http://${host}:${this.port}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json',
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      ...extra,
    };
  }

  /** Ask who answers on the port. Never throws. */
  async probe(): Promise<ProbeResult> {
    let res: RawResponse;
    try {
      res = await this.request({
        host: this.host, port: this.port, method: 'GET', path: '/teamclaude/status',
        headers: this.headers(), timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { kind: 'down', detail: code ?? (err as Error).message };
    }
    const body = parseObject(res.body);
    if (res.status === 200 && looksLikeStatus(body)) return { kind: 'teamclaude', raw: body };
    if (res.status === 401 && body && typeof body.error === 'object') {
      return { kind: 'auth-required', detail: 'the proxy asks for an API key (proxy.apiKey) this app could not read' };
    }
    return { kind: 'foreign', detail: `HTTP ${res.status} from a server that is not TeamClaude` };
  }

  /** POST a control action. Never throws; errors come back in the result. */
  async post(path: ControlPath, body?: Record<string, unknown>): Promise<ControlResult> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    try {
      const res = await this.request({
        host: this.host, port: this.port, method: 'POST', path,
        headers: this.headers(payload === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        }),
        body: payload,
        timeoutMs: path === '/teamclaude/probe' ? Math.max(this.timeoutMs, 60_000) : this.timeoutMs,
      });
      const parsed = parseObject(res.body);
      const ok = res.status >= 200 && res.status < 300 && parsed?.ok !== false;
      const error = ok ? null : (typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.status}`);
      return { ok, status: res.status, body: parsed, error };
    } catch (err) {
      return { ok: false, status: 0, body: null, error: (err as Error).message };
    }
  }
}
