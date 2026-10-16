/**
 * Origin bridge：让本地 UI“住在” Worker 的 origin 下。
 *
 * 做法：在实例专属会话上用 protocol.handle('https') 接管 https 请求——
 *   - 发往 Worker origin、且不是 /api/* 的 GET/HEAD：返回本地 UI 文件（或转发到 UI 开发服务器）
 *   - 其余所有请求（/api/*、GitHub 头像、字体、Turnstile……）：用同一会话原样透传到网络
 *
 * 这样页面的 origin 就是 https://<worker>，于是：
 *   - 前端相对路径 /api、location.origin、同源校验全部不用改
 *   - HttpOnly session Cookie 存在该会话的 Cookie 罐里，透传请求自动携带/更新
 *   - WebSocket（wss://）不经过协议拦截，由 Chromium 直接发出，Origin 天然就是 Worker origin
 *
 * 透传注意点（已对真实 Worker 验证）：
 *   - 被拦截请求的 headers 里没有 Origin（Chromium 在网络层才补），对 Worker 的非 GET 请求需显式补上，
 *     否则 /api/auth/password/login 这类强制同源校验的接口会 403
 *   - net.fetch 不支持 redirect:'manual'（会直接报错），只能跟随重定向；重定向链上的 Set-Cookie 仍会写入会话
 *   - 不能强制 credentials:'include'：跨域字体请求会因 ACAO:* 被 CORS 拒绝
 */
import { isApiPath, originOf } from '@cloudssh/core';
import type { Session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger';
import type { ResolvedUi } from '../ui/providers';

const log = createLogger('bridge');

interface BridgeState {
  origin: string;
  ui: Exclude<ResolvedUi, { kind: 'remote' }>;
}

const states = new WeakMap<Session, BridgeState>();
const handled = new WeakSet<Session>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** 与 Worker 返回页面时的安全头保持一致 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * 根据实例 UI 配置挂载/卸载 bridge。remote 模式完全不拦截（零开销、原生行为）。
 * 修改后需要重新加载该实例的窗口才会生效。
 */
export function applyOriginBridge(ses: Session, baseUrl: string, ui: ResolvedUi): void {
  const origin = originOf(baseUrl);
  if (!origin) throw new Error(`Invalid base URL: ${baseUrl}`);

  if (ui.kind === 'remote') {
    states.delete(ses);
    if (handled.has(ses)) {
      ses.protocol.unhandle('https');
      handled.delete(ses);
      log.info('已卸载 origin bridge（remote 模式）', origin);
    }
    return;
  }

  states.set(ses, { origin, ui });
  if (!handled.has(ses)) {
    ses.protocol.handle('https', (request) => handleRequest(ses, request));
    handled.add(ses);
  }
  log.info('origin bridge 已就绪', origin, '→', ui.kind === 'static' ? ui.root : ui.target);
}

async function handleRequest(ses: Session, request: Request): Promise<Response> {
  const state = states.get(ses);
  const url = new URL(request.url);
  if (state && url.origin === state.origin && !isApiPath(url.pathname) && SAFE_METHODS.has(request.method)) {
    try {
      return state.ui.kind === 'static'
        ? await serveStatic(state.ui.root, url, request.method)
        : await proxyDevServer(ses, state.ui.target, url, request);
    } catch (error) {
      log.error('本地 UI 响应失败', url.pathname, error);
      return new Response(`CloudSSH 客户端无法提供本地 UI：${(error as Error).message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }
  return passThrough(ses, request, state?.origin);
}

async function passThrough(ses: Session, request: Request, instanceOrigin?: string): Promise<Response> {
  const url = new URL(request.url);
  let forwarded = request;
  if (instanceOrigin && url.origin === instanceOrigin && !SAFE_METHODS.has(request.method)) {
    if (!request.headers.has('origin')) {
      const headers = new Headers(request.headers);
      headers.set('origin', instanceOrigin);
      forwarded = new Request(request, { headers });
    }
  }
  try {
    // 不覆盖 credentials：沿用请求自身的模式。同源请求没有 Origin 时 Electron 会按 include 处理（带 Cookie）；
    // 跨域 CORS 请求（字体等）自带 Origin，若强制 include 会因 ACAO:* 校验失败。
    return await ses.fetch(forwarded, { bypassCustomProtocolHandlers: true } as RequestInit);
  } catch (error) {
    log.warn('透传请求失败', request.method, url.origin + url.pathname, (error as Error).message);
    throw error;
  }
}

function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const target = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) return null;
  return target;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function serveStatic(root: string, url: URL, method: string): Promise<Response> {
  let file = resolveInside(root, url.pathname);
  if (!file) return new Response('Bad Request', { status: 400 });

  const ext = path.extname(file).toLowerCase();
  let isEntry = false;
  if (!(await isFile(file))) {
    // 带扩展名的静态资源找不到就是 404；其余路径按 SPA 回退到 index.html
    if (ext && ext !== '.html') return new Response('Not Found', { status: 404 });
    file = path.join(root, 'index.html');
    isEntry = true;
  } else if (path.basename(file) === 'index.html') {
    isEntry = true;
  }

  const body = method === 'HEAD' ? null : await fs.readFile(file);
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  headers.set(
    'Cache-Control',
    !isEntry && url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  );
  return new Response(body, { status: 200, headers });
}

async function proxyDevServer(ses: Session, target: string, url: URL, request: Request): Promise<Response> {
  const upstream = await ses.fetch(`${target}${url.pathname}${url.search}`, {
    method: request.method,
    headers: { accept: request.headers.get('accept') ?? '*/*' },
    bypassCustomProtocolHandlers: true,
  } as RequestInit);
  const headers = new Headers(upstream.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(request.method === 'HEAD' ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers,
  });
}
