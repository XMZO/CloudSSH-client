/**
 * 移动端节点首页：替代网页版每页 3 张卡片的分页网格。
 * - 按标签分组、可折叠，“最近连接”置顶，搜索
 * - 点按：已有会话就切过去，没有就新建连接；长按：操作面板（新建连接/切换会话/编辑/克隆/复制地址）
 * - 有会话时顶部显示“N 个会话进行中”，一键回到终端
 * 数据与动作复用桌面侧栏：旁听 /api/servers（store.ts），调用网页版自身逻辑（hooks.ts）。
 */
import { groupServersByTag, serverInitial, type ServerConfig } from '@cloudssh/core';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import {
  activeServerId,
  connectServer,
  focusSession,
  openServerModal,
  sessionsByServer,
  tabCount,
} from '../sidebar/hooks';
import { getServers, subscribe } from '../sidebar/store';
import { NodeOrder } from '../shared/order';
import { dragHandle, installSortable, scrollParent } from '../shared/sortable';
import { mt, onLocaleChange } from './i18n';
import { el, icon, showActions } from './sheet';
import { openSettings } from './settings';

const COLLAPSED_KEY = 'cloudssh_mobile_collapsed_groups';
const RECENT_KEY = '__recent__';
const UNGROUPED_KEY = '__ungrouped__';

/** 手动排序按实例分开保存（所有实例共用 tauri.localhost 这一个 origin） */
let orderCache: { id: string; order: NodeOrder } | null = null;
function nodeOrder(): NodeOrder {
  const id = window.__cloudsshMobile?.state?.currentId ?? 'default';
  if (orderCache?.id !== id) orderCache = { id, order: new NodeOrder(`cloudssh_mobile_node_order:${id}`) };
  return orderCache.order;
}
const RECENT_LIMIT = 5;

const state = {
  query: '',
  collapsed: new Set<string>(loadCollapsed()),
};

function loadCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function saveCollapsed(): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsed]));
  } catch {
    // 本地存储不可用时只是不记忆
  }
}

// ---------- 结构 ----------

const root = el('section', 'cs-m-nodes');
root.id = 'cs-mobile-nodes';

const bar = el('div', 'cs-m-nodes-bar');
const search = el('label', 'cs-m-search');
const searchInput = el('input');
searchInput.type = 'search';
searchInput.enterKeyHint = 'search';
searchInput.autocomplete = 'off';
search.append(icon('search'), searchInput);
const settingsButton = el('button', 'cs-m-iconbtn');
settingsButton.type = 'button';
settingsButton.append(icon('tune'));
settingsButton.addEventListener('click', () => openSettings());
bar.append(search, settingsButton);

const banner = el('button', 'cs-m-banner');
banner.type = 'button';
banner.hidden = true;
banner.addEventListener('click', () => document.getElementById('back-to-terminal-btn')?.click());

const list = el('div', 'cs-m-list');
list.dataset.sortScope = 'groups';
root.append(bar, banner, list);

// ---------- 渲染 ----------

function hostLabel(server: ServerConfig): string {
  if (server.transport_type === 'cf_tunnel' && server.cf_tunnel_host) return server.cf_tunnel_host;
  return `${server.username}@${maskIPAddress(server.host) ?? server.host}`;
}

function renderRow(server: ServerConfig, sessions: Map<number, string[]>, activeId: number | null, sortable: boolean): HTMLElement {
  const row = el('button', 'cs-m-row-item');
  row.type = 'button';
  row.dataset.id = String(server.id);
  if (sortable) row.dataset.sortKey = String(server.id);
  if (server.id === activeId) row.classList.add('is-active');
  const avatar = el('span', 'cs-m-avatar', serverInitial(server.name));
  const text = el('span', 'cs-m-row-text');
  text.append(el('span', 'cs-m-row-name', server.name), el('span', 'cs-m-row-sub', hostLabel(server)));
  row.append(avatar, text);
  const open = sessions.get(server.id)?.length ?? 0;
  if (open > 0) row.append(el('span', 'cs-m-badge', String(open)));
  row.append(sortable ? dragHandle('cs-m-drag', mt('dragToSort')) : icon('chevron_right'));
  return row;
}

function renderGroup(key: string, label: string, servers: ServerConfig[], sessions: Map<number, string[]>, activeId: number | null): HTMLElement {
  const group = el('div', 'cs-m-group');
  // 搜索结果与“最近连接”不参与手动排序
  const sortable = !state.query && key !== RECENT_KEY;
  if (sortable) group.dataset.sortKey = key;
  const collapsed = state.collapsed.has(key) && !state.query;
  const header = el('button', 'cs-m-group-header');
  header.type = 'button';
  header.dataset.group = key;
  header.setAttribute('aria-expanded', String(!collapsed));
  header.append(icon(collapsed ? 'chevron_right' : 'expand_more'), el('span', 'cs-m-group-label', label), el('span', 'cs-m-group-count', String(servers.length)));
  if (sortable) header.append(dragHandle('cs-m-drag', mt('dragToSort')));
  group.append(header);
  if (!collapsed) {
    const body = el('div', 'cs-m-group-body');
    if (sortable) body.dataset.sortScope = `group:${key}`;
    const ordered = sortable ? nodeOrder().sortServers(key, servers) : servers;
    for (const server of ordered) body.append(renderRow(server, sessions, activeId, sortable));
    group.append(body);
  }
  return group;
}

