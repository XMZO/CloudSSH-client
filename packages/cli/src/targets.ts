/**
 * 服务器：从 /api/servers 取（与客户端同一份，含主机 ID 用的编号、名称、标签、系统、线路），解析命令里的目标。
 *
 * 目标写法（多个用逗号隔开）：
 * - srv-12 或 12：主机 ID（服务器在 CloudSSH 里的编号，各设备一样，改名不变）
 * - 名称：完全一致（不分大小写）优先；否则唯一包含它的那台；匹配到多台时报错并列出候选
 * - 别名：config.json 的 aliases（cloudssh alias set web srv-12），可以展开成上面任何写法
 * - tag:德国：带这个标签的所有服务器；all：全部
 */
import type { ServerConfig } from '@cloudssh/core';
import { hostId } from '../../ui-web/overrides/shared/ai-remote/servers';
import { loadConfig, resolveInstance, UsageError, type CliConfig } from './config';
import { api, installNetwork } from './net';
import { setServers } from './store-shim';

export { hostId };

/** 选好实例（--instance → CLOUDSSH_INSTANCE → 默认 → 唯一已登录的）并装好网络；没登录时报用法错误 */
export function activeInstance(requested?: string): { config: CliConfig; origin: string; session: string } {
  const config = loadConfig();
  const instance = resolveInstance(config, requested);
  if (!instance.credential) {
    throw new UsageError(`Not signed in to ${instance.origin}: run cloudssh login ${instance.origin} (or turn on "同步登录给命令行" in the CloudSSH desktop app)`);
  }
  installNetwork(instance.origin, instance.credential.session);
  return { config, origin: instance.origin, session: instance.credential.session };
}

/** 装好网络、取服务器列表 */
export async function connect(requested?: string): Promise<{ config: CliConfig; servers: ServerConfig[]; origin: string }> {
  const { config, origin } = activeInstance(requested);
  const servers = await loadServers();
  return { config, servers, origin };
}

export async function loadServers(): Promise<ServerConfig[]> {
  const list = await api<ServerConfig[]>('/api/servers');
  const servers = Array.isArray(list) ? list : [];
  setServers(servers);
  return servers;
}

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

export interface ServerRow {
  id: string;
  name: string;
  tags: string[];
  os: string | null;
  route: string;
}

/** servers 的筛选：tag 匹配标签（包含即可），query 匹配名称、主机 ID、标签、系统（都不分大小写） */
export function filterServers(servers: ServerConfig[], query?: string, tag?: string): ServerRow[] {
  const q = query?.trim().toLowerCase();
  const t = tag?.trim().toLowerCase();
  return servers
    .filter((server) => {
      const tags = (server.tags ?? []).map((item) => item.toLowerCase());
      if (t && !tags.some((item) => item.includes(t))) return false;
      if (!q) return true;
      return [server.name, hostId(server), ...(server.tags ?? []), server.os ?? ''].some((item) => item.toLowerCase().includes(q));
    })
    .map((server) => ({ id: hostId(server), name: server.name, tags: server.tags ?? [], os: server.os ?? null, route: routeOf(server, servers) }));
}

export function formatServerRow(row: ServerRow): string {
  return `${row.id.padEnd(9)} ${row.name}  [${row.tags.join(', ') || '-'}]  ${row.os ?? '?'}  ${row.route}`;
}

export function routeOf(server: ServerConfig, servers: ServerConfig[]): string {
  if (server.transport_type === 'cf_tunnel') return 'cf-tunnel';
  if (server.jump_server_id) {
    const jump = servers.find((item) => item.id === server.jump_server_id);
    return `via ${jump ? hostId(jump) : '?'}`;
  }
  return 'direct';
}

function resolveOne(spec: string, servers: ServerConfig[], config: CliConfig, depth: number): ServerConfig[] {
  const text = spec.trim();
  if (!text) return [];
  const alias = config.aliases[text];
  if (alias !== undefined) {
    if (depth > 5) throw new UsageError(`Alias ${text} is circular`);
    return resolveTargets(alias, servers, config, depth + 1);
  }
  if (text.toLowerCase() === 'all') return [...servers];
  const tag = /^tag:(.+)$/i.exec(text);
  if (tag) {
    const want = norm(tag[1]);
    const hit = servers.filter((server) => (server.tags ?? []).some((item) => norm(item) === want || norm(item).replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim() === want));
    if (!hit.length) throw new UsageError(`No server has the tag "${tag[1]}"`);
    return hit;
  }
  const id = /^(?:srv-)?(\d+)$/i.exec(text);
  if (id) {
    const server = servers.find((item) => item.id === Number(id[1]));
    if (server) return [server];
    if (/^srv-/i.test(text)) throw new UsageError(`No server with host ID ${text} (see list_servers or cloudssh servers)`);
  }
  const key = norm(text);
  const exact = servers.filter((server) => norm(server.name) === key);
  if (exact.length === 1) return exact;
  const partial = exact.length ? exact : servers.filter((server) => norm(server.name).includes(key));
  if (partial.length === 1) return partial;
  if (!partial.length) throw new UsageError(`No server named "${text}" (see list_servers or cloudssh servers)`);
  const list = partial
    .slice(0, 10)
    .map((server) => `  ${hostId(server)}  ${server.name}`)
    .join('\n');
  throw new UsageError(`"${text}" matches ${partial.length} servers; use a host ID:\n${list}`);
}

/**
 * 目标全是主机 ID（srv-12，含展开后的别名）时给出编号，不用先取服务器列表就能开始连接；有名称、标签、all 或
 * 不带 srv- 的数字（也可能是名称）时返回 null
 */
export function hostIdsOf(spec: string, config: CliConfig, depth = 0): number[] | null {
  const ids: number[] = [];
  for (const part of spec.split(',')) {
    const text = part.trim();
    if (!text) continue;
    const alias = config.aliases[text];
    if (alias !== undefined) {
      const nested = depth > 5 ? null : hostIdsOf(alias, config, depth + 1);
      if (!nested) return null;
      ids.push(...nested);
      continue;
    }
    const id = /^srv-(\d+)$/i.exec(text);
    if (!id) return null;
    ids.push(Number(id[1]));
  }
  return ids.length ? [...new Set(ids)] : null;
}

/** 解析目标，去重保持顺序 */
export function resolveTargets(spec: string, servers: ServerConfig[], config: CliConfig, depth = 0): ServerConfig[] {
  const result: ServerConfig[] = [];
  for (const part of spec.split(',')) {
    for (const server of resolveOne(part, servers, config, depth)) {
      if (!result.includes(server)) result.push(server);
    }
  }
  if (!result.length) throw new UsageError('No server specified');
  return result;
}

export function resolveSingle(spec: string, servers: ServerConfig[], config: CliConfig): ServerConfig {
  const list = resolveTargets(spec, servers, config);
  if (list.length > 1) throw new UsageError(`"${spec}" matches ${list.length} servers; exactly one is required here`);
  return list[0];
}

/** 同时最多跑 limit 个 */
export async function eachLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
