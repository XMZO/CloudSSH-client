/**
 * 从别的实例导入本地数据（纯函数部分；电脑见 apps/desktop/src/main/platform/instance-import.ts，
 * 手机见 packages/ui-web/overrides/mobile/instance-import.ts）：两边的服务器 / 命令片段编号对应、
 * 本地存储逐项改写、AI 对话历史换范围、凭据预设的“哪台服务器用哪个预设”合并。
 *
 * 编号按内容对应（服务器看名称、地址、端口、用户名，命令片段看名称和命令），内容一样又有几条时优先同编号的。
 * 对应不上的（只在源实例里有的服务器）就丢掉它的排序、对话历史和预设关联。
 */

export interface ServerLike {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
}

export interface SnippetLike {
  id: number;
  name: string;
  command: string;
}

export interface Conversation {
  id: string;
  /** 实例主机名 # 服务器编号 */
  scope: string;
  [key: string]: unknown;
}

export interface PresetFile {
  version?: number;
  presets?: unknown[];
  links?: Record<string, Record<string, number[]>>;
}

/** 按内容配对：同编号又同内容的先配，其余按内容依次配 */
export function matchIds<T extends { id: number }>(source: T[], target: T[], key: (item: T) => string): Map<number, number> {
  const map = new Map<number, number>();
  const used = new Set<number>();
  const byKey = new Map<string, T[]>();
  for (const item of target) {
    const list = byKey.get(key(item)) ?? [];
    list.push(item);
    byKey.set(key(item), list);
  }
  const pending: T[] = [];
  for (const item of source) {
    const same = byKey.get(key(item))?.find((candidate) => candidate.id === item.id && !used.has(candidate.id));
    if (same) {
      map.set(item.id, same.id);
      used.add(same.id);
    } else {
      pending.push(item);
    }
  }
  for (const item of pending) {
    const other = byKey.get(key(item))?.find((candidate) => !used.has(candidate.id));
    if (other) {
      map.set(item.id, other.id);
      used.add(other.id);
    }
  }
  return map;
}

export const serverKey = (server: ServerLike): string => [server.name, server.host, server.port, server.username].join('\u0000');
export const snippetKey = (snippet: SnippetLike): string => [snippet.name, snippet.command].join('\u0000');

/** 只搬这些前缀的键；中断草稿只存 30 分钟、按编号存，不搬 */
const COPY_PREFIX = 'cloudssh_';
const SKIP_PREFIXES = ['cloudssh_agent_draft_'];
const NODE_ORDER_KEYS = new Set(['cloudssh_desktop_node_order']);
const SNIPPET_ORDER_KEYS = new Set(['cloudssh_snippet_order']);

/** 节点排序 { groups, servers: { 分组: [服务器编号] } }：编号换成目标实例的，对应不上的去掉 */
export function translateNodeOrder(raw: string, servers: Map<number, number>): string | null {
  try {
    const data = JSON.parse(raw) as { groups?: unknown; servers?: Record<string, unknown> };
    const next: Record<string, number[]> = {};
    for (const [group, ids] of Object.entries(data.servers ?? {})) {
      if (!Array.isArray(ids)) continue;
      next[group] = ids.map((id) => servers.get(Number(id))).filter((id): id is number => id !== undefined);
    }
    return JSON.stringify({ groups: Array.isArray(data.groups) ? data.groups : [], servers: next });
  } catch {
    return null;
  }
}

/** 命令片段顺序 ["编号"…]：编号换成目标实例的，对应不上的去掉 */
export function translateSnippetOrder(raw: string, snippets: Map<number, number>): string | null {
  try {
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return null;
    return JSON.stringify(ids.map((id) => snippets.get(Number(id))).filter((id) => id !== undefined).map(String));
  } catch {
    return null;
  }
}

/** 本地存储：带编号的键换成目标实例的编号，其余原样 */
export function translateLocalStorage(
  entries: Record<string, string>,
  servers: Map<number, number>,
  snippets: Map<number, number>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(COPY_PREFIX) || SKIP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (NODE_ORDER_KEYS.has(key)) {
      const next = translateNodeOrder(value, servers);
      if (next !== null) result[key] = next;
    } else if (SNIPPET_ORDER_KEYS.has(key)) {
      const next = translateSnippetOrder(value, snippets);
      if (next !== null) result[key] = next;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** AI 对话历史：范围“源主机名#服务器编号”换成“目标主机名#目标编号”；对应不上的不搬 */
export function translateConversations(
  conversations: Conversation[],
  sourceHost: string,
  targetHost: string,
  servers: Map<number, number>
): Conversation[] {
  const result: Conversation[] = [];
  for (const conversation of conversations) {
    const match = /^(.*)#(\d+)$/.exec(conversation.scope ?? '');
    if (!match || match[1] !== sourceHost) continue;
    const target = servers.get(Number(match[2]));
    if (target === undefined) continue;
    result.push({ ...conversation, scope: `${targetHost}#${target}` });
  }
  return result;
}

/** 凭据预设：把源实例的“预设 → 服务器”关联换成目标编号，合并进目标实例（目标已有的保留） */
export function mergePresetLinks(file: PresetFile, sourceScope: string, targetScope: string, servers: Map<number, number>): { file: PresetFile; links: number } {
  const source = file.links?.[sourceScope] ?? {};
  const target = { ...(file.links?.[targetScope] ?? {}) };
  let links = 0;
  for (const [presetId, ids] of Object.entries(source)) {
    const mapped = (Array.isArray(ids) ? ids : []).map((id) => servers.get(id)).filter((id): id is number => id !== undefined);
    if (mapped.length === 0) continue;
    target[presetId] = [...new Set([...(target[presetId] ?? []), ...mapped])];
    links += mapped.length;
  }
  return { file: { ...file, links: { ...(file.links ?? {}), [targetScope]: target } }, links };
}
