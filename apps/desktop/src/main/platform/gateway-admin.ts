/**
 * 实例管理里的入口网关面板（tools/gateway）：带着这个实例的登录调网关的 /api/__gateway/… 接口。
 *
 * 实例管理页面不能联网（CSP connect-src 'none'），由主进程在实例自己的会话分区里请求（和打开实例的窗口同一份登录）。
 * 只开放下面几种操作，路径和参数由这里拼，页面传不进任意地址。普通 CloudSSH 实例没有这些接口（404），面板不显示。
 */
import { type InstanceConfig, originOf } from '@cloudssh/core';
import { configStore } from '../config/store';
import { prepareInstanceSession } from './session';

export type GatewayAction =
  | { kind: 'status' }
  /** settings 为 null 时恢复成网关部署时的默认值 */
  | { kind: 'settings'; settings: { policy?: string; order?: string[]; limit?: number; limits?: Record<string, number> } | null }
  | { kind: 'sync' }
  /** minutes 为 null 时解除暂停 */
  | { kind: 'pause'; node: string; minutes: number | null }
  | { kind: 'tokens' }
  | { kind: 'issue-token'; label: string; days: number }
  | { kind: 'revoke-token'; label: string };

export type GatewayResult =
  | { ok: true; data: unknown }
  /** notGateway：不是入口网关；login：没登录或登录过期 */
  | { ok: false; reason: 'notGateway' | 'login' | 'error'; message: string };

const TIMEOUT_MS = 30_000;
/** 立即同步要读写各节点，给久一点 */
const SYNC_TIMEOUT_MS = 120_000;

function requestOf(action: GatewayAction): { method: string; path: string; body?: unknown } {
  switch (action.kind) {
    case 'status':
      return { method: 'GET', path: '/api/__gateway/status' };
    case 'settings':
      return action.settings
        ? { method: 'PUT', path: '/api/__gateway/settings', body: action.settings }
        : { method: 'DELETE', path: '/api/__gateway/settings' };
    case 'sync':
      return { method: 'POST', path: '/api/__gateway/sync' };
    case 'pause': {
      const query = new URLSearchParams({ node: String(action.node) });
      if (action.minutes != null) query.set('minutes', String(Math.round(Number(action.minutes))));
      return { method: action.minutes == null ? 'DELETE' : 'POST', path: `/api/__gateway/pause?${query}` };
    }
    case 'tokens':
      return { method: 'GET', path: '/api/__gateway/tokens' };
    case 'issue-token':
      return { method: 'POST', path: '/api/__gateway/tokens', body: { label: String(action.label).slice(0, 64), days: Number(action.days) } };
    case 'revoke-token':
      return { method: 'DELETE', path: `/api/__gateway/tokens?${new URLSearchParams({ label: String(action.label) })}` };
    default:
      throw new Error('不支持的网关操作');
  }
}

export async function gatewayRequest(instance: InstanceConfig, action: GatewayAction): Promise<GatewayResult> {
  const { method, path, body } = requestOf(action);
  const origin = originOf(instance.baseUrl);
  if (!origin) return { ok: false, reason: 'error', message: `「${instance.name}」的地址不对` };
  const { session } = prepareInstanceSession(instance);
  let response: Response;
  try {
    response = await session.fetch(`${origin}${path}`, {
      method,
      credentials: 'include',
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(action.kind === 'sync' ? SYNC_TIMEOUT_MS : TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: 'error', message: `连不上「${instance.name}」：${(error as Error).message}` };
  }
  const data = (await response.json().catch(() => null)) as { gateway?: unknown; error?: unknown } | null;
  if (response.status === 401) return { ok: false, reason: 'login', message: `「${instance.name}」没有登录，先打开它登录一次` };
  // 普通实例：没有这个接口（404，或者返回的是网页）
  if (action.kind === 'status' && (!response.ok || data?.gateway !== true)) {
    return { ok: false, reason: 'notGateway', message: '不是入口网关' };
  }
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`;
    return { ok: false, reason: 'error', message };
  }
  return { ok: true, data };
}

export function gatewayRequestById(id: string, action: GatewayAction): Promise<GatewayResult> {
  const instance = configStore.getInstance(id);
  if (!instance) throw new Error('实例不存在');
  return gatewayRequest(instance, action);
}
