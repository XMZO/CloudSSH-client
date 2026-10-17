/**
 * 移动端节点首页：替代网页版每页 3 张卡片的分页网格。
 * - 按标签分组、可折叠，“最近连接”置顶，搜索
 * - 点按：已有会话就切过去，没有就新建连接；长按：操作面板（新建连接/切换会话/编辑/克隆/复制地址）
 * - 有会话时顶部显示“N 个会话进行中”，一键回到终端
 * - 分组与组内服务器的顺序在“调整排序”面板里拖动（reorder-sheet.ts），这里只按保存的顺序显示
 * 数据与动作复用桌面侧栏：旁听 /api/servers（store.ts），调用网页版自身逻辑（hooks.ts）。
 */
import { groupServersByTag, serverInitial, type ServerConfig } from '@cloudssh/core';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { osIconSvg } from '../../upstream/frontend/src/os-icons';
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
import { mt, onLocaleChange } from './i18n';
import { ORDER_CHANGED_EVENT, orderedGroups, RECENT_KEY, UNGROUPED_KEY } from './node-groups';
import { openReorderSheet } from './reorder-sheet';
import { el, icon, showActions } from './sheet';
import { openSettings } from './settings';

const COLLAPSED_KEY = 'cloudssh_mobile_collapsed_groups';
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
const settingsButton = el('button', 'cs-m-iconbtn cs-m-settings-btn');
settingsButton.type = 'button';
settingsButton.append(icon('tune'));
settingsButton.addEventListener('click', () => openSettings());
const reorderButton = el('button', 'cs-m-iconbtn cs-m-reorder-btn');
reorderButton.type = 'button';
reorderButton.append(icon('swap_vert'));
reorderButton.addEventListener('click', () => openReorderSheet());
bar.append(search, reorderButton, settingsButton);

const banner = el('button', 'cs-m-banner');
banner.type = 'button';
banner.hidden = true;
banner.addEventListener('click', () => document.getElementById('back-to-terminal-btn')?.click());

const list = el('div', 'cs-m-list');
root.append(bar, banner, list);

// ---------- 渲染 ----------

function hostLabel(server: ServerConfig): string {
  if (server.transport_type === 'cf_tunnel' && server.cf_tunnel_host) return server.cf_tunnel_host;
  return `${server.username}@${maskIPAddress(server.host) ?? server.host}`;
}

/** 首字母头像；识别出系统时附带品牌图标（经典主题隐藏，黑曜主题显示，见 hosts.css） */
const osIconCache = new Map<string, SVGElement | null>();
function osIcon(os: string): SVGElement | null {
  if (!osIconCache.has(os)) {
    const markup = osIconSvg(os);
    const svg = markup ? new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement : null;
    osIconCache.set(os, svg instanceof SVGElement ? svg : null);
  }
  const cached = osIconCache.get(os);
  return cached ? (cached.cloneNode(true) as SVGElement) : null;
}

function renderAvatar(server: ServerConfig): HTMLElement {
  const avatar = el('span', 'cs-m-avatar');
  avatar.append(el('span', 'cs-m-avatar-initial', serverInitial(server.name)));
  const svg = server.os ? osIcon(server.os) : null;
  if (svg) {
    const wrap = el('span', 'cs-m-os');
    wrap.append(svg);
    avatar.append(wrap);
    avatar.classList.add('has-os');
  }
  return avatar;
}

function renderRow(server: ServerConfig, sessions: Map<number, string[]>, activeId: number | null): HTMLElement {
  const row = el('button', 'cs-m-row-item');
  row.type = 'button';
  row.dataset.id = String(server.id);
  if (server.id === activeId) row.classList.add('is-active');
  const avatar = renderAvatar(server);
  const text = el('span', 'cs-m-row-text');
  text.append(el('span', 'cs-m-row-name', server.name), el('span', 'cs-m-row-sub', hostLabel(server)));
  row.append(avatar, text);
  const open = sessions.get(server.id)?.length ?? 0;
  if (open > 0) row.append(el('span', 'cs-m-badge', String(open)));
  row.append(icon('chevron_right'));
  return row;
}

