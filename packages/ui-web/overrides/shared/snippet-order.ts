/**
 * 命令片段的手动顺序（电脑与手机共用）：只存在本地（localStorage），不改 Worker（Worker 按创建先后返回）。
 *
 * 保存的是全部片段 id 的先后；没排过的片段（新建的）保持原来的相对顺序，排在后面。
 * 分类与搜索只是筛选：在某个分类里拖动，只调换看得到的这几条之间的先后，其他片段的位置不变。
 * 云端片段（登录后）与本机片段（匿名）各存一份。电脑每个实例的页面存储本来就是分开的；
 * 手机所有实例共用一个 origin，云端片段的顺序按实例分开（本机片段本来就是各实例共用的，顺序也共用）。
 */

/** 顺序变化时在 window 上派发（命令条、命令面板据此重排） */
export const SNIPPET_ORDER_EVENT = 'cloudssh:snippet-order-changed';

/** 最多记这么多条（云端每个用户最多 100 条，本机片段没有上限，留足余量） */
const MAX_IDS = 2000;

function storageKey(cloud: boolean): string {
  if (!cloud) return 'cloudssh_snippet_order:local';
  const instance = (window as { __cloudsshMobile?: { state?: { currentId?: string } | null } }).__cloudsshMobile?.state
    ?.currentId;
  return instance ? `cloudssh_snippet_order:${instance}` : 'cloudssh_snippet_order';
}

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id === 'string' && id && id.length <= 128) seen.add(id);
    if (seen.size >= MAX_IDS) break;
  }
  return [...seen];
}

function read(cloud: boolean): string[] {
  try {
    return cleanIds(JSON.parse(localStorage.getItem(storageKey(cloud)) ?? '[]'));
  } catch {
    return [];
  }
}

function write(cloud: boolean, ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(storageKey(cloud), JSON.stringify(cleanIds(ids)));
    else localStorage.removeItem(storageKey(cloud));
  } catch {
    // 本地存储不可用时只是不记忆
  }
  window.dispatchEvent(new Event(SNIPPET_ORDER_EVENT));
}

/** 按保存的顺序排（返回新数组）；没排过的保持原相对顺序，放在后面 */
export function sortSnippets<T extends { id: string }>(items: T[], cloud: boolean): T[] {
  const saved = read(cloud);
  if (!saved.length) return items;
  const rank = new Map(saved.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(item.id) }))
    .sort((a, b) => {
      if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
      if (a.rank !== undefined) return -1;
      if (b.rank !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * 拖动结束：all 是当前排好的全部片段 id，visible 是看得到的那几条的新先后。
 * 看得到的这几条原来占的位置按新先后依次填回去，其余片段原地不动；保存后返回新的全部顺序。
 */
export function reorderVisible(all: string[], visible: string[], cloud: boolean): string[] {
  const moved = new Set(visible);
  const present = new Set(all);
  const queue = visible.filter((id) => present.has(id));
  const next = all.map((id) => (moved.has(id) ? (queue.shift() ?? id) : id));
  write(cloud, next);
  return next;
}

/** 云端片段的顺序（扫码同步时导出；片段本身随账号同步，只有顺序是本地的） */
export function cloudSnippetOrder(): string[] {
  return read(true);
}

/** 整体换成另一份顺序（扫码同步时用电脑上的顺序） */
export function replaceCloudSnippetOrder(ids: unknown): void {
  write(true, cleanIds(ids));
}
