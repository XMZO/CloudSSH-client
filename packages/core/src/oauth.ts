/**
 * GitHub OAuth 登录流程规则（与服务端 handleGitHubAuth / handleGitHubCallback 对齐）。
 *
 * 流程：GET /api/auth/github → 302 GitHub 授权页（写 oauth_state Cookie）
 *      → GitHub 302 回 /api/auth/callback?code&state（BASE_URL 未设置时回调地址即请求 origin）
 *      → 服务端校验 state、写 HttpOnly `session` Cookie → 302 回 BASE_URL 或 `/`。
 *
 * 因为回调地址固定为 Worker 自己的域名，客户端必须在“与 Worker 同一个 Cookie 罐”的
 * 浏览器环境里完成整个流程，再把 `session` Cookie 交给后续请求使用。
 * 桌面端在独立登录窗口完成后迁移 Cookie；移动端可在 WebView/ASWebAuthenticationSession 中
 * 完成后从 Cookie 存储里取出 `session`。
 */

import { ApiRoutes, buildApiUrl, isSameInstanceOrigin } from './routes';

export const SESSION_COOKIE_NAME = 'session';
export const OAUTH_STATE_COOKIE_NAME = 'oauth_state';
/** 服务端写入的 session Cookie 有效期（秒），与 auth.ts 中 Max-Age=604800 一致 */
export const SESSION_COOKIE_MAX_AGE_SEC = 604_800;

export function githubLoginUrl(baseUrl: string): string {
  return buildApiUrl(baseUrl, ApiRoutes.authGithub);
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** 是否为发起 GitHub 登录的地址（网页版点击“使用 GitHub 登录”时导航到这里） */
export function isGitHubLoginStart(url: string, baseUrl: string): boolean {
  const parsed = parse(url);
  return !!parsed && isSameInstanceOrigin(url, baseUrl) && parsed.pathname === ApiRoutes.authGithub;
}

export function isOAuthCallback(url: string, baseUrl: string): boolean {
  const parsed = parse(url);
  return !!parsed && isSameInstanceOrigin(url, baseUrl) && parsed.pathname === ApiRoutes.authCallback;
}

/**
 * 回调成功后服务端会 302 回实例根（或 BASE_URL）。
 * 认为“回到实例 origin 且不在 /api/auth/ 下”即登录流程已走完。
 */
export function isPostLoginLanding(url: string, baseUrl: string): boolean {
  const parsed = parse(url);
  if (!parsed || !isSameInstanceOrigin(url, baseUrl)) return false;
  return !parsed.pathname.startsWith('/api/auth/');
}

/** 从 Set-Cookie 头里取出 session 值（原生平台自行管理 Cookie 时使用）；删除 Cookie 时返回空串 */
export function extractSessionFromSetCookie(setCookie: string | string[]): string | null {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of values) {
    for (const part of header.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
      const [pair] = part.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      if (pair.slice(0, eq).trim() === SESSION_COOKIE_NAME) return pair.slice(eq + 1).trim();
    }
  }
  return null;
}
