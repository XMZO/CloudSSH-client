/** 节点分组与排序（节点首页与“调整排序”面板共用）。 */
import { groupServersByTag, type ServerConfig } from '@cloudssh/core';
import { t } from '../../upstream/frontend/src/i18n';
import { sortServers, type ServerSortMode } from '../../upstream/frontend/src/server-list';
import { NodeOrder } from '../shared/order';
import { mt } from './i18n';

export const RECENT_KEY = '__recent__';
export const UNGROUPED_KEY = '__ungrouped__';
/** 排序变化时在 window 上派发，节点首页据此重绘 */
export const ORDER_CHANGED_EVENT = 'cloudssh:node-order-changed';

export interface NodeGroup {
  key: string;
  label: string;
  servers: ServerConfig[];
}

/** 手动排序按实例分开保存（所有实例共用 tauri.localhost 这一个 origin） */
let cache: { id: string; order: NodeOrder } | null = null;
export function nodeOrder(): NodeOrder {
  const id = window.__cloudsshMobile?.state?.currentId ?? 'default';
  if (cache?.id !== id) cache = { id, order: new NodeOrder(`cloudssh_mobile_node_order:${id}`) };
  return cache.order;
}

/** 组内排序：自定义（手动拖动的顺序），或按网页版的规则（最近连接、最近修改、添加时间、名称） */
export type NodeSortMode = 'custom' | ServerSortMode;
export const NODE_SORT_MODES: NodeSortMode[] = ['custom', 'recent', 'updated', 'created', 'name'];

function sortModeKey(): string {
  return `cloudssh_mobile_node_sort:${window.__cloudsshMobile?.state?.currentId ?? 'default'}`;
}

export function nodeSortMode(): NodeSortMode {
  try {
    const value = localStorage.getItem(sortModeKey()) as NodeSortMode | null;
    return value && NODE_SORT_MODES.includes(value) ? value : 'custom';
  } catch {
    return 'custom';
  }
}

export function setNodeSortMode(mode: NodeSortMode): void {
  try {
    localStorage.setItem(sortModeKey(), mode);
  } catch {
    // 忽略
  }
  notifyOrderChanged();
}

const SORT_LABEL_KEYS = {
  recent: 'server.sortRecent',
  updated: 'server.sortUpdated',
  created: 'server.sortCreated',
  name: 'server.sortName',
} as const;

export function nodeSortLabel(mode: NodeSortMode): string {
  return mode === 'custom' ? mt('sortCustom') : t(SORT_LABEL_KEYS[mode]);
}

/** 全部分组（“未分组”也算一组）：分组顺序按手动排序，组内服务器按“组内排序” */
export function orderedGroups(servers: ServerConfig[]): NodeGroup[] {
  const { groups, ungrouped } = groupServersByTag(servers, { sort: 'name' });
  const all: NodeGroup[] = groups.map((group) => ({ key: group.key, label: group.label, servers: group.servers }));
  if (ungrouped.length) all.push({ key: UNGROUPED_KEY, label: mt('ungrouped'), servers: ungrouped });
  const order = nodeOrder();
  const mode = nodeSortMode();
  return order.sortGroups(all).map((group) => ({
    ...group,
    servers: mode === 'custom' ? order.sortServers(group.key, group.servers) : sortServers(group.servers, mode),
  }));
}

export function notifyOrderChanged(): void {
  window.dispatchEvent(new Event(ORDER_CHANGED_EVENT));
}
