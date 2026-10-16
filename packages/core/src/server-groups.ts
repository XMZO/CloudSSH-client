/**
 * 服务器节点分组与搜索（平台无关，桌面侧栏与将来的移动端共用）。
 *
 * 分组依据服务器标签（CloudSSH 的标签是单层的，例如“中国 🇨🇳”）。
 * 一台服务器有多个标签时会出现在每个对应分组里；没有标签的放进 ungrouped。
 */

export interface GroupableServer {
  id: number;
  name: string;
  host: string;
  username?: string;
  tags?: string[];
  last_connected_at?: number | null;
  cf_tunnel_host?: string | null;
}

/** name：分组与组内都按名称；count：分组按节点数从多到少；recent：按最近连接时间 */
export type ServerGroupSort = 'name' | 'count' | 'recent';

export const SERVER_GROUP_SORTS: readonly ServerGroupSort[] = ['name', 'count', 'recent'];

export interface ServerGroup<T> {
  /** 分组键（即标签原文） */
  key: string;
  label: string;
  servers: T[];
  /** 组内最近一次连接时间（无记录为 0） */
  lastConnectedAt: number;
}

export interface GroupedServers<T> {
  groups: ServerGroup<T>[];
  ungrouped: T[];
  /** 过滤后的去重节点数 */
  total: number;
}

const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' });

function lastConnected(server: GroupableServer): number {
  return typeof server.last_connected_at === 'number' ? server.last_connected_at : 0;
}

/** 规范化标签：去首尾空白，忽略空串与重复 */
export function serverTags(server: GroupableServer): string[] {
  const seen = new Set<string>();
  for (const raw of server.tags ?? []) {
    const tag = typeof raw === 'string' ? raw.trim() : '';
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/**
 * 关键字匹配：按空白拆成多个词，全部命中才算匹配（不区分大小写）。
 * 匹配范围：名称、主机、用户名、隧道域名、标签。
 */
export function matchesServerQuery(server: GroupableServer, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    server.name,
    server.host,
    server.username ?? '',
    server.cf_tunnel_host ?? '',
    ...serverTags(server),
  ]
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function compareServers(sort: ServerGroupSort) {
  return (a: GroupableServer, b: GroupableServer): number => {
    if (sort === 'recent') {
      const diff = lastConnected(b) - lastConnected(a);
      if (diff !== 0) return diff;
    }
    return collator.compare(a.name, b.name) || a.id - b.id;
  };
}

export function groupServersByTag<T extends GroupableServer>(
  servers: readonly T[],
  options: { sort?: ServerGroupSort; query?: string } = {}
): GroupedServers<T> {
  const sort = options.sort ?? 'name';
  const filtered = servers.filter((server) => matchesServerQuery(server, options.query ?? ''));
  const byTag = new Map<string, T[]>();
  const ungrouped: T[] = [];

  for (const server of filtered) {
    const tags = serverTags(server);
    if (tags.length === 0) {
      ungrouped.push(server);
      continue;
    }
    for (const tag of tags) {
      const list = byTag.get(tag);
      if (list) list.push(server);
      else byTag.set(tag, [server]);
    }
  }

  const compare = compareServers(sort);
  const groups: ServerGroup<T>[] = [...byTag.entries()].map(([key, list]) => ({
    key,
    label: key,
    servers: [...list].sort(compare),
    lastConnectedAt: Math.max(0, ...list.map(lastConnected)),
  }));

  groups.sort((a, b) => {
    if (sort === 'count' && a.servers.length !== b.servers.length) return b.servers.length - a.servers.length;
    if (sort === 'recent' && a.lastConnectedAt !== b.lastConnectedAt) return b.lastConnectedAt - a.lastConnectedAt;
    return collator.compare(a.label, b.label);
  });

  return { groups, ungrouped: [...ungrouped].sort(compare), total: filtered.length };
}

/** 名称首字符（支持中文与 emoji），用作头像字母 */
export function serverInitial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : '?';
}
