/**
 * 网络：让复用的客户端代码（相对路径 fetch、浏览器式 WebSocket）在 Node 里照常工作。
 * - fetch：/api/... 补上实例地址；发往实例的请求带上 session Cookie 与 Origin（Worker 按 Origin 防跨站）
 * - WebSocket：Node 自带的 WebSocket 支持自定义请求头，同样带上 Cookie 与 Origin（/api/ssh、/api/ssh/sftp 只收同源连接）
 * 只对这个实例的地址加 Cookie，其他地址原样请求。
 */
import { CLIENT_VERSION } from '@cloudssh/core';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

let origin = '';
let session = '';
const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeWebSocket = globalThis.WebSocket;

function sameInstance(url: string): boolean {
  try {
    // WebSocket 地址是 wss://（ws://），源要按 https（http）比
    return new URL(url.replace(/^ws(s?):/i, 'http$1:')).origin === origin;
  } catch {
    return false;
  }
}

function instanceHeaders(): Record<string, string> {
  return {
    Origin: origin,
    'User-Agent': `cloudssh-cli/${CLIENT_VERSION}`,
    ...(session ? { Cookie: `session=${session}` } : {}),
  };
}

/** 设定这次用的实例与会话，并替换全局 fetch / WebSocket */
export function installNetwork(instanceOrigin: string, sessionToken: string): void {
  origin = instanceOrigin;
  session = sessionToken;
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/')) url = origin + url;
    if (!sameInstance(url)) return nativeFetch(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(instanceHeaders())) headers.set(name, value);
    const { credentials: _ignored, ...rest } = init;
    return nativeFetch(url, { ...rest, headers });
  }) as typeof fetch;

  class InstanceWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const href = String(url);
      if (!sameInstance(href)) {
        super(url, protocols);
        return;
      }
      // Node（undici）的 WebSocket 第二个参数可以是 { protocols, headers }
      super(url, { protocols, headers: instanceHeaders() } as unknown as string[]);
    }
  }
  globalThis.WebSocket = InstanceWebSocket as typeof WebSocket;
}

/** 调 CloudSSH 接口，返回 JSON；401 时提示重新登录 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { redirect: 'manual', ...init });
  } catch (error) {
    throw new ApiError(`连不上 ${origin}：${(error as Error).message}`, 0);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.status === 401) {
    throw new ApiError(`登录已失效（${origin}）：运行 cloudssh login，或打开开启了“同步登录给命令行”的桌面客户端`, 401);
  }
  if (!response.ok) {
    const message = (body as { error?: unknown } | null)?.error;
    throw new ApiError(typeof message === 'string' ? message : `HTTP ${response.status}`, response.status);
  }
  return body as T;
}

export function instanceOrigin(): string {
  return origin;
}
