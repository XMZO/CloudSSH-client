/**
 * 工作台主题的服务器列表：替换网页版每页 6 张的卡片，改成桌面常用的表格。
 *
 * - 一屏看全部服务器，不分页；表头吸顶，点表头排序（名称 / 最近连接 / 添加时间，再点一次反向）
 * - 搜索（名称、主机、用户、标签）、标签筛选、按标签分组
 * - 单击选中，双击或回车连接；↑↓ 移动选中，Delete 删除；鼠标移到行上显示操作按钮，右键弹出完整菜单
 * - 连接、编辑、克隆、分享、删除都走网页版自己的流程（sidebar/hooks.ts），与网页版完全一致
 * - 窗口变窄时按优先级隐藏次要列（容器查询，见 home.css），不会挤压换行
 */
import { matchesServerQuery, serverInitial, serverTags, type ServerConfig } from '@cloudssh/core';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { t } from '../../upstream/frontend/src/i18n';
import { regionLabel } from '../../upstream/frontend/src/regions';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import {
  canShare,
  connectServer,
  deleteServer,
  focusSession,
  openServerModal,
  sessionsByServer,
  shareServer,
} from '../sidebar/hooks';
import { copyTagName, renameTag, TAG_RENAMED_EVENT, type TagRenamed } from '../shared/server-tags';
import { osIcon } from '../shared/os-icon';
import { getServers, subscribe } from '../sidebar/store';
import { el, icon, iconButton } from './dom';
import { dt, onLocaleChange } from './i18n';
import { showMenu, type MenuItem } from './menu';
import { clickById, currentView, VIEW_CHANGED_EVENT } from './state';
import './home.css';

type SortKey = 'name' | 'recent' | 'created';
interface ViewState {
  sort: SortKey;
  desc: boolean;
  group: boolean;
  tag: string;
}

const STATE_KEY = 'cloudssh_desktop_home';
const UNTAGGED = '\u0000untagged';

function loadState(): ViewState {
  const fallback: ViewState = { sort: 'recent', desc: true, group: false, tag: '' };
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as Partial<ViewState> | null;
    if (!raw) return fallback;
    return {
      sort: raw.sort === 'name' || raw.sort === 'created' ? raw.sort : 'recent',
      desc: raw.desc !== false,
      group: raw.group === true,
      tag: typeof raw.tag === 'string' ? raw.tag : '',
    };
  } catch {
    return fallback;
  }
}

const state = loadState();
let query = '';
let selectedId: number | null = null;

function saveState(): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 忽略
  }
}

// ---------- 显示用的小工具 ----------

function isTunnel(server: ServerConfig): boolean {
  return server.transport_type === 'cf_tunnel' && !!server.cf_tunnel_host;
}

/** 复制用的完整地址 */
function hostOf(server: ServerConfig): string {
  return isTunnel(server) ? server.cf_tunnel_host! : server.host;
}

/** 显示用：IP 打码，带端口（隧道只显示域名） */
function hostLabel(server: ServerConfig): string {
  if (isTunnel(server)) return server.cf_tunnel_host!;
  return `${maskIPAddress(server.host) ?? server.host}:${server.port}`;
}

function regionText(server: ServerConfig): { text: string; manual: boolean } {
  if (server.jump_server_id) return { text: t('server.regionViaJump'), manual: false };
  const hint = server.region || server.inferred_hint || '';
  return { text: regionLabel(hint), manual: !!server.region };
}

