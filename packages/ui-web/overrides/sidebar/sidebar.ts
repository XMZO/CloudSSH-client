/**
 * 桌面端左侧节点侧栏（参考 Termius）：按标签分组、可折叠、搜索、双击连接、会话指示。
 *
 * - 数据：store.ts 旁听网页版的 /api/servers
 * - 动作：hooks.ts 调用网页版自身的连接 / 编辑 / 切换标签逻辑
 * - 只在已登录、非分享页、窗口足够宽时显示；收起后保留一条窄栏
 */
import {
  groupServersByTag,
  SERVER_GROUP_SORTS,
  serverInitial,
  type ServerConfig,
  type ServerGroupSort,
} from '@cloudssh/core';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import {
  activeServerId,
  canConnect,
  canShare,
  connectServer,
  deleteServer,
  focusSession,
  openServerModal,
  sessionsByServer,
  shareServer,
} from './hooks';
import { osIcon } from '../shared/os-icon';
import { copyTagName, renameTag, TAG_RENAMED_EVENT, type TagRenamed } from '../shared/server-tags';
import { onLocaleChange, st } from './i18n';
import { getServers, installFetchObserver, reloadServers, subscribe } from './store';
import { NodeOrder } from '../shared/order';
import { openHighlightEditor } from '../shared/terminal';
import { dragHandle, installSortable } from '../shared/sortable';
import './sidebar.css';

const KEYS = {
  width: 'cloudssh_desktop_sidebar_width',
  collapsed: 'cloudssh_desktop_sidebar_collapsed',
  groups: 'cloudssh_desktop_sidebar_collapsed_groups',
  sort: 'cloudssh_desktop_sidebar_sort',
  order: 'cloudssh_desktop_node_order',
};

/** 排序方式：core 提供的三种 + 拖动产生的手动排序 */
type SidebarSort = ServerGroupSort | 'custom';
const SIDEBAR_SORTS: readonly SidebarSort[] = [...SERVER_GROUP_SORTS, 'custom'];
const UNGROUPED_KEY = '__ungrouped__';
/** 页面就在实例 origin 下，localStorage 天然按实例隔离 */
const nodeOrder = new NodeOrder(KEYS.order);
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 280;
const RAIL_WIDTH = 44;
/** 窗口比这窄时不显示侧栏（留给网页版自己的移动端布局） */
const MIN_VIEWPORT = 760;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 本地存储不可用时只是不记忆
  }
}

const state = {
  width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(load(KEYS.width, DEFAULT_WIDTH)) || DEFAULT_WIDTH)),
  collapsed: load<unknown>(KEYS.collapsed, false) === true,
  collapsedGroups: new Set<string>(load<string[]>(KEYS.groups, [])),
  sort: ((): SidebarSort => {
    const value = load<string>(KEYS.sort, 'name');
    return (SIDEBAR_SORTS as readonly string[]).includes(value) ? (value as SidebarSort) : 'name';
  })(),
  query: '',
  selectedId: null as number | null,
  visible: false,
};

