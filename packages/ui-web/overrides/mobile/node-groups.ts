/** 节点分组与手动排序（节点首页与“调整排序”面板共用）。 */
import { groupServersByTag, type ServerConfig } from '@cloudssh/core';
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

/** 全部分组（“未分组”也算一组），分组顺序与组内服务器顺序都按手动排序 */
export function orderedGroups(servers: ServerConfig[]): NodeGroup[] {
  const { groups, ungrouped } = groupServersByTag(servers, { sort: 'name' });
  const all: NodeGroup[] = groups.map((group) => ({ key: group.key, label: group.label, servers: group.servers }));
  if (ungrouped.length) all.push({ key: UNGROUPED_KEY, label: mt('ungrouped'), servers: ungrouped });
  const order = nodeOrder();
  return order.sortGroups(all).map((group) => ({ ...group, servers: order.sortServers(group.key, group.servers) }));
}

export function notifyOrderChanged(): void {
  window.dispatchEvent(new Event(ORDER_CHANGED_EVENT));
}