function renderGroup(key: string, label: string, servers: ServerConfig[], sessions: Map<number, string[]>, activeId: number | null): HTMLElement {
  const group = el('div', 'cs-m-group');
  group.dataset.groupKey = key;
  const collapsed = state.collapsed.has(key) && !state.query;
  const header = el('button', 'cs-m-group-header');
  header.type = 'button';
  header.dataset.group = key;
  header.setAttribute('aria-expanded', String(!collapsed));
  header.append(icon(collapsed ? 'chevron_right' : 'expand_more'), el('span', 'cs-m-group-label', label), el('span', 'cs-m-group-count', String(servers.length)));
  group.append(header);
  if (!collapsed) {
    const body = el('div', 'cs-m-group-body');
    for (const server of servers) body.append(renderRow(server, sessions, activeId));
    group.append(body);
  }
  return group;
}

/**
 * 内容没变就不动 DOM。回到节点页时会连着来好几次刷新（标签栏变化、页面切换、网页版重新拉取列表），
 * 每次都整体替换会让列表闪几下，也会打断正在按下的行。列表上的点击、长按都委托在外层，保留旧节点没有问题。
 */
function replaceIfChanged(target: HTMLElement, nodes: Node[]): void {
  const next = document.createElement('div');
  next.append(...nodes);
  if (next.innerHTML !== target.innerHTML) target.replaceChildren(...next.childNodes);
}

function render(): void {
  const servers = getServers();
  document.documentElement.classList.toggle('cs-nodes-on', servers !== null);
  if (!servers) return;
  const sessions = sessionsByServer();
  const activeId = activeServerId();
  const tabs = tabCount();
  banner.hidden = tabs === 0;
  replaceIfChanged(banner, [
    icon('terminal'),
    el('span', '', mt(tabs === 1 ? 'sessionsBannerOne' : 'sessionsBanner', { n: tabs })),
    el('span', 'cs-m-banner-go', mt('backToTerminal')),
    icon('arrow_forward'),
  ]);

  const fragment = document.createDocumentFragment();
  if (!state.query) {
    const recent = [...servers]
      .filter((s) => (s.last_connected_at ?? 0) > 0)
      .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
      .slice(0, RECENT_LIMIT);
    if (recent.length) fragment.append(renderGroup(RECENT_KEY, mt('recent'), recent, sessions, activeId));
  }
  // 没有搜索时按手动排序显示；搜索结果按名称
  let total = servers.length;
  let groups = orderedGroups(servers);
  if (state.query) {
    const found = groupServersByTag(servers, { sort: 'name', query: state.query });
    total = found.total;
    groups = found.groups.map((g) => ({ key: g.key, label: g.label, servers: g.servers }));
    if (found.ungrouped.length) groups.push({ key: UNGROUPED_KEY, label: mt('ungrouped'), servers: found.ungrouped });
  }
  for (const group of groups) fragment.append(renderGroup(group.key, group.label, group.servers, sessions, activeId));
  if (total === 0) fragment.append(el('div', 'cs-m-empty', servers.length ? mt('noMatch') : mt('empty')));
  replaceIfChanged(list, [fragment]);
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

function showServerActions(server: ServerConfig, groupKey: string | null): void {
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
  actions.push({
    label: mt('reorder'),
    icon: 'swap_vert',
    action: () => void openReorderSheet(groupKey && groupKey !== RECENT_KEY ? groupKey : undefined),
  });
  showActions(server.name, actions, mt('cancel'));
}

let longPressFired = false;
list.addEventListener('contextmenu', (event) => {
  const server = serverOf(event.target);
  if (!server) return;
  event.preventDefault();
  longPressFired = true;
  const groupKey = (event.target as HTMLElement).closest<HTMLElement>('.cs-m-group')?.dataset.groupKey ?? null;
  showServerActions(server, groupKey);
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
  reorderButton.setAttribute('aria-label', mt('reorder'));
  reorderButton.title = mt('reorder');
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
  window.addEventListener(ORDER_CHANGED_EVENT, scheduleRender);
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