// ---------- DOM 工具 ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string): HTMLSpanElement {
  const span = el('span', 'material-symbols-outlined cs-sb-icon', name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function iconButton(name: string, label: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const button = el('button', 'cs-sb-btn');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

// ---------- 结构 ----------

const root = el('aside', 'cs-sb');
root.id = 'cloudssh-sidebar';
root.setAttribute('aria-label', 'servers');

const header = el('div', 'cs-sb-header');
const title = el('div', 'cs-sb-title');
const titleText = el('span');
const titleCount = el('span', 'cs-sb-count');
title.append(titleText, titleCount);
const actions = el('div', 'cs-sb-actions');
const sortButton = iconButton('sort', '', (event) => toggleSortMenu(event.currentTarget as HTMLElement));
const addButton = iconButton('add', '', () => openServerModal('add'));
const refreshButton = iconButton('refresh', '', () => void reloadServers().catch(() => undefined));
const highlightButton = iconButton('format_color_text', '', () => openHighlightEditor());
const collapseButton = iconButton('left_panel_close', '', () => setCollapsed(true));
actions.append(sortButton, addButton, refreshButton, highlightButton, collapseButton);
header.append(title, actions);

const searchBox = el('label', 'cs-sb-search');
const searchInput = el('input');
searchInput.type = 'search';
searchInput.spellcheck = false;
searchInput.autocomplete = 'off';
searchBox.append(icon('search'), searchInput);

const list = el('div', 'cs-sb-list');
list.dataset.sortScope = 'groups';
list.tabIndex = 0;
list.setAttribute('role', 'tree');

const footer = el('div', 'cs-sb-footer');
const instanceLabel = el('span', 'cs-sb-instance');
const manageButton = iconButton('dns', '', () => void window.cloudsshDesktop?.openInstanceManager?.());
footer.append(icon('cloud'), instanceLabel, manageButton);
footer.hidden = true;

const resizer = el('div', 'cs-sb-resizer');
resizer.setAttribute('role', 'separator');
resizer.setAttribute('aria-orientation', 'vertical');

root.append(header, searchBox, list, footer, resizer);

const rail = el('div', 'cs-sb-rail');
rail.id = 'cloudssh-sidebar-rail';
const railExpand = iconButton('left_panel_open', '', () => setCollapsed(false));
const railSearch = iconButton('search', '', () => {
  setCollapsed(false);
  searchInput.focus();
});
const railAdd = iconButton('add', '', () => openServerModal('add'));
rail.append(railExpand, railSearch, railAdd);

const menu = el('div', 'cs-sb-menu');
menu.setAttribute('role', 'menu');
menu.hidden = true;

// ---------- 文案 ----------

function applyTexts(): void {
  titleText.textContent = st('title');
  searchInput.placeholder = st('search');
  for (const [button, key] of [
    [sortButton, 'sort'],
    [addButton, 'add'],
    [refreshButton, 'refresh'],
    [highlightButton, 'highlight'],
    [collapseButton, 'collapse'],
    [railExpand, 'expand'],
    [railAdd, 'add'],
    [manageButton, 'manageInstances'],
  ] as const) {
    button.title = st(key);
    button.setAttribute('aria-label', st(key));
  }
  railSearch.title = st('search');
}

// ---------- 布局 ----------

function applyLayout(): void {
  const html = document.documentElement;
  html.style.setProperty('--cs-sb-width', `${state.width}px`);
  html.style.setProperty('--cs-sb-rail', `${RAIL_WIDTH}px`);
  html.classList.toggle('cs-sb-on', state.visible && !state.collapsed);
  html.classList.toggle('cs-sb-railed', state.visible && state.collapsed);
}

let refitFrame = 0;
/** 侧栏宽度变化不会触发窗口 resize，主动通知终端重新适配列数 */
function refitTerminal(): void {
  cancelAnimationFrame(refitFrame);
  refitFrame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function setCollapsed(collapsed: boolean): void {
  state.collapsed = collapsed;
  save(KEYS.collapsed, collapsed);
  applyLayout();
  refitTerminal();
}

function shouldShow(): boolean {
  const authSection = document.getElementById('auth-section');
  const authVisible = !!authSection && !authSection.classList.contains('hidden');
  return (
    getServers() !== null &&
    !authVisible &&
    !location.hash.startsWith('#/share') &&
    window.innerWidth >= MIN_VIEWPORT
  );
}

function updateVisibility(): void {
  const next = shouldShow();
  if (next === state.visible) return;
  state.visible = next;
  applyLayout();
  refitTerminal();
}

// ---------- 渲染 ----------

function hostLabel(server: ServerConfig): string {
  if (server.transport_type === 'cf_tunnel' && server.cf_tunnel_host) return server.cf_tunnel_host;
  const host = maskIPAddress(server.host) ?? server.host;
  return `${server.username}@${host}:${server.port}`;
}

function renderItem(server: ServerConfig, sessions: Map<number, string[]>, activeId: number | null, sortable: boolean): HTMLElement {
  const item = el('div', 'cs-sb-item');
  item.dataset.id = String(server.id);
  if (sortable) item.dataset.sortKey = String(server.id);
  item.setAttribute('role', 'treeitem');
  item.title = `${server.name}\n${hostLabel(server)}`;
  if (server.id === state.selectedId) item.classList.add('is-selected');
  if (server.id === activeId) item.classList.add('is-active');

  // 识别出系统时显示系统图标（与服务器表格、手机节点页一致），否则首字母
  const svg = osIcon(server.os);
  const avatar = el('span', svg ? 'cs-sb-avatar has-os' : 'cs-sb-avatar', svg ? undefined : serverInitial(server.name));
  if (svg) avatar.append(svg);
  const name = el('span', 'cs-sb-name', server.name);
  item.append(avatar, name);

  const open = sessions.get(server.id)?.length ?? 0;
  if (open > 0) {
    const badge = el('button', 'cs-sb-session', open > 1 ? String(open) : '');
    badge.type = 'button';
    badge.title = `${st('focusSession')}（${open} ${st('sessions')}）`;
    badge.addEventListener('click', (event) => {
      event.stopPropagation();
      focusSession(server.id);
    });
    item.append(badge);
  }

  const go = iconButton('play_arrow', st('connect'), (event) => {
    event.stopPropagation();
    connect(server.id);
  });
  go.classList.add('cs-sb-go');
  item.append(go);
  if (sortable) item.append(dragHandle('cs-sb-drag', st('dragToSort')));
  return item;
}

function renderGroupHeader(key: string, label: string, count: number, sortable: boolean): HTMLElement {
  const collapsed = state.collapsedGroups.has(key) && !state.query;
  const row = el('div', 'cs-sb-group');
  row.dataset.group = key;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', String(!collapsed));
  row.append(icon(collapsed ? 'chevron_right' : 'expand_more'), el('span', 'cs-sb-group-label', label), el('span', 'cs-sb-group-count', String(count)));
  if (sortable) row.append(dragHandle('cs-sb-drag', st('dragToSort')));
  return row;
}

/** 拖动排序进行中：暂停重绘（重绘会替换掉正在拖动的行），结束后补一次 */
let dragging = false;
let renderPending = false;

function render(): void {
  if (dragging) {
    renderPending = true;
    return;
  }
  renderPending = false;
  updateVisibility();
  const servers = getServers();
  if (!servers) return;
  const sessions = sessionsByServer();
  const activeId = activeServerId();
  const custom = state.sort === 'custom';
  const result = groupServersByTag(servers, { sort: state.sort === 'custom' ? 'name' : state.sort, query: state.query });
  const { ungrouped, total } = result;
  // 搜索结果不参与拖动排序
  const sortable = !state.query;
  const groups = custom && sortable ? nodeOrder.sortGroups(result.groups) : result.groups;
  const ordered = (key: string, items: ServerConfig[]) => (custom && sortable ? nodeOrder.sortServers(key, items) : items);
  titleCount.textContent = String(state.query ? `${total}/${servers.length}` : servers.length);

  const scrollTop = list.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    // 分组标题与内容包在一起，整组拖动
    const section = el('div', 'cs-sb-section');
    if (sortable) section.dataset.sortKey = group.key;
    section.append(renderGroupHeader(group.key, group.label, group.servers.length, sortable));
    fragment.append(section);
    if (state.collapsedGroups.has(group.key) && !state.query) continue;
    const body = el('div', 'cs-sb-group-body');
    body.setAttribute('role', 'group');
    if (sortable) body.dataset.sortScope = `group:${group.key}`;
    for (const server of ordered(group.key, group.servers)) body.append(renderItem(server, sessions, activeId, sortable));
    section.append(body);
  }
  if (ungrouped.length) {
    const body = el('div', 'cs-sb-group-body cs-sb-ungrouped');
    if (sortable) body.dataset.sortScope = `group:${UNGROUPED_KEY}`;
    for (const server of ordered(UNGROUPED_KEY, ungrouped)) body.append(renderItem(server, sessions, activeId, sortable));
    fragment.append(body);
  }
  if (total === 0) fragment.append(el('div', 'cs-sb-empty', servers.length ? st('noMatch') : st('empty')));
  list.replaceChildren(fragment);
  list.scrollTop = scrollTop;
}

// ---------- 拖动排序 ----------

/** 把当前看到的顺序整体记下来（从按名称/数量/最近切到手动排序时，其余分组保持原样） */
function snapshotOrder(): void {
  const sections = [...list.querySelectorAll<HTMLElement>(':scope > .cs-sb-section[data-sort-key]')];
  nodeOrder.setGroups(sections.map((section) => section.dataset.sortKey as string));
  for (const body of list.querySelectorAll<HTMLElement>('.cs-sb-group-body[data-sort-scope]')) {
    const ids = [...body.querySelectorAll<HTMLElement>(':scope > [data-sort-key]')].map((item) => Number(item.dataset.sortKey));
    nodeOrder.setServers((body.dataset.sortScope as string).slice('group:'.length), ids);
  }
}

/** 保存当前看到的顺序并切到手动排序 */
function commitOrder(): void {
  snapshotOrder();
  if (state.sort !== 'custom') {
    state.sort = 'custom';
    save(KEYS.sort, 'custom');
  }
  render();
}

// 整行都能拖（鼠标按住移动几像素即开始），拖分组时暂时收起各组内容
installSortable({
  root: list,
  scroller: () => list,
  compactClass: (scope) => (scope === 'groups' ? 'cs-sb-compact' : null),
  onSort: commitOrder,
  onDragState: (active) => {
    dragging = active;
    if (!active && renderPending) render();
  },
});

/** Alt+↑/↓：把选中的节点在所在分组里上移/下移一位（搜索结果不参与排序） */
function moveSelected(step: -1 | 1): void {
  if (state.selectedId === null || state.query || dragging) return;
  const item = visibleItems().find((node) => Number(node.dataset.id) === state.selectedId && node.dataset.sortKey !== undefined);
  if (!item?.parentElement?.dataset.sortScope) return;
  const sibling = step < 0 ? item.previousElementSibling : item.nextElementSibling;
  if (!(sibling instanceof HTMLElement) || sibling.dataset.sortKey === undefined) return;
  if (step < 0) sibling.before(item);
  else sibling.after(item);
  commitOrder();
  select(state.selectedId, true);
}

// ---------- 动作 ----------

function connect(id: number): void {
  state.selectedId = id;
  if (!connectServer(id)) {
    notify(st('hooksMissing'), { variant: 'warning' });
  }
}

function visibleItems(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>('.cs-sb-item')];
}

function select(id: number | null, scroll = false): void {
  state.selectedId = id;
  for (const item of visibleItems()) {
    const selected = Number(item.dataset.id) === id;
    item.classList.toggle('is-selected', selected);
    if (selected && scroll) item.scrollIntoView({ block: 'nearest' });
  }
}

function toggleGroup(key: string): void {
  if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
  else state.collapsedGroups.add(key);
  save(KEYS.groups, [...state.collapsedGroups]);
  render();
}

// ---------- 菜单 ----------

function closeMenu(): void {
  menu.hidden = true;
  menu.replaceChildren();
}

interface MenuEntry {
  label: string;
  icon: string;
  checked?: boolean;
  /** 危险操作（删除）：红色显示，前面加一条分隔线 */
  danger?: boolean;
  action: () => void;
}

function showMenu(x: number, y: number, entries: MenuEntry[]): void {
  menu.replaceChildren();
  for (const entry of entries) {
    if (entry.danger && menu.childElementCount) menu.append(el('div', 'cs-sb-menu-sep'));
    const item = el('button', entry.danger ? 'cs-sb-menu-item is-danger' : 'cs-sb-menu-item');
    item.type = 'button';
    item.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (entry.checked !== undefined) item.setAttribute('aria-checked', String(entry.checked));
    item.append(icon(entry.checked ? 'check' : entry.icon), el('span', '', entry.label));
    item.addEventListener('click', () => {
      closeMenu();
      entry.action();
    });
    menu.append(item);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  (menu.firstElementChild as HTMLElement | null)?.focus();
}

function toggleSortMenu(anchor: HTMLElement): void {
  if (!menu.hidden) return closeMenu();
  const rect = anchor.getBoundingClientRect();
  const labels: Record<SidebarSort, string> = { name: st('sortName'), count: st('sortCount'), recent: st('sortRecent'), custom: st('sortCustom') };
  showMenu(
    rect.left,
    rect.bottom + 4,
    SIDEBAR_SORTS.map((sort) => ({
      label: labels[sort],
      icon: 'radio_button_unchecked',
      checked: state.sort === sort,
      action: () => {
        state.sort = sort;
        save(KEYS.sort, sort);
        render();
      },
    }))
  );
}

function showItemMenu(event: MouseEvent, server: ServerConfig): void {
  const open = sessionsByServer().get(server.id)?.length ?? 0;
  const entries: MenuEntry[] = [{ label: st('connect'), icon: 'play_arrow', action: () => connect(server.id) }];
  if (open > 0) entries.push({ label: `${st('focusSession')} (${open})`, icon: 'tab', action: () => void focusSession(server.id) });
  entries.push(
    { label: st('edit'), icon: 'edit', action: () => void openServerModal('edit', server.id) },
    { label: st('clone'), icon: 'content_copy', action: () => void openServerModal('clone', server.id) },
    {
      label: st('copyName'),
      icon: 'label',
      action: () => void copyTextToClipboard(server.name).then((ok) => ok && notify(st('copied'), { variant: 'success', duration: 1500 })),
    },
    {
      label: st('copyHost'),
      icon: 'link',
      action: () => {
        const host = server.transport_type === 'cf_tunnel' && server.cf_tunnel_host ? server.cf_tunnel_host : server.host;
        void copyTextToClipboard(host).then((ok) => ok && notify(st('copied'), { variant: 'success', duration: 1500 }));
      },
    }
  );
  // 一次性分享只在 Worker 开启分享时提供；删除走网页版自己的确认与报错（与卡片上的按钮一致）
  if (canShare()) entries.push({ label: st('share'), icon: 'share', action: () => void shareServer(server.id) });
  entries.push({ label: st('delete'), icon: 'delete', danger: true, action: () => void deleteServer(server.id) });
  showMenu(event.clientX, event.clientY, entries);
}

// ---------- 事件 ----------

function serverFromEvent(event: Event): ServerConfig | null {
  const item = (event.target as HTMLElement).closest<HTMLElement>('.cs-sb-item');
  if (!item) return null;
  const id = Number(item.dataset.id);
  return getServers()?.find((server) => server.id === id) ?? null;
}

list.addEventListener('click', (event) => {
  const group = (event.target as HTMLElement).closest<HTMLElement>('.cs-sb-group');
  if (group?.dataset.group) return toggleGroup(group.dataset.group);
  const server = serverFromEvent(event);
  if (server) select(server.id);
});

list.addEventListener('dblclick', (event) => {
  if ((event.target as Element).closest('[data-drag-handle]')) return;
  const server = serverFromEvent(event);
  if (server) connect(server.id);
});

list.addEventListener('contextmenu', (event) => {
  const server = serverFromEvent(event);
  if (server) {
    event.preventDefault();
    select(server.id);
    showItemMenu(event, server);
    return;
  }
  // 分组标题（标签）：重命名、复制名称（“未分组”不是标签）
  const group = (event.target as Element).closest<HTMLElement>('.cs-sb-group');
  const tag = group?.dataset.group;
  if (!tag || tag === UNGROUPED_KEY) return;
  event.preventDefault();
  showMenu(event.clientX, event.clientY, [
    { label: st('renameTag'), icon: 'edit', action: () => void renameTag(tag) },
    { label: st('copyTagName'), icon: 'content_copy', action: () => void copyTagName(tag) },
  ]);
});

// 标签改名后，按标签名记住的折叠状态与手动排序跟过去
window.addEventListener(TAG_RENAMED_EVENT, (event) => {
  const { from, to } = (event as CustomEvent<TagRenamed>).detail;
  if (state.collapsedGroups.delete(from)) {
    state.collapsedGroups.add(to);
    save(KEYS.groups, [...state.collapsedGroups]);
  }
  nodeOrder.renameGroup(from, to);
  render();
});

list.addEventListener('keydown', (event) => {
  const items = visibleItems();
  if (!items.length) return;
  const index = items.findIndex((item) => Number(item.dataset.id) === state.selectedId);
  if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    moveSelected(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
    select(Number(items[next].dataset.id), true);
  } else if (event.key === 'Enter' && state.selectedId !== null) {
    event.preventDefault();
    connect(state.selectedId);
  }
});

let searchTimer = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = searchInput.value.trim();
    render();
  }, 80);
});
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    searchInput.value = '';
    state.query = '';
    render();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    const first = visibleItems()[0];
    if (first) {
      select(Number(first.dataset.id), true);
      list.focus();
    }
  } else if (event.key === 'Enter') {
    const first = visibleItems()[0];
    if (first) connect(Number(first.dataset.id));
  }
});

