/**
 * AI 能操作的服务器：来自服务器列表（sidebar/store，旁听网页版的 /api/servers），电脑和手机共用。
 * 给 AI 的目录只有名称、标签（分类）、系统与线路（直连 / 经跳板 / CF 隧道），不含地址、用户名与任何凭据。
 */
import type { ServerConfig } from '@cloudssh/core';
import { getServers } from '../../sidebar/store';

export type Route = 'direct' | 'jump' | 'tunnel';

export function routeOf(server: ServerConfig): Route {
  if (server.transport_type === 'cf_tunnel') return 'tunnel';
  return server.jump_server_id ? 'jump' : 'direct';
}

export function serverById(id: number | null | undefined): ServerConfig | null {
  if (typeof id !== 'number') return null;
  return getServers()?.find((server) => server.id === id) ?? null;
}

function plain(text: string, limit: number): string {
  const value = text.replace(/[\r\n|]+/g, ' ').replace(/[<>]/g, '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

export type Resolved = { server: ServerConfig } | { error: string };

/**
 * 按名字找服务器：完全一致（不分大小写）优先，其次唯一包含；“current / 当前”指 AI 所在的服务器。
 * 找不到或有歧义时返回给 AI 的说明。
 */
export function resolveServer(name: unknown, currentId: number | null): Resolved {
  const servers = getServers() ?? [];
  if (typeof name !== 'string' || !name.trim()) return { error: 'missing server name' };
  const key = norm(name);
  if (['current', 'this', 'local', '当前', '当前服务器', '本机'].includes(key)) {
    const current = servers.find((server) => server.id === currentId);
    return current ? { server: current } : { error: 'the current server is not a saved server' };
  }
  const exact = servers.filter((server) => norm(server.name) === key);
  if (exact.length === 1) return { server: exact[0] };
  const partial = exact.length ? exact : servers.filter((server) => norm(server.name).includes(key));
  if (partial.length === 1) return { server: partial[0] };
  if (!partial.length) return { error: `no saved server named "${plain(name, 80)}"` };
  return { error: `"${plain(name, 80)}" matches several servers: ${partial.slice(0, 8).map((s) => `"${plain(s.name, 60)}"`).join(', ')}` };
}

/** 服务器目录（每台一行），最多 maxChars 字 */
export function serverDirectory(currentId: number | null, maxChars = 4000): string {
  const servers = getServers() ?? [];
  const byId = new Map(servers.map((server) => [server.id, server]));
  const lines: string[] = [];
  let used = 0;
  for (const server of servers) {
    const route = routeOf(server);
    const via = route === 'jump' ? `via jump host "${plain(byId.get(server.jump_server_id!)?.name ?? '?', 40)}"` : route === 'tunnel' ? 'via Cloudflare tunnel' : 'direct';
    const tags = (server.tags ?? []).map((tag) => plain(tag, 30)).filter(Boolean).slice(0, 6).join(', ');
    const line = `- ${plain(server.name, 80)}${server.id === currentId ? ' (current)' : ''} | tags: ${tags || '-'} | os: ${server.os ?? '?'} | ${via}`;
    if (used + line.length > maxChars) {
      lines.push(`- … ${servers.length - lines.length} more (ask with {"action":"list"})`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

const CROSS_WORDS = [
  '其他服务器', '其它服务器', '别的服务器', '另一台', '所有服务器', '全部服务器', '每台', '服务器之间', '服务器间', '互传',
  '传到', '传给', '拷到', '拷贝到', '复制到', '同步到', '发到', '其他機器', '其他伺服器', '所有伺服器', '傳到', '複製到',
  'other server', 'another server', 'all servers', 'every server', 'each server', 'copy to', 'transfer to', 'send to', 'sync to',
];

/** 名称里能单独指代服务器的片段：“DE-03 法兰克福” → DE-03、法兰克福（太短的如 1G 不算） */
function nameParts(name: string): string[] {
  return norm(name)
    .split(/[\s·|/,()（）[\]【】]+/)
    .filter((part) => part.length >= 3 || /[一-鿿]{2,}/.test(part));
}

/** 消息里提到了别的服务器（名称或其片段、标签，或跨服务器的说法）；当前服务器自己名称里的片段不算 */
export function mentionsOtherServers(message: string, currentId: number | null): boolean {
  const text = norm(message);
  if (CROSS_WORDS.some((word) => text.includes(word))) return true;
  const servers = getServers() ?? [];
  const own = new Set(nameParts(servers.find((server) => server.id === currentId)?.name ?? ''));
  for (const server of servers) {
    if (server.id === currentId) continue;
    const name = norm(server.name);
    if (name.length >= 2 && text.includes(name)) return true;
    if (nameParts(server.name).some((part) => !own.has(part) && text.includes(part))) return true;
    for (const tag of server.tags ?? []) {
      const value = norm(tag).replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim();
      if (value.length >= 2 && text.includes(value)) return true;
    }
  }
  return false;
}

export function hasOtherServers(currentId: number | null): boolean {
  return (getServers() ?? []).some((server) => server.id !== currentId);
}
