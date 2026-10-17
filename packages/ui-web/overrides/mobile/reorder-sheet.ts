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
import {
  NODE_SORT_MODES,
  nodeOrder,
  nodeSortLabel,
  nodeSortMode,
  notifyOrderChanged,
  orderedGroups,
  setNodeSortMode,
  type NodeGroup,
} from './node-groups';
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

/** 组内排序：一排选项，选中立即生效（节点首页随之重绘） */
function sortModes(): HTMLElement {
  const wrap = el('div', 'cs-m-sort-modes');
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', mt('sortMode'));
  const current = nodeSortMode();
  for (const mode of NODE_SORT_MODES) {
    const chip = el('button', 'cs-m-sort-mode', nodeSortLabel(mode));
    chip.type = 'button';
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(mode === current));
    chip.classList.toggle('is-on', mode === current);
    chip.addEventListener('click', () => {
      wrap.querySelectorAll<HTMLElement>('.cs-m-sort-mode').forEach((item) => {
        const on = item === chip;
        item.classList.toggle('is-on', on);
        item.setAttribute('aria-checked', String(on));
      });
      setNodeSortMode(mode);
    });
    wrap.append(chip);
  }
  const section = el('div', 'cs-m-sort-mode-section');
  section.append(el('span', 'cs-m-sort-mode-title', mt('sortMode')), wrap);
  return section;
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

  body.replaceChildren(
    sortModes(),
    el('p', 'cs-m-hint cs-m-sort-hint', mt('sortGroupsHint')),
    groups.length ? list : el('div', 'cs-m-empty', mt('empty')),
    reset
  );
  mountList(body, list, (keys) => {
    nodeOrder().setGroups(keys);
    notifyOrderChanged();
  });
}

function serversPage(body: HTMLElement, entry: NodeGroup): void {
  // 进入时按当前的“组内排序”重新取一次（面板打开后可能刚切换过排序方式）
  const group = orderedGroups(getServers() ?? []).find((item) => item.key === entry.key) ?? entry;
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

  // 按规则排序时，列表就是当前看到的顺序；拖动调整后改为自定义顺序
  const mode = nodeSortMode();
  const hint = mode === 'custom' ? mt('sortServersHint') : mt('sortModeHint', { mode: nodeSortLabel(mode) });
  body.replaceChildren(back, el('p', 'cs-m-hint cs-m-sort-hint', hint), list);
  (body.parentElement ?? body).scrollTop = 0;
  mountList(body, list, (keys) => {
    if (nodeSortMode() !== 'custom') {
      // 改为自定义前，先把其他分组当前看到的顺序记下来，免得它们跳回按名称排列
      for (const other of orderedGroups(getServers() ?? [])) {
        if (other.key !== group.key) nodeOrder().setServers(other.key, other.servers.map((server) => server.id));
      }
      nodeOrder().setServers(group.key, keys.map(Number));
      setNodeSortMode('custom');
      return;
    }
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
