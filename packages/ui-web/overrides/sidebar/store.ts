/**
 * 侧栏数据源：旁听网页版自己的 /api/servers 请求，不额外加请求。
 * - GET /api/servers 成功 → 更新列表（网页版增删改后都会重新拉取）
 * - POST /api/servers/:id/connect 成功 → 本地刷新该节点的最近连接时间
 * - DELETE /api/servers/:id 成功 → 本地去掉（网页版删除后只改自己的列表，不重新拉取）
 * - 登出 / /api/auth/me 返回 401 → 清空（侧栏隐藏）
 * - 连接后识别出系统（cloudssh:os-detected，构建钩子发出）→ 本地更新该节点的系统图标
 * 除最后一项外只依赖公开的 HTTP 接口约定，不依赖上游内部实现。
 */
import type { ServerConfig } from '@cloudssh/core';

type Listener = () => void;

let servers: ServerConfig[] | null = null;
const listeners = new Set<Listener>();
const nativeFetch = window.fetch.bind(window);

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[cloudssh-sidebar]', error);
    }
  }
}

/**
 * 拿到列表（来自网页版的请求、主动拉取或本地更新，不含 primeServers）时调用：shared/boot.ts 写进缓存、记下最近一次拿到的时间。
 * unchanged：和手上的一模一样（定时刷新多半如此）
 */
let persist: ((next: ServerConfig[] | null, unchanged: boolean) => void) | null = null;

function sameServers(a: ServerConfig[] | null, b: ServerConfig[] | null): boolean {
  return a !== null && b !== null && a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** 内容没变就不通知（不重画侧栏、列表，不打断选中、滚动、菜单） */
function setServers(next: ServerConfig[] | null): boolean {
  const unchanged = sameServers(next, servers) || (next === null && servers === null);
  servers = next;
  if (!unchanged) emit();
  try {
    persist?.(next, unchanged);
  } catch {
    // 写缓存失败不影响列表
  }
  return !unchanged;
}

export function getServers(): ServerConfig[] | null {
  return servers;
}

/** 启动时用缓存的列表先填上（还没有列表时才填，不触发写缓存）；之后网页版的请求照常覆盖 */
export function primeServers(cached: ServerConfig[]): void {
  if (servers !== null) return;
  servers = cached;
  emit();
}

/** 清空列表（启动时用缓存填上、随后发现没登录或登录失效时） */
export function resetServers(): void {
  if (servers !== null) setServers(null);
}

export function setServerPersistor(fn: ((next: ServerConfig[] | null, unchanged: boolean) => void) | null): void {
  persist = fn;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 主动拉取（侧栏的刷新按钮、定时刷新）：changed 拿到了且有变化，same 拿到了但没变，unauthorized 没登录 / 登录失效；网络不通时抛错 */
export async function reloadServers(): Promise<'changed' | 'same' | 'unauthorized' | 'failed'> {
  const response = await nativeFetch('/api/servers', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) {
    setServers(null);
    return 'unauthorized';
  }
  if (!response.ok) return 'failed';
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) return 'failed';
  return setServers(data as ServerConfig[]) ? 'changed' : 'same';
}

function requestInfo(input: RequestInfo | URL, init?: RequestInit): { method: string; path: string } | null {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return null;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    return { method, path: url.pathname };
  } catch {
    return null;
  }
}

function observe(info: { method: string; path: string }, response: Response): void {
  const { method, path } = info;
  if (path === '/api/servers' && method === 'GET' && response.ok) {
    response
      .clone()
      .json()
      .then((data: unknown) => {
        if (Array.isArray(data)) setServers(data as ServerConfig[]);
      })
      .catch(() => undefined);
    return;
  }
  const connect = /^\/api\/servers\/(\d+)\/connect$/.exec(path);
  if (connect && method === 'POST' && response.ok && servers) {
    const id = Number(connect[1]);
    setServers(servers.map((server) => (server.id === id ? { ...server, last_connected_at: Date.now() } : server)));
    return;
  }
  const removed = /^\/api\/servers\/(\d+)$/.exec(path);
  if (removed && method === 'DELETE' && response.ok && servers) {
    const id = Number(removed[1]);
    setServers(servers.filter((server) => server.id !== id));
    return;
  }
  if ((path === '/api/auth/logout' && method === 'POST') || (path === '/api/auth/me' && response.status === 401)) {
    setServers(null);
  }
}

/** 连接后识别出系统（构建钩子在网页版 updateServerOS 里发出）：立即更新这台服务器的系统 */
window.addEventListener('cloudssh:os-detected', (event) => {
  const { serverId, os } = (event as CustomEvent<{ serverId: number; os: string | null }>).detail ?? {};
  if (!servers || typeof serverId !== 'number') return;
  const current = servers.find((server) => server.id === serverId);
  if (!current || current.os === os) return;
  setServers(servers.map((server) => (server.id === serverId ? { ...server, os } : server)));
});

export function installFetchObserver(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(input, init);
    const info = requestInfo(input, init);
    if (info && info.path.startsWith('/api/')) {
      try {
        observe(info, response);
      } catch {
        // 旁听失败不影响网页版自身
      }
    }
    return response;
  };
}
