/**
 * 手机端：从别的实例带上本地数据（规则与电脑端 apps/desktop/src/main/platform/instance-import.ts 相同，
 * 编号对应等纯函数在 @cloudssh/core 的 instance-import.ts）。
 *
 * 手机上所有实例共用一个页面，本地数据按实例编号分开存，换了实例地址（比如改走入口网关）后新实例里是空的：
 *   cloudssh_mobile_node_order:<实例>    分组与组内服务器的手动顺序（服务器编号）
 *   cloudssh_mobile_node_sort:<实例>     组内排序方式
 *   cloudssh_snippet_order:<实例>        命令片段顺序（片段编号）
 *   凭据预设的 links["instance:<实例>"]   哪台服务器用哪个预设
 * AI 对话历史按页面主机名 + 服务器编号存，手机上各实例本来就共用，不用搬。
 *
 * - 自动：登录后打开某个实例，它还没有自己的排序、和另一个有本地数据的实例是同一套服务器（至少一半对得上）时，
 *   导入那边的并提示一下；每个实例只做一次（记在 cloudssh_mobile_imported:<实例>）。没登录、读不到别的实例时下次再试
 * - 手动：设置 → 实例 → 导入本地数据
 * 编号按内容对应（服务器看名称、地址、端口、用户名，片段看名称和命令），所以要读两边的列表：当前实例照常请求，
 * 别的实例由 Rust 带着它自己的登录去读（native.instanceJson）。
 */
import { matchIds, serverKey, type ServerLike, type SnippetLike, snippetKey, translateNodeOrder, translateSnippetOrder } from '@cloudssh/core';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { importScopeLinks } from '../shared/credential-presets';
import { SNIPPET_ORDER_EVENT } from '../shared/snippet-order';
import { mt } from './i18n';
import { reloadNodeOrder } from './node-groups';
import { type MobileInstance, type MobileState, native } from './tauri';

/** 至少这么多台服务器对得上才算“同一套” */
const MIN_MATCHED = 3;

const keysOf = (id: string) => ({
  order: `cloudssh_mobile_node_order:${id}`,
  sort: `cloudssh_mobile_node_sort:${id}`,
  snippets: `cloudssh_snippet_order:${id}`,
  mark: `cloudssh_mobile_imported:${id}`,
});

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 有没有自己的手动排序（排过至少一台服务器或一个分组） */
function hasOrder(id: string): boolean {
  try {
    const data = JSON.parse(readKey(keysOf(id).order) ?? 'null') as { groups?: unknown[]; servers?: Record<string, unknown[]> } | null;
    return !!data && ((data.groups?.length ?? 0) > 0 || Object.values(data.servers ?? {}).some((ids) => Array.isArray(ids) && ids.length > 0));
  } catch {
    return false;
  }
}

function hasLocalData(id: string): boolean {
  const keys = keysOf(id);
  return hasOrder(id) || readKey(keys.snippets) !== null || readKey(keys.sort) !== null;
}

async function currentList<T>(path: string): Promise<T[]> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as T[]) : [];
}

async function otherList<T>(id: string, path: '/api/servers' | '/api/snippets'): Promise<T[]> {
  const data = await native.instanceJson<unknown>(id, path);
  return Array.isArray(data) ? (data as T[]) : [];
}

/** 服务器对得上多少台：至少 MIN_MATCHED 台、且至少是较少那边的一半，才算同一套 */
function sameServers(matched: number, source: number, target: number): boolean {
  return matched >= MIN_MATCHED && matched >= Math.min(source, target) / 2;
}

export interface ImportSummary {
  matched: number;
  total: number;
  snippets: number;
  links: number;
}