function timeOf(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function fullTime(time: number): string {
  return new Date(time).toLocaleString();
}

function relativeTime(time: number): string {
  if (!time) return dt('never');
  const diff = Date.now() - time;
  if (diff < 60_000) return dt('justNow');
  if (diff < 3_600_000) return dt('minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return dt('hoursAgo', { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return dt('daysAgo', { n: Math.floor(diff / 86_400_000) });
  return new Date(time).toLocaleDateString();
}

function sortServers(list: ServerConfig[]): ServerConfig[] {
  const dir = state.desc ? -1 : 1;
  const byName = (a: ServerConfig, b: ServerConfig) => a.name.localeCompare(b.name);
  return [...list].sort((a, b) => {
    let diff = 0;
    if (state.sort === 'recent') diff = timeOf(a.last_connected_at) - timeOf(b.last_connected_at);
    else if (state.sort === 'created') diff = timeOf(a.created_at) - timeOf(b.created_at);
    else diff = byName(a, b);
    return diff !== 0 ? diff * dir : byName(a, b);
  });
}

// ---------- 操作 ----------

function copyHost(server: ServerConfig): void {
  void copyTextToClipboard(hostOf(server)).then((ok) => {
    if (ok) notify(dt('copied'), { variant: 'success', duration: 1500 });
  });
}

function menuItems(server: ServerConfig): MenuItem[] {
  const open = sessionsByServer().get(server.id)?.length ?? 0;
  const items: MenuItem[] = [{ label: dt('connect'), icon: 'play_arrow', action: () => void connectServer(server.id) }];
  if (open > 0) items.push({ label: `${dt('openSession')} (${open})`, icon: 'tab', action: () => void focusSession(server.id) });
  items.push(
    { label: dt('edit'), icon: 'edit', separated: true, action: () => void openServerModal('edit', server.id) },
    { label: dt('clone'), icon: 'content_copy', action: () => void openServerModal('clone', server.id) },
    { label: dt('copyHost'), icon: 'link', action: () => copyHost(server) }
  );
  if (canShare()) items.push({ label: dt('share'), icon: 'share', action: () => void shareServer(server.id) });
  items.push({ label: dt('delete'), icon: 'delete', danger: true, separated: true, action: () => void deleteServer(server.id) });
  return items;
}

// ---------- 结构 ----------

const root = el('section', 'cs-home');
const head = el('div', 'cs-home-head');
const titleBox = el('div', 'cs-home-title');
const title = el('h1', '', '');
const count = el('span', 'cs-home-count');
titleBox.append(title, count);

const searchBox = el('label', 'cs-home-search');
const searchInput = el('input');
searchInput.type = 'search';
searchInput.autocomplete = 'off';
searchInput.spellcheck = false;
searchBox.append(icon('search'), searchInput);

const tagSelect = el('select', 'cs-home-select');
const groupToggle = iconButton('account_tree', '', 'cs-home-iconbtn');
const addButton = el('button', 'cs-home-primary');
addButton.type = 'button';
addButton.append(icon('add'), el('span', 'cs-home-primary-label'));
addButton.addEventListener('click', () => clickById('add-server-btn') || openServerModal('add'));
head.append(titleBox, searchBox, tagSelect, groupToggle, addButton);

const scroller = el('div', 'cs-home-scroll');
const table = el('table', 'cs-home-table');
table.setAttribute('role', 'grid');
const thead = el('thead');
const tbody = el('tbody');
table.append(thead, tbody);
const emptyBox = el('div', 'cs-home-empty');
scroller.append(table, emptyBox);

const foot = el('div', 'cs-home-foot');
root.append(head, scroller, foot);

const COLUMNS: { key: string; label: () => string; sort?: SortKey; className: string }[] = [
  { key: 'name', label: () => dt('colName'), sort: 'name', className: 'col-name' },
  { key: 'host', label: () => dt('colHost'), className: 'col-host' },
  { key: 'user', label: () => dt('colUser'), className: 'col-user' },
  { key: 'region', label: () => dt('colRegion'), className: 'col-region' },
  { key: 'recent', label: () => dt('colLastConnected'), sort: 'recent', className: 'col-recent' },
  { key: 'created', label: () => dt('colCreated'), sort: 'created', className: 'col-created' },
  { key: 'actions', label: () => '', className: 'col-actions' },
];

function renderHead(): void {
  const row = el('tr');
  for (const column of COLUMNS) {
    const th = el('th', column.className);
    th.scope = 'col';
    if (column.sort) {
      const button = el('button', 'cs-home-sort', column.label());
      button.type = 'button';
      button.title = dt('sortBy', { col: column.label() });
      const active = state.sort === column.sort;
      th.setAttribute('aria-sort', active ? (state.desc ? 'descending' : 'ascending') : 'none');
      if (active) button.append(icon(state.desc ? 'arrow_downward' : 'arrow_upward', 'cs-home-sort-dir'));
      button.addEventListener('click', () => {
        if (state.sort === column.sort) state.desc = !state.desc;
        else {
          state.sort = column.sort!;
          // 名称默认正序，时间默认新的在前
          state.desc = column.sort !== 'name';
        }
        saveState();
        render();
      });
      th.append(button);
    } else {
      th.textContent = column.label();
    }
    row.append(th);
  }
  thead.replaceChildren(row);
}

function renderRow(server: ServerConfig, sessions: number): HTMLTableRowElement {
  const row = el('tr', 'cs-row');
  row.dataset.id = String(server.id);
  row.tabIndex = -1;
  row.setAttribute('aria-selected', String(server.id === selectedId));
  if (server.id === selectedId) row.classList.add('is-selected');

  // 名称：系统图标或首字母、名称、会话数、标签
  const name = el('td', 'col-name');
  const nameBox = el('div', 'cs-name');
  const avatar = el('span', 'cs-avatar');
  const svg = server.os ? osIcon(server.os) : null;
  if (svg) avatar.append(svg);
  else avatar.textContent = serverInitial(server.name);
  const text = el('div', 'cs-name-text');
  const line = el('div', 'cs-name-line');
  line.append(el('span', 'cs-name-label', server.name));
  if (sessions > 0) {
    const badge = el('span', 'cs-live', String(sessions));
    badge.title = dt('sessions', { n: sessions });
    line.append(badge);
  }
  text.append(line);
  const tags = serverTags(server);
  if (tags.length || isTunnel(server)) {
    const chips = el('div', 'cs-chips');
    if (isTunnel(server)) chips.append(el('span', 'cs-chip is-tunnel', t('server.tunnelBadge')));
    for (const tag of tags) chips.append(el('span', 'cs-chip', tag));
    text.append(chips);
  }
  nameBox.append(avatar, text);
  name.append(nameBox);
  name.title = server.name;

  const host = el('td', 'col-host');
  const hostButton = el('button', 'cs-host', hostLabel(server));
  hostButton.type = 'button';
  hostButton.title = dt('copyHost');
  hostButton.addEventListener('click', (event) => {
    event.stopPropagation();
    copyHost(server);
  });
  host.append(hostButton);

  const user = el('td', 'col-user');
  user.append(el('span', '', server.username), el('span', 'cs-auth', server.auth_method === 'publickey' ? 'KEY' : 'PWD'));

  const region = el('td', 'col-region');
  const regionInfo = regionText(server);
  region.textContent = regionInfo.text;
  region.classList.toggle('is-auto', !regionInfo.manual);

  const lastTime = timeOf(server.last_connected_at);
  const recent = el('td', 'col-recent', relativeTime(lastTime));
  if (lastTime) recent.title = fullTime(lastTime);
  else recent.classList.add('is-muted');

  const createdTime = timeOf(server.created_at);
  const created = el('td', 'col-created', createdTime ? new Date(createdTime).toLocaleDateString() : '');
  if (createdTime) created.title = fullTime(createdTime);

  const actions = el('td', 'col-actions');
  const box = el('div', 'cs-row-actions');
  const connect = iconButton('play_arrow', dt('connect'), 'cs-act is-primary');
  connect.addEventListener('click', () => void connectServer(server.id));
  const edit = iconButton('edit', dt('edit'), 'cs-act');
  edit.addEventListener('click', () => void openServerModal('edit', server.id));
  const clone = iconButton('content_copy', dt('clone'), 'cs-act');
  clone.addEventListener('click', () => void openServerModal('clone', server.id));
  box.append(connect, edit, clone);
  if (canShare()) {
    const share = iconButton('share', dt('share'), 'cs-act');
    share.addEventListener('click', () => void shareServer(server.id));
    box.append(share);
  }
  const more = iconButton('more_horiz', dt('more'), 'cs-act');
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    const rect = more.getBoundingClientRect();
    select(server.id);
    showMenu(rect.left, rect.bottom + 4, menuItems(server));
  });
  box.append(more);
  actions.append(box);

  row.append(name, host, user, region, recent, created, actions);
  return row;
}

