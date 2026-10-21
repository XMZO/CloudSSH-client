/**
 * 连接诊断用的网络环境：每个实例地址实际走的代理（Chromium 按系统代理 / PAC 解析出的结果，如 `PROXY 127.0.0.1:7890`、
 * `DIRECT`），以及看起来像 TUN / 虚拟网卡的网卡名（Clash / mihomo、sing-box、WireGuard……开 TUN 时代理对应用透明，
 * 解析出来是 DIRECT，只能从网卡看出来）。只记代理串与网卡名，不记 IP。
 * 有变化才记一行；同时断开时强制记一行，方便对照断开那一刻走的是什么。
 */
import os from 'node:os';
import type { Session } from 'electron';
import { createLogger } from './logger';

const log = createLogger('connection-network');
const TUN_NAME = /tun|tap|wintun|wireguard|^wg\d|utun|meta|clash|mihomo|sing|v2ray|xray|nekoray|hiddify|zerotier|tailscale/i;
const PERIOD_MS = 60_000;

/** 实例 ID → 它的会话与地址 */
const instances = new Map<string, { ses: Session; baseUrl: string }>();
let lastLogged = '';

export function trackInstanceNetwork(instanceId: string, ses: Session, baseUrl: string): void {
  const known = instances.get(instanceId);
  instances.set(instanceId, { ses, baseUrl });
  if (!known || known.baseUrl !== baseUrl) void logNetworkEnv('instance');
}

function tunAdapters(): string[] {
  return Object.entries(os.networkInterfaces())
    .filter(([name, addresses]) => TUN_NAME.test(name) && (addresses ?? []).some((address) => !address.internal))
    .map(([name]) => name)
    .slice(0, 10);
}

async function snapshot(): Promise<{ proxies: Record<string, string>; tun: string[] }> {
  const proxies: Record<string, string> = {};
  for (const [id, { ses, baseUrl }] of instances) {
    try {
      proxies[id] = (await ses.resolveProxy(baseUrl)).slice(0, 200);
    } catch {
      proxies[id] = 'unknown';
    }
  }
  return { proxies, tun: tunAdapters() };
}

/** reason：为什么查（startup、periodic、resume、instance、simultaneous-close……）；force：没变化也记 */
export async function logNetworkEnv(reason: string, force = false): Promise<void> {
  try {
    const env = await snapshot();
    const key = JSON.stringify(env);
    if (!force && key === lastLogged) return;
    lastLogged = key;
    log.info('network-env', { reason, ...env });
  } catch {
    // 诊断失败不影响连接
  }
}

let watching = false;

/** 启动后定时检查（有变化才记），唤醒时立即查一次 */
export function watchNetworkEnv(): void {
  if (watching) return;
  watching = true;
  void logNetworkEnv('startup', true);
  setInterval(() => void logNetworkEnv('periodic'), PERIOD_MS).unref?.();
}
