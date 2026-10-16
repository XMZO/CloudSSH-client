/**
 * CloudSSH Worker 接口路由与同源规则。
 *
 * 服务端约束（见 CloudSSH 仓库 src/worker/index.ts、src/worker/auth.ts）：
 * - `/api/ssh`、`/api/ssh/sftp` 的 WebSocket 升级要求 `Origin` 头存在且与请求 URL 同源，否则 403。
 * - `/api/auth/password/login` 要求同源 Origin；AI 配置、移动端快捷键等写接口在带 Origin 时必须同源。
 * - 登录依赖 OAuth 回调写入的 HttpOnly `session` Cookie（SameSite=Lax、Secure）。
 * - 前端所有 `/api` 请求与 WebSocket 都使用相对同源路径。
 *
 * 结论：任何客户端都应让请求“看起来来自 Worker 自己的 origin”。
 * 浏览器/WebView 里把页面放在 Worker origin 下即可；原生 HTTP/WebSocket 客户端需手动带上
 * `Origin: <baseUrl>` 与 `Cookie: session=...`。
 */

export const API_PREFIX = '/api/';

export const ApiRoutes = {
  config: '/api/config',
  health: '/api/health',
  verify: '/api/verify',
  authGithub: '/api/auth/github',
  authCallback: '/api/auth/callback',
  authLogout: '/api/auth/logout',
  authMe: '/api/auth/me',
  authPasswordLogin: '/api/auth/password/login',
  servers: '/api/servers',
  server: (id: number) => `/api/servers/${id}`,
  serverConnect: (id: number) => `/api/servers/${id}/connect`,
  serverMemory: (id: number) => `/api/servers/${id}/memory`,
  serverShares: (id: number) => `/api/servers/${id}/shares`,
  share: (shareId: string) => `/api/shares/${encodeURIComponent(shareId)}`,
  shareAudit: (shareId: string) => `/api/shares/${encodeURIComponent(shareId)}/audit`,
  shareClaim: '/api/share/claim',
  userTheme: '/api/user/theme',
  mobileShortcuts: '/api/user/mobile-shortcuts',
  knownHosts: '/api/known-hosts',
  snippets: '/api/snippets',
  snippet: (id: number) => `/api/snippets/${id}`,
  aiConfig: '/api/ai/config',
  aiModels: '/api/ai/models',
  ssh: '/api/ssh',
  sshSftp: '/api/ssh/sftp',
} as const;

/** 需要同源 Origin 才能通过的 WebSocket 路径 */
export const WEBSOCKET_PATHS: readonly string[] = [ApiRoutes.ssh, ApiRoutes.sshSftp];

/** 是否为 Worker API 路径（`/api` 或 `/api/...`） */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith(API_PREFIX);
}

export function isWebSocketPath(pathname: string): boolean {
  return WEBSOCKET_PATHS.includes(pathname);
}

/** 取 URL 的 origin；无法解析返回 null */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * 判断 URL 是否属于实例 origin。`wss://host` 与 `https://host`（以及 ws/http）视为同源，
 * 与网页版 main.ts 对一次性连接地址的校验口径一致。
 */
export function isSameInstanceOrigin(url: string, baseUrl: string): boolean {
  const base = originOf(baseUrl);
  if (!base) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const scheme = target.protocol.replace(/^ws(s?):$/, 'http$1:');
  return `${scheme}//${target.host}` === base;
}

/** 由实例根地址拼出完整 HTTP URL */
export function buildApiUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | undefined>
): string {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** 由实例根地址拼出 WebSocket URL（https→wss，http→ws） */
export function buildWebSocketUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | undefined>
): string {
  const url = new URL(buildApiUrl(baseUrl, path, params));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** 原生（非浏览器）客户端发起 WebSocket 时必须携带的握手头 */
export function webSocketHandshakeHeaders(
  baseUrl: string,
  sessionCookie?: string
): Record<string, string> {
  const origin = originOf(baseUrl);
  if (!origin) throw new Error(`Invalid base URL: ${baseUrl}`);
  const headers: Record<string, string> = { Origin: origin };
  if (sessionCookie) headers.Cookie = `session=${sessionCookie}`;
  return headers;
}