function groupRow(label: string, size: number, tag: string | null): HTMLTableRowElement {
  const row = el('tr', 'cs-group');
  if (tag) row.dataset.tag = tag;
  const cell = el('td');
  cell.colSpan = COLUMNS.length;
  cell.append(el('span', 'cs-group-label', label), el('span', 'cs-group-count', String(size)));
  row.append(cell);
  return row;
}

function syncTagOptions(servers: ServerConfig[]): void {
  const tags = [...new Set(servers.flatMap((server) => serverTags(server)))].sort((a, b) => a.localeCompare(b));
  const hasUntagged = servers.some((server) => serverTags(server).length === 0);
  if (state.tag && state.tag !== UNTAGGED && !tags.includes(state.tag)) state.tag = '';
  const options: [string, string][] = [['', dt('allTags')], ...tags.map((tag): [string, string] => [tag, tag])];
  if (hasUntagged) options.push([UNTAGGED, dt('untagged')]);
  tagSelect.replaceChildren(
    ...options.map(([value, label]) => {
      const option = el('option', '', label);
      option.value = value;
      return option;
    })
  );
  tagSelect.value = state.tag;
}

function visibleServers(servers: ServerConfig[]): ServerConfig[] {
  return servers.filter((server) => {
    if (state.tag === UNTAGGED && serverTags(server).length) return false;
    if (state.tag && state.tag !== UNTAGGED && !serverTags(server).includes(state.tag)) return false;
    return matchesServerQuery(server, query);
  });
}