function render(): void {
  const servers = getServers();
  document.documentElement.classList.toggle('cs-nodes-on', servers !== null);
  if (!servers) return;
  const sessions = sessionsByServer();
  const activeId = activeServerId();
  const tabs = tabCount();
  banner.hidden = tabs === 0;
  banner.replaceChildren(icon('terminal'), el('span', '', mt('sessionsBanner', { n: tabs })), el('span', 'cs-m-banner-go', mt('backToTerminal')), icon('arrow_forward'));

  const { groups, ungrouped, total } = groupServersByTag(servers, { sort: 'name', query: state.query });
  const fragment = document.createDocumentFragment();
  if (!state.query) {
    const recent = [...servers]
      .filter((s) => (s.last_connected_at ?? 0) > 0)
      .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
      .slice(0, RECENT_LIMIT);
    if (recent.length) fragment.append(renderGroup(RECENT_KEY, mt('recent'), recent, sessions, activeId));
  }
  // “未分组”也作为一个可拖动的分组参与排序
  const all = [...groups.map((g) => ({ key: g.key, label: g.label, servers: g.servers }))];
  if (ungrouped.length) all.push({ key: UNGROUPED_KEY, label: mt('ungrouped'), servers: ungrouped });
  for (const group of state.query ? all : nodeOrder().sortGroups(all)) {
    fragment.append(renderGroup(group.key, group.label, group.servers, sessions, activeId));
  }
  if (total === 0) fragment.append(el('div', 'cs-m-empty', servers.length ? mt('noMatch') : mt('empty')));
  list.replaceChildren(fragment);
}

let frame = 0;
function scheduleRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

// ---------- 交互 ----------

function serverOf(target: EventTarget | null): ServerConfig | null {
  const row = (target as HTMLElement | null)?.closest<HTMLElement>('.cs-m-row-item');
  const id = row ? Number(row.dataset.id) : NaN;
  return getServers()?.find((s) => s.id === id) ?? null;
}

function connectOrSwitch(server: ServerConfig): void {
  if ((sessionsByServer().get(server.id)?.length ?? 0) > 0 && focusSession(server.id)) return;
  if (!connectServer(server.id)) notify(mt('noMatch'), { variant: 'warning' });
}

function showServerActions(server: ServerConfig): void {
  const open = sessionsByServer().get(server.id)?.length ?? 0;
  const actions = [{ label: mt('connectNew'), icon: 'add_circle', action: () => void connectServer(server.id) }];
  if (open > 0) actions.push({ label: `${mt('switchSession')} (${open})`, icon: 'swap_horiz', action: () => void focusSession(server.id) });
  actions.push(
    { label: mt('edit'), icon: 'edit', action: () => void openServerModal('edit', server.id) },
    { label: mt('clone'), icon: 'content_copy', action: () => void openServerModal('clone', server.id) },
    {
      label: mt('copyHost'),
      icon: 'link',
      action: () => {
        const host = server.transport_type === 'cf_tunnel' && server.cf_tunnel_host ? server.cf_tunnel_host : server.host;
        void copyTextToClipboard(host).then((ok) => ok && notify(mt('copied'), { variant: 'success', duration: 1500 }));
      },
    }
  );
  showActions(server.name, actions, mt('cancel'));
}

let longPressFired = false;
list.addEventListener('contextmenu', (event) => {
  const server = serverOf(event.target);
  if (!server) return;
  event.preventDefault();
  longPressFired = true;
  showServerActions(server);
});
list.addEventListener('click', (event) => {
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  const header = (event.target as HTMLElement).closest<HTMLElement>('.cs-m-group-header');
  if (header?.dataset.group) {
    const key = header.dataset.group;
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    saveCollapsed();
    render();
    return;
  }
  const server = serverOf(event.target);
  if (server) connectOrSwitch(server);
});
list.addEventListener('pointerdown', () => (longPressFired = false));

let searchTimer = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = searchInput.value.trim();
    render();
  }, 120);
});

function applyTexts(): void {
  searchInput.placeholder = mt('search');
  settingsButton.setAttribute('aria-label', mt('settings'));
  settingsButton.title = mt('settings');
}

// ---------- 挂载 ----------

export function mountNodes(): void {
  const toolbar = document.querySelector('#user-space-section .server-list-toolbar');
  if (!toolbar?.parentElement) {
    console.warn('[cloudssh-mobile] 找不到服务器列表工具栏，节点首页未挂载');
    return;
  }
  toolbar.after(root);
  applyTexts();
  installSortable({
    root: list,
    scroller: () => scrollParent(list),
    compactClass: (scope) => (scope === 'groups' ? 'cs-m-compact' : null),
    onSort: (scope, keys) => {
      if (scope === 'groups') nodeOrder().setGroups(keys);
      else if (scope.startsWith('group:')) nodeOrder().setServers(scope.slice(6), keys.map(Number));
      render();
    },
  });
  subscribe(scheduleRender);
  onLocaleChange(() => {
    applyTexts();
    scheduleRender();
  });
  const observer = new MutationObserver(scheduleRender);
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) observer.observe(tabBar, { childList: true, subtree: true });
  for (const id of ['terminal-section', 'user-space-section']) {
    const node = document.getElementById(id);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  render();
}
