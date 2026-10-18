/**
 * 节点手动排序（桌面侧栏与手机节点页共用）：分组顺序 + 每个分组内的服务器顺序。
 * 只存在本地（localStorage），不改 Worker；没排过的分组/服务器按原来的顺序排在后面。
 */

export interface NodeOrderData {
  groups: string[];
  servers: Record<string, number[]>;
}

export class NodeOrder {
  private data: NodeOrderData;

  constructor(private readonly storageKey: string) {
    this.data = NodeOrder.read(storageKey);
  }

  private static read(key: string): NodeOrderData {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<NodeOrderData> | null;
      const groups = Array.isArray(raw?.groups) ? raw.groups.filter((g): g is string => typeof g === 'string') : [];
      const servers: Record<string, number[]> = {};
      if (raw?.servers && typeof raw.servers === 'object') {
        for (const [group, ids] of Object.entries(raw.servers)) {
          if (Array.isArray(ids)) servers[group] = ids.filter((id): id is number => Number.isSafeInteger(id));
        }
      }
      return { groups, servers };
    } catch {
      return { groups: [], servers: {} };
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    } catch {
      // 本地存储不可用时只是不记忆
    }
  }

  get isCustom(): boolean {
    return this.data.groups.length > 0 || Object.keys(this.data.servers).length > 0;
  }

  /** 按保存的顺序排；没出现在保存列表里的保持原相对顺序，放在后面 */
  private static apply<T>(items: T[], saved: (string | number)[] | undefined, keyOf: (item: T) => string | number): T[] {
    if (!saved?.length) return items;
    const rank = new Map(saved.map((key, index) => [key, index]));
    return items
      .map((item, index) => ({ item, index, rank: rank.get(keyOf(item)) }))
      .sort((a, b) => {
        if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
        if (a.rank !== undefined) return -1;
        if (b.rank !== undefined) return 1;
        return a.index - b.index;
      })
      .map(({ item }) => item);
  }

  sortGroups<T extends { key: string }>(groups: T[]): T[] {
    return NodeOrder.apply(groups, this.data.groups, (g) => g.key);
  }

  sortServers<T extends { id: number }>(groupKey: string, servers: T[]): T[] {
    return NodeOrder.apply(servers, this.data.servers[groupKey], (s) => s.id);
  }

  setGroups(keys: string[]): void {
    this.data.groups = keys;
    this.save();
  }

  setServers(groupKey: string, ids: number[]): void {
    this.data.servers[groupKey] = ids;
    this.save();
  }

  reset(): void {
    this.data = { groups: [], servers: {} };
    this.save();
  }

  /** 标签改名后沿用原来的分组位置与组内顺序；新名字本来就有排序时保留它自己的（相当于合并进去） */
  renameGroup(from: string, to: string): void {
    const index = this.data.groups.indexOf(from);
    if (index >= 0) {
      if (this.data.groups.includes(to)) this.data.groups.splice(index, 1);
      else this.data.groups[index] = to;
    }
    if (this.data.servers[from]) {
      this.data.servers[to] ??= this.data.servers[from];
      delete this.data.servers[from];
    }
    this.save();
  }
}