let rows: ServerConfig[] = [];

function render(): void {
  const servers = getServers() ?? [];
  renderHead();
  syncTagOptions(servers);
  count.textContent = dt('serversCount', { n: servers.length });
  groupToggle.classList.toggle('is-on', state.group);
  groupToggle.setAttribute('aria-pressed', String(state.group));

  const list = sortServers(visibleServers(servers));
  const sessions = sessionsByServer();
  const fragment = document.createDocumentFragment();
  rows = [];
  if (state.group) {
    const groups = new Map<string, ServerConfig[]>();
    for (const server of list) {
      const tags = serverTags(server);
      for (const key of tags.length ? tags : [UNTAGGED]) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(server);
      }
    }
    const keys = [...groups.keys()].sort((a, b) => (a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : a.localeCompare(b)));
    for (const key of keys) {
      const members = groups.get(key)!;
      fragment.append(groupRow(key === UNTAGGED ? dt('untagged') : key, members.length, key === UNTAGGED ? null : key));
      for (const server of members) {
        fragment.append(renderRow(server, sessions.get(server.id)?.length ?? 0));
        rows.push(server);
      }
    }
  } else {
    for (const server of list) {
      fragment.append(renderRow(server, sessions.get(server.id)?.length ?? 0));
      rows.push(server);
    }
  }
  tbody.replaceChildren(fragment);

  const empty = servers.length === 0;
  emptyBox.hidden = list.length > 0;
  emptyBox.replaceChildren(icon(empty ? 'dns' : 'search_off'), el('strong', '', empty ? dt('empty') : dt('noMatch')));
  if (empty) emptyBox.append(el('span', '', dt('emptyHint')));
  table.hidden = list.length === 0;
  foot.textContent = dt('shortcutHint');
}

// ---------- 选中与键盘 ----------

function rowElement(id: number): HTMLTableRowElement | null {
  return tbody.querySelector<HTMLTableRowElement>(`tr.cs-row[data-id="${id}"]`);
}

function select(id: number | null, focus = false): void {
  if (selectedId !== null) {
    const previous = rowElement(selectedId);
    previous?.classList.remove('is-selected');
    previous?.setAttribute('aria-selected', 'false');
  }
  selectedId = id;
  if (id === null) return;
  const row = rowElement(id);
  if (!row) return;
  row.classList.add('is-selected');
  row.setAttribute('aria-selected', 'true');
  if (focus) {
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  }
}

function serverOf(target: EventTarget | null): ServerConfig | null {
  const row = (target as Element | null)?.closest?.<HTMLTableRowElement>('tr.cs-row');
  const id = row ? Number(row.dataset.id) : NaN;
  return (getServers() ?? []).find((server) => server.id === id) ?? null;
}