// 拖动调整宽度
resizer.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  document.documentElement.classList.add('cs-sb-resizing');
  const onMove = (move: PointerEvent) => {
    state.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(move.clientX)));
    applyLayout();
  };
  const onUp = () => {
    resizer.removeEventListener('pointermove', onMove);
    document.documentElement.classList.remove('cs-sb-resizing');
    save(KEYS.width, state.width);
    refitTerminal();
  };
  resizer.addEventListener('pointermove', onMove);
  resizer.addEventListener('pointerup', onUp, { once: true });
  resizer.addEventListener('pointercancel', onUp, { once: true });
});
resizer.addEventListener('dblclick', () => {
  state.width = DEFAULT_WIDTH;
  save(KEYS.width, state.width);
  applyLayout();
  refitTerminal();
});

document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !menu.contains(event.target as Node)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) closeMenu();
});
window.addEventListener('blur', closeMenu);

// ---------- 挂载 ----------

let renderFrame = 0;
/** 合并同一帧内的多次刷新（标签栏状态点等会频繁变化） */
function scheduleRender(): void {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
}

function observeApp(): void {
  // 视图切换（登录页 / 服务器列表 / 终端）与标签增减时刷新可见性和会话指示
  const observer = new MutationObserver(scheduleRender);
  for (const id of ['auth-section', 'terminal-section']) {
    const node = document.getElementById(id);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) observer.observe(tabBar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

export function mountSidebar(): void {
  installFetchObserver();
  const start = () => {
    document.body.append(root, rail, menu);
    applyTexts();
    applyLayout();
    observeApp();
    subscribe(scheduleRender);
    onLocaleChange(() => {
      applyTexts();
      scheduleRender();
    });
    window.addEventListener('resize', () => updateVisibility());
    window.addEventListener('hashchange', scheduleRender);
    window.addEventListener('cloudssh:server-list', () => {
      // 网页版已登录并创建了服务器列表，但还没观察到列表数据时主动拉一次
      setTimeout(() => {
        if (getServers() === null) void reloadServers().catch(() => undefined);
      }, 3000);
    });
    window.cloudsshDesktop
      ?.info()
      .then((info) => {
        instanceLabel.textContent = info.instance.name;
        instanceLabel.title = info.instance.baseUrl;
        footer.hidden = false;
      })
      .catch(() => undefined);
    if (!canConnect()) {
      // 钩子在 ServerList 创建时才登记，这里只用于开发期排查
      console.debug('[cloudssh-sidebar] ServerList hook not registered yet');
    }
    render();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
