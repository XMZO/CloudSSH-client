/**
 * 侧栏数据源：旁听网页版自己的 /api/servers 请求，不额外加请求。
 * - GET /api/servers 成功 → 更新列表（网页版增删改后都会重新拉取）
 * - POST /api/servers/:id/connect 成功 → 本地刷新该节点的最近连接时间
 * - 登出 / /api/auth/me 返回 401 → 清空（侧栏隐藏）
 * 只依赖公开的 HTTP 接口约定，不依赖上游内部实现。
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

function setServers(next: ServerConfig[] | null): void {
  servers = next;
  emit();
}

export function getServers(): ServerConfig[] | null {
  return servers;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 主动拉取（例如侧栏的刷新按钮） */
export async function reloadServers(): Promise<void> {
  const response = await nativeFetch('/api/servers', { credentials: 'same-origin' });
  if (response.status === 401) setServers(null);
  else if (response.ok) setServers((await response.json()) as ServerConfig[]);
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
  if ((path === '/api/auth/logout' && method === 'POST') || (path === '/api/auth/me' && response.status === 401)) {
    setServers(null);
  }
}

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
