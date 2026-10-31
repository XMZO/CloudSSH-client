/**
 * 入口网关（tools/gateway）的状态与管理接口（电脑标题栏、手机设置共用；电脑的实例管理窗口不能联网，走主进程，
 * 见 apps/desktop/src/main/platform/gateway-admin.ts）。
 *
 * 状态是 GET /api/__gateway/status（要登录）：第二版网关返回 nodes 列表与当前设置；第一版只有 A、B 两边
 * （usage / aDown / mapped），读的时候换成同样的列表。普通实例没有这个接口（404，或者返回的是网页）。
 * 管理接口（/api/__gateway/settings、sync、pause、tokens）要网页 / 客户端的登录，长期令牌只能看状态。
 */

export type GatewayPolicy = 'fill' | 'even';

export interface GatewayDown {
  until: number;
  reason: string;
  manual?: boolean;
}

export interface GatewayNode {
  name: string;
  home: boolean;
  /** 今天的用量（0～1，可能超过 1）；没配统计令牌时为 null */
  ratio: number | null;
  gbs: number | null;
  /** 用到这么多就不再放新会话 */
  limit: number | null;
  down: GatewayDown | null;
  /** 和主节点对应上的服务器数、改过还没同步过来的数（主节点自己为 null） */
  mapped: { servers: number; stale: number } | null;
}

export interface GatewaySettings {
  policy: GatewayPolicy;
  order: string[];
  limit: number;
  limits: Record<string, number>;
  /** 改过（不是部署时的默认值） */
  custom: boolean;
}

export interface GatewayStatus {
  policy: GatewayPolicy;
  /** 新会话会放的节点 */
  next: string | null;
  nodes: GatewayNode[];
  lastSync: { at: number; errors: string[] } | null;
  /** 第一版网关没有，不能在客户端里改设置 */
  settings: GatewaySettings | null;
}

export interface GatewayToken {
  label: string;
  created: number;
  /** 0 表示不过期 */
  expires: number;
}

interface RawUsage {
  gbs?: number;
  ratio?: number;
}

/** 网关返回的原样内容（两版都可能） */
interface RawStatus {
  gateway?: unknown;
  policy?: string;
  next?: string;
  nodes?: GatewayNode[];
  settings?: GatewaySettings;
  usage?: Record<string, RawUsage> | null;
  aDown?: GatewayDown | null;
  mapped?: { servers: number; stale: number };
  lastSync?: { at?: number; errors?: string[] } | null;
}

/** 整理成统一的样子；不是入口网关返回 null */
export function normalizeGatewayStatus(raw: unknown): GatewayStatus | null {
  const body = raw as RawStatus | null;
  if (!body || body.gateway !== true) return null;
  const nodes: GatewayNode[] = Array.isArray(body.nodes)
    ? body.nodes
    : (['A', 'B'] as const).map((name) => ({
        name,
        home: name === 'B',
        ratio: body.usage?.[name]?.ratio ?? null,
        gbs: body.usage?.[name]?.gbs ?? null,
        limit: null,
        down: name === 'A' ? (body.aDown ?? null) : null,
        mapped: name === 'A' ? (body.mapped ?? null) : null,
      }));
  const lastSync = body.lastSync?.at ? { at: body.lastSync.at, errors: body.lastSync.errors ?? [] } : null;
  return {
    policy: body.policy === 'even' ? 'even' : 'fill',
    next: body.next ?? null,
    nodes,
    lastSync,
    settings: body.settings ?? null,
  };
}

/** 暂停的原因：手动、今天额度用完（UTC 0 点恢复）、出错（10 分钟后或能读到时恢复） */
export function downKind(down: GatewayDown): 'manual' | 'quota' | 'error' {
  if (down.manual) return 'manual';
  return /exceed/i.test(down.reason) ? 'quota' : 'error';
}

export const percentText = (ratio: number | null): string => (ratio == null ? '?' : String(Math.round(ratio * 100)));

/** 各节点和主节点对应上的服务器数（取最多的那个） */
export const mappedServers = (status: GatewayStatus): number => Math.max(0, ...status.nodes.map((node) => node.mapped?.servers ?? 0));

// ---------- 接口 ----------

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
  return data as T;
}

/**
 * 读网关状态（不报错，调用方据此决定显不显示网关的东西）：
 * 'none' 确定不是入口网关（没有这个接口，或返回的不是网关状态），以后不用再问；
 * 'unknown' 现在说不准（没登录、连不上），过一会儿再试
 */
export async function probeGateway(): Promise<GatewayStatus | 'none' | 'unknown'> {
  try {
    const response = await fetch('/api/__gateway/status', { credentials: 'include', cache: 'no-store' });
    if (response.status === 401 || response.status >= 500) return 'unknown';
    if (!response.ok) return 'none';
    return normalizeGatewayStatus(await response.json().catch(() => null)) ?? 'none';
  } catch {
    return 'unknown';
  }
}

const statusOf = (raw: unknown): GatewayStatus => {
  const status = normalizeGatewayStatus(raw);
  if (!status) throw new Error('网关返回的状态不对');
  return status;
};

export const gatewayApi = {
  /** settings 为 null 时恢复部署时的默认值 */
  saveSettings: async (settings: { policy: GatewayPolicy; order: string[]; limits: Record<string, number> } | null) =>
    statusOf(settings ? await call('PUT', '/api/__gateway/settings', settings) : await call('DELETE', '/api/__gateway/settings')),
  sync: async () => statusOf((await call<{ status: unknown }>('POST', '/api/__gateway/sync')).status),
  /** minutes 为 null 时解除暂停 */
  pause: async (node: string, minutes: number | null) => {
    const query = new URLSearchParams({ node });
    if (minutes != null) query.set('minutes', String(minutes));
    return statusOf(await call(minutes == null ? 'DELETE' : 'POST', `/api/__gateway/pause?${query}`));
  },
  tokens: () => call<GatewayToken[]>('GET', '/api/__gateway/tokens'),
  issueToken: (label: string, days: number) => call<GatewayToken & { token: string }>('POST', '/api/__gateway/tokens', { label, days }),
  revokeToken: (label: string) => call<{ deleted: number }>('DELETE', `/api/__gateway/tokens?${new URLSearchParams({ label })}`),
};