tbody.addEventListener('click', (event) => {
  const server = serverOf(event.target);
  if (!server || (event.target as Element).closest('button')) return;
  select(server.id, true);
});
tbody.addEventListener('dblclick', (event) => {
  const server = serverOf(event.target);
  if (!server || (event.target as Element).closest('button')) return;
  void connectServer(server.id);
});
tbody.addEventListener('contextmenu', (event) => {
  const server = serverOf(event.target);
  if (!server) {
    // 按标签分组时的分组行：重命名、复制标签名
    const tag = (event.target as Element).closest<HTMLElement>('tr.cs-group')?.dataset.tag;
    if (!tag) return;
    event.preventDefault();
    showMenu(event.clientX, event.clientY, [
      { label: dt('renameTag'), icon: 'edit', action: () => void renameTag(tag) },
      { label: dt('copyTagName'), icon: 'content_copy', action: () => void copyTagName(tag) },
    ]);
    return;
  }
  event.preventDefault();
  select(server.id, true);
  showMenu(event.clientX, event.clientY, menuItems(server));
});
scroller.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const index = rows.findIndex((server) => server.id === selectedId);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!rows.length) return;
    const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
    select(rows[next].id, true);
  } else if (event.key === 'Enter' && index >= 0) {
    void connectServer(rows[index].id);
  } else if (event.key === 'Delete' && index >= 0) {
    void deleteServer(rows[index].id);
  } else if (event.key === 'ContextMenu' && index >= 0) {
    const rect = rowElement(rows[index].id)?.getBoundingClientRect();
    if (rect) showMenu(rect.left + 24, rect.bottom, menuItems(rows[index]));
  } else {
    return;
  }
  event.preventDefault();
});

// 搜索框里按 ↓ / 回车进入列表
searchInput.addEventListener('keydown', (event) => {
  if ((event.key === 'ArrowDown' || event.key === 'Enter') && rows.length) {
    event.preventDefault();
    select(selectedId !== null && rows.some((server) => server.id === selectedId) ? selectedId : rows[0].id, true);
    if (event.key === 'Enter' && query) void connectServer(rows[0].id);
  } else if (event.key === 'Escape' && searchInput.value) {
    event.preventDefault();
    searchInput.value = '';
    query = '';
    render();
  }
});

let searchTimer = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    query = searchInput.value.trim();
    render();
  }, 100);
});
tagSelect.addEventListener('change', () => {
  state.tag = tagSelect.value;
  saveState();
  render();
});
groupToggle.addEventListener('click', () => {
  state.group = !state.group;
  saveState();
  render();
});

// 列表页上 Ctrl+F 或 / 聚焦搜索（终端页的 Ctrl+F 仍归终端）
document.addEventListener('keydown', (event) => {
  if (currentView() !== 'home' || !root.isConnected) return;
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') || (event.key === '/' && !typing)) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

function applyTexts(): void {
  title.textContent = dt('serversTitle');
  searchInput.placeholder = dt('searchPlaceholder');
  searchInput.setAttribute('aria-label', dt('searchPlaceholder'));
  tagSelect.setAttribute('aria-label', dt('allTags'));
  groupToggle.title = dt('groupByTag');
  groupToggle.setAttribute('aria-label', dt('groupByTag'));
  addButton.querySelector('.cs-home-primary-label')!.textContent = dt('addServer');
}

let frame = 0;
// 标签改名后，正在按它筛选时跟着改
window.addEventListener(TAG_RENAMED_EVENT, (event) => {
  const { from, to } = (event as CustomEvent<TagRenamed>).detail;
  if (state.tag !== from) return;
  state.tag = to;
  saveState();
  scheduleRender();
});

function scheduleRender(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(render);
}

export function mountHome(): void {
  const main = document.querySelector('#user-space-section > .user-space-main');
  if (!main) return;
  main.prepend(root);
  scroller.tabIndex = -1;
  applyTexts();
  render();
  subscribe(scheduleRender);
  onLocaleChange(() => {
    applyTexts();
    scheduleRender();
  });
  // 会话开关、回到列表页时刷新会话数与相对时间
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) new MutationObserver(scheduleRender).observe(tabBar, { childList: true });
  window.addEventListener(VIEW_CHANGED_EVENT, () => {
    if (currentView() === 'home') scheduleRender();
  });
}
