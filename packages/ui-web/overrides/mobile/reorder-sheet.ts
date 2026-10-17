/**
 * “调整排序”面板：第一页拖动分组顺序，点分组进入第二页拖动组内服务器顺序。
 * 节点首页本身不放拖动手柄，点按/长按/滚动都保持原样，排序集中在这里做。
 */
import { serverInitial, type ServerConfig } from '@cloudssh/core';
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { getServers } from '../sidebar/store';
import { makeReorderable } from '../shared/reorder';
import { mt } from './i18n';
import { nodeOrder, notifyOrderChanged, orderedGroups, type NodeGroup } from './node-groups';
import { confirmSheet, el, icon, openSheet } from './sheet';

function handle(): HTMLElement {
  const node = el('span', 'material-symbols-outlined cs-m-sort-handle', 'drag_indicator');
  node.dataset.reorderHandle = '';
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function hostLabel(server: ServerConfig): string {
  if (server.transport_type === 'cf_tunnel' && server.cf_tunnel_host) return server.cf_tunnel_host;
  return `${server.username}@${maskIPAddress(server.host) ?? server.host}`;
}

let cleanup: (() => void) | null = null;

function mountList(body: HTMLElement, list: HTMLElement, onReorder: (keys: string[]) => void): void {
  cleanup?.();
  const scroller = body.parentElement ?? body;
  cleanup = makeReorderable({ list, scroller, onReorder });
}

function groupsPage(body: HTMLElement): void {
  const servers = getServers() ?? [];
  const groups = orderedGroups(servers);
  const list = el('div', 'cs-m-sort-list');
  for (const group of groups) {
    const item = el('div', 'cs-m-sort-item');
    item.dataset.key = group.key;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    const text = el('span', 'cs-m-sort-text');
    const count = group.servers.length === 1 ? mt('sortGroupCountOne') : mt('sortGroupCount', { n: group.servers.length });
    text.append(el('span', 'cs-m-sort-name', group.label), el('span', 'cs-m-sort-sub', count));
    item.append(icon('folder'), text, icon('chevron_right'), handle());
    item.addEventListener('click', () => serversPage(body, group));
    list.append(item);
  }

  const reset = el('button', 'cs-m-btn cs-m-sort-reset', mt('sortReset'));
  reset.type = 'button';
  reset.addEventListener('click', async () => {
    if (!(await confirmSheet(mt('sortResetConfirm'), mt('sortReset'), mt('cancel'), true))) {
      void openReorderSheet();
      return;
    }
    nodeOrder().reset();
    notifyOrderChanged();
    notify(mt('sortResetDone'), { variant: 'success', duration: 1500 });
    void openReorderSheet();
  });

  body.replaceChildren(el('p', 'cs-m-hint cs-m-sort-hint', mt('sortGroupsHint')), groups.length ? list : el('div', 'cs-m-empty', mt('empty')), reset);
  mountList(body, list, (keys) => {
    nodeOrder().setGroups(keys);
    notifyOrderChanged();
  });
}

function serversPage(body: HTMLElement, group: NodeGroup): void {
  const back = el('button', 'cs-m-sort-back');
  back.type = 'button';
  back.append(icon('arrow_back'), el('span', '', group.label));
  back.addEventListener('click', () => groupsPage(body));

  const list = el('div', 'cs-m-sort-list');
  for (const server of group.servers) {
    const item = el('div', 'cs-m-sort-item');
    item.dataset.key = String(server.id);
    const text = el('span', 'cs-m-sort-text');
    text.append(el('span', 'cs-m-sort-name', server.name), el('span', 'cs-m-sort-sub', hostLabel(server)));
    item.append(el('span', 'cs-m-avatar', serverInitial(server.name)), text, handle());
    list.append(item);
  }

  body.replaceChildren(back, el('p', 'cs-m-hint cs-m-sort-hint', mt('sortServersHint')), list);
  (body.parentElement ?? body).scrollTop = 0;
  mountList(body, list, (keys) => {
    nodeOrder().setServers(group.key, keys.map(Number));
    notifyOrderChanged();
  });
}

/** 打开排序面板；传入分组 key 时直接进入该分组的服务器排序 */
export function openReorderSheet(groupKey?: string): void {
  const body = el('div', 'cs-m-sort');
  openSheet(mt('reorder'), body, {
    tall: true,
    onClose: () => {
      cleanup?.();
      cleanup = null;
    },
  });
  const group = groupKey ? orderedGroups(getServers() ?? []).find((g) => g.key === groupKey) : undefined;
  if (group) serversPage(body, group);
  else groupsPage(body);
}
