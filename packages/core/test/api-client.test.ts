import { describe, expect, it } from 'vitest';
import { CloudSSHApiClient, CloudSSHApiError, type FetchLike, type SessionStore } from '../src';

const BASE = 'https://cloudssh.example.workers.dev';

function mockFetch(handler: (url: string, init: RequestInit) => Response): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function memorySession(initial: string | null = null): SessionStore & { value: string | null } {
  return {
    value: initial,
    async get() {
      return this.value;
    },
    async set(token) {
      this.value = token;
    },
  };
}

describe('CloudSSHApiClient', () => {
  it('浏览器模式：不手动加 Origin/Cookie', async () => {
    const { fetch, calls } = mockFetch(() => Response.json({ authMode: 'github' }));
    const client = new CloudSSHApiClient({ baseUrl: BASE, transport: { fetch } });
    await client.getConfig();
    const headers = new Headers(calls[0].init.headers);
    expect(calls[0].url).toBe(`${BASE}/api/config`);
    expect(headers.has('Origin')).toBe(false);
    expect(headers.has('Cookie')).toBe(false);
  });

  it('原生模式：带同源 Origin 与 session Cookie，并同步 Set-Cookie', async () => {
    const session = memorySession('old');
    const { fetch, calls } = mockFetch(
      () => new Response('{"success":true}', { headers: { 'set-cookie': 'session=; Path=/; Max-Age=0' } })
    );
    const client = new CloudSSHApiClient({
      baseUrl: BASE,
      transport: { fetch, sendOriginHeader: true, session },
    });
    await client.logout();
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('Origin')).toBe(BASE);
    expect(headers.get('Cookie')).toBe('session=old');
    expect(session.value).toBeNull();
  });

  it('未登录时 me() 返回 null，其余错误抛出 CloudSSHApiError', async () => {
    const unauthorized = new CloudSSHApiClient({
      baseUrl: BASE,
      transport: mockFetch(() => Response.json({ error: 'Not authenticated' }, { status: 401 })),
    });
    expect(await unauthorized.me()).toBeNull();

    const broken = new CloudSSHApiClient({
      baseUrl: BASE,
      transport: mockFetch(() => Response.json({ error: 'boom' }, { status: 500 })),
    });
    await expect(broken.listServers()).rejects.toMatchObject({ status: 500, message: 'HTTP 500: boom' });
    await expect(broken.listServers()).rejects.toBeInstanceOf(CloudSSHApiError);
  });

  it('拒绝与实例不同源的一次性连接地址', async () => {
    const client = new CloudSSHApiClient({
      baseUrl: BASE,
      transport: mockFetch(() => Response.json({ wsUrl: 'wss://evil.example.com/api/ssh?token=x' })),
    });
    await expect(client.connectServer(1)).rejects.toThrow('不同源');

    const ok = new CloudSSHApiClient({
      baseUrl: BASE,
      transport: mockFetch(() => Response.json({ wsUrl: 'wss://cloudssh.example.workers.dev/api/ssh?token=x' })),
    });
    await expect(ok.connectServer(1)).resolves.toEqual({
      wsUrl: 'wss://cloudssh.example.workers.dev/api/ssh?token=x',
    });
  });
});
