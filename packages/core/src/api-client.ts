import { normalizeWorkerUrl } from './instance';
import { extractSessionFromSetCookie, SESSION_COOKIE_NAME } from './oauth';
import {
  ApiRoutes,
  buildApiUrl,
  buildWebSocketUrl,
  isSameInstanceOrigin,
  originOf,
  webSocketHandshakeHeaders,
} from './routes';
import type { PlatformTransport, WebSocketLike } from './transport';
import type {
  ApiErrorBody,
  ConnectResponse,
  HealthResponse,
  PublicConfig,
  ServerConfig,
  UserInfo,
} from './types';

export class CloudSSHApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | string | null,
    message?: string
  ) {
    super(message ?? CloudSSHApiError.describe(status, body));
    this.name = 'CloudSSHApiError';
  }

  static describe(status: number, body: ApiErrorBody | string | null): string {
    if (body && typeof body === 'object' && typeof body.error === 'string') {
      return `HTTP ${status}: ${body.error}`;
    }
    if (typeof body === 'string' && body) return `HTTP ${status}: ${body.slice(0, 200)}`;
    return `HTTP ${status}`;
  }
}

export interface CloudSSHApiClientOptions {
  baseUrl: string;
  transport: PlatformTransport;
}

/**
 * 平台无关的 CloudSSH Worker API 客户端。
 *
 * 只封装“数据面”接口；终端/SFTP 的二进制协议仍由 UI 层处理（第一版 UI 直接复用网页版）。
 * 自研 UI 或移动 App 可以在此基础上逐步补充。
 */
export class CloudSSHApiClient {
  readonly baseUrl: string;
  private readonly transport: PlatformTransport;

  constructor(options: CloudSSHApiClientOptions) {
    this.baseUrl = normalizeWorkerUrl(options.baseUrl);
    this.transport = options.transport;
  }

  // ---------- 基础 ----------

  private async headers(extra?: HeadersInit, withBody = false): Promise<Headers> {
    const headers = new Headers(extra);
    if (withBody && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (this.transport.sendOriginHeader) {
      headers.set('Origin', originOf(this.baseUrl) ?? this.baseUrl);
    }
    if (this.transport.session) {
      const token = await this.transport.session.get();
      if (token) headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
    }
    return headers;
  }

  /** 发送请求并按 JSON 解析；非 2xx 抛 CloudSSHApiError */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit
  ): Promise<T> {
    const hasBody = body !== undefined;
    const response = await this.transport.fetch(buildApiUrl(this.baseUrl, path), {
      ...init,
      method,
      headers: await this.headers(init?.headers, hasBody),
      body: hasBody ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    await this.captureSession(response);
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new CloudSSHApiError(response.status, parsed as ApiErrorBody | string | null);
    }
    return parsed as T;
  }

  /** 原生平台：从响应的 Set-Cookie 中同步 session（浏览器环境读不到 Set-Cookie，自动跳过） */
  private async captureSession(response: Response): Promise<void> {
    const store = this.transport.session;
    if (!store) return;
    const raw = response.headers.get('set-cookie');
    if (!raw) return;
    const token = extractSessionFromSetCookie(raw);
    if (token === null) return;
    await store.set(token || null);
  }

  // ---------- 公共接口 ----------

  getConfig(): Promise<PublicConfig> {
    return this.request<PublicConfig>('GET', ApiRoutes.config);
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', ApiRoutes.health);
  }

  /** 未登录返回 null（401），其他错误照常抛出 */
  async me(): Promise<UserInfo | null> {
    try {
      return await this.request<UserInfo>('GET', ApiRoutes.authMe);
    } catch (error) {
      if (error instanceof CloudSSHApiError && error.status === 401) return null;
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.request('POST', ApiRoutes.authLogout);
    await this.transport.session?.set(null);
  }

  // ---------- 服务器 ----------

  listServers(): Promise<ServerConfig[]> {
    return this.request<ServerConfig[]>('GET', ApiRoutes.servers);
  }

  deleteServer(id: number): Promise<unknown> {
    return this.request('DELETE', ApiRoutes.server(id));
  }

  /**
   * 申请一次性 SSH 连接地址。服务端返回的 wsUrl 必须与实例同源，
   * 与网页版对 wsUrl 的校验保持一致，防止被诱导连到第三方地址。
   */
  async connectServer(id: number): Promise<ConnectResponse> {
    const result = await this.request<ConnectResponse>('POST', ApiRoutes.serverConnect(id));
    if (!result?.wsUrl || !isSameInstanceOrigin(result.wsUrl, this.baseUrl)) {
      throw new CloudSSHApiError(502, null, '服务端返回的连接地址与实例不同源，已拒绝');
    }
    return result;
  }

  // ---------- WebSocket ----------

  /** 原生平台打开 WebSocket（自动附带 Origin/Cookie 握手头）。浏览器里直接 new WebSocket 即可。 */
  async openWebSocket(urlOrPath: string): Promise<WebSocketLike> {
    const factory = this.transport.webSocket;
    if (!factory) throw new Error('当前平台没有提供 WebSocketFactory');
    const url = urlOrPath.startsWith('/') ? buildWebSocketUrl(this.baseUrl, urlOrPath) : urlOrPath;
    if (!isSameInstanceOrigin(url, this.baseUrl)) {
      throw new Error('拒绝连接到与实例不同源的 WebSocket 地址');
    }
    const token = (await this.transport.session?.get()) ?? undefined;
    return factory.create(url, webSocketHandshakeHeaders(this.baseUrl, token));
  }
}