/** 把 source 实例的本地数据导入当前实例（target）；同名的覆盖，预设关联合并 */
async function importFrom(source: MobileInstance, target: MobileInstance, servers?: { source: ServerLike[]; target: ServerLike[] }): Promise<ImportSummary> {
  const lists = servers ?? {
    source: await otherList<ServerLike>(source.id, '/api/servers'),
    target: await currentList<ServerLike>('/api/servers'),
  };
  const serverMap = matchIds(lists.source, lists.target, serverKey);
  const from = keysOf(source.id);
  const to = keysOf(target.id);

  const order = readKey(from.order);
  if (order !== null) {
    const next = translateNodeOrder(order, serverMap);
    if (next !== null) localStorage.setItem(to.order, next);
  }
  const sort = readKey(from.sort);
  if (sort !== null) localStorage.setItem(to.sort, sort);

  // 命令片段顺序：读不到哪边的片段就跳过（不影响其他几项）
  let snippets = 0;
  const snippetOrder = readKey(from.snippets);
  if (snippetOrder !== null) {
    try {
      const [sourceSnippets, targetSnippets] = await Promise.all([
        otherList<SnippetLike>(source.id, '/api/snippets'),
        currentList<SnippetLike>('/api/snippets'),
      ]);
      const next = translateSnippetOrder(snippetOrder, matchIds(sourceSnippets, targetSnippets, snippetKey));
      if (next !== null) {
        localStorage.setItem(to.snippets, next);
        snippets = (JSON.parse(next) as unknown[]).length;
      }
    } catch {
      // 跳过
    }
  }

  const links = await importScopeLinks(`instance:${source.id}`, `instance:${target.id}`, serverMap).catch(() => 0);
  reloadNodeOrder();
  window.dispatchEvent(new Event(SNIPPET_ORDER_EVENT));
  return { matched: serverMap.size, total: lists.source.length, snippets, links };
}

function mark(id: string, value: string): void {
  try {
    localStorage.setItem(keysOf(id).mark, value);
  } catch {
    // 存不下就下次再判断
  }
}

/** 启动时调用（不阻塞界面）：当前实例第一次打开、还没有自己的排序时，从同一套服务器的别的实例带上本地数据 */
export async function autoImportLocalData(state: MobileState): Promise<void> {
  if (!state.loggedIn) return;
  const target = state.current;
  if (readKey(keysOf(target.id).mark) !== null) return;
  if (hasOrder(target.id)) return mark(target.id, 'own');
  const candidates = state.instances.filter((instance) => instance.id !== target.id && hasLocalData(instance.id));
  if (candidates.length === 0) return mark(target.id, 'none');
  // 服务器列表要等登录检查过；读不到（离线、登录过期）就下次启动再试
  const targetServers = await currentList<ServerLike>('/api/servers').catch(() => null);
  if (!targetServers || targetServers.length < MIN_MATCHED) return;

  let best: { source: MobileInstance; servers: ServerLike[]; score: number } | null = null;
  let unsure = false;
  for (const source of candidates) {
    try {
      const servers = await otherList<ServerLike>(source.id, '/api/servers');
      const matched = matchIds(servers, targetServers, serverKey).size;
      if (!sameServers(matched, servers.length, targetServers.length)) continue;
      const score = (hasOrder(source.id) ? 1000 : 0) + matched;
      if (!best || score > best.score) best = { source, servers, score };
    } catch {
      // 那个实例没登录或连不上：说不准它能不能导，先不记“没有”
      unsure = true;
    }
  }
  if (!best) {
    if (!unsure) mark(target.id, 'none');
    return;
  }
  // 等待期间用户可能已经自己排过了：那就不覆盖
  if (hasOrder(target.id)) return mark(target.id, 'own');
  await importFrom(best.source, target, { source: best.servers, target: targetServers });
  mark(target.id, `imported:${best.source.id}`);
  notify(mt('importAuto', { name: best.source.name }), { variant: 'success' });
}

/** 设置里手动导入：服务器对不上时报错（不导入） */
export async function importLocalData(source: MobileInstance, state: MobileState): Promise<ImportSummary> {
  const [sourceServers, targetServers] = await Promise.all([
    otherList<ServerLike>(source.id, '/api/servers'),
    currentList<ServerLike>('/api/servers'),
  ]);
  const matched = matchIds(sourceServers, targetServers, serverKey).size;
  if (!sameServers(matched, sourceServers.length, targetServers.length)) throw new Error(mt('importNoMatch', { name: source.name }));
  const summary = await importFrom(source, state.current, { source: sourceServers, target: targetServers });
  mark(state.current.id, `imported:${source.id}`);
  return summary;
}
