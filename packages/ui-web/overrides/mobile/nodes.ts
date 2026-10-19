/**
 * 移动端节点首页：替代网页版每页 3 张卡片的分页网格。
 * - 按标签分组、可折叠，“最近连接”置顶，搜索
 * - 点按：已有会话就切过去，没有就新建连接；长按：操作面板（新建连接/切换会话/编辑/克隆/复制名称/复制 ID/复制地址）
 * - 有会话时顶部显示“N 个会话进行中”，一键回到终端
 * - 分组与组内服务器的顺序在“调整排序”面板里拖动（reorder-sheet.ts），这里只按保存的顺序显示
 * 数据与动作复用桌面侧栏：旁听 /api/servers（store.ts），调用网页版自身逻辑（hooks.ts）。
 */
import { groupServersByTag, serverInitial, type ServerConfig } from '@cloudssh/core';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import {
  activeServerId,
  canShare,
  connectServer,
  deleteServer,
  focusSession,
  openServerModal,
  sessionsByServer,
  shareServer,
  tabCount,
} from '../sidebar/hooks';
import { getServers, subscribe } from '../sidebar/store';
import { hostId } from '../shared/ai-remote/servers';
import { mt, onLocaleChange } from './i18n';
import { osIcon } from '../shared/os-icon';
import { copyTagName, renameTag, TAG_RENAMED_EVENT, type TagRenamed } from '../shared/server-tags';
import { nodeOrder, ORDER_CHANGED_EVENT, orderedGroups, RECENT_KEY, UNGROUPED_KEY } from './node-groups';
import { openReorderSheet } from './reorder-sheet';
import { el, icon, showActions, type SheetAction } from './sheet';
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

/** 整体换成另一组折叠的分组（扫码同步时用电脑侧栏的折叠状态） */
export function replaceCollapsedGroups(keys: string[]): void {
  state.collapsed = new Set(keys.filter((key) => typeof key === 'string'));
  saveCollapsed();
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

/** 排序、语言变化时加一，计入内容签名 */
let orderVersion = 0;
let localeVersion = 0;
let lastSignature = '';

/**
 * 决定列表长什么样的全部数据。签名没变就不动 DOM：回到节点页时会连着来好几次刷新（标签栏变化、页面切换、
 * 网页版重新拉取列表），每次都重建会让列表闪几下、打断正在按下的行。以前是先建一遍 DOM 再比较 innerHTML，
 * 几十台服务器时每次都要几十毫秒；比较数据只要不到 1 毫秒。
 */
function contentSignature(servers: ServerConfig[], sessions: Map<number, string[]>, activeId: number | null, tabs: number): string {
  return JSON.stringify([
    servers,
    [...sessions].map(([id, list]) => [id, list.length]),
    activeId,
    tabs,
    state.query,
    [...state.collapsed],
    orderVersion,
    localeVersion,
  ]);
}

function render(): void {
  const servers = getServers();
  document.documentElement.classList.toggle('cs-nodes-on', servers !== null);
  if (!servers) {
    lastSignature = '';
    return;
  }
  const sessions = sessionsByServer();
  const activeId = activeServerId();
  const tabs = tabCount();
  const signature = contentSignature(servers, sessions, activeId, tabs);
  if (signature === lastSignature) return;
  lastSignature = signature;
  banner.hidden = tabs === 0;
  banner.replaceChildren(
    icon('terminal'),
    el('span', '', mt(tabs === 1 ? 'sessionsBannerOne' : 'sessionsBanner', { n: tabs })),
    el('span', 'cs-m-banner-go', mt('backToTerminal')),
    icon('arrow_forward')
  );

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
  list.replaceChildren(fragment);
}

/** 节点页是否在显示：在终端页时不渲染（看不见，还会和终端抢主线程），回来时再补 */
function pageVisible(): boolean {
  const section = document.getElementById('user-space-section');
  return !!section && !section.classList.contains('hidden');
}

let frame = 0;
let dirty = true;

function flush(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (!dirty) return;
  dirty = false;
  render();
}

function scheduleRender(): void {
  dirty = true;
  if (frame || !pageVisible()) return;
  frame = requestAnimationFrame(flush);
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
  const actions: SheetAction[] = [{ label: mt('connectNew'), icon: 'add_circle', action: () => void connectServer(server.id) }];
  if (open > 0) actions.push({ label: `${mt('switchSession')} (${open})`, icon: 'swap_horiz', action: () => void focusSession(server.id) });
  actions.push(
    { label: mt('edit'), icon: 'edit', action: () => void openServerModal('edit', server.id) },
    { label: mt('clone'), icon: 'content_copy', action: () => void openServerModal('clone', server.id) },
    {
      label: mt('copyName'),
      icon: 'label',
      action: () => void copyTextToClipboard(server.name).then((ok) => ok && notify(mt('copied'), { variant: 'success', duration: 1500 })),
    },
    {
      // 主机 ID（srv-12）：给命令行、skill、AI 用的，各设备一样、改名不变
      label: mt('copyId', { id: hostId(server) }),
      icon: 'tag',
      action: () => void copyTextToClipboard(hostId(server)).then((ok) => ok && notify(mt('copied'), { variant: 'success', duration: 1500 })),
    },
    {
      label: mt('copyHost'),
      icon: 'link',
      action: () => {
        const host = server.transport_type === 'cf_tunnel' && server.cf_tunnel_host ? server.cf_tunnel_host : server.host;
        void copyTextToClipboard(host).then((ok) => ok && notify(mt('copied'), { variant: 'success', duration: 1500 }));
      },
    }
  );
  // 一次性分享：只在 Worker 开启分享时提供（与网页版的卡片一致）
  if (canShare()) actions.push({ label: mt('share'), icon: 'share', action: () => void shareServer(server.id) });
  actions.push({
    label: mt('reorder'),
    icon: 'swap_vert',
    action: () => void openReorderSheet(groupKey && groupKey !== RECENT_KEY ? groupKey : undefined),
  });
  // 删除走网页版自己的流程：确认框、被用作跳板时的报错都与网页版一致
  actions.push({ label: mt('delete'), icon: 'delete', danger: true, action: () => void deleteServer(server.id) });
  showActions(server.name, actions, mt('cancel'));
}

function showGroupActions(tag: string): void {
  showActions(
    tag,
    [
      { label: mt('renameTag'), icon: 'edit', action: () => void renameTag(tag) },
      { label: mt('copyTagName'), icon: 'content_copy', action: () => void copyTagName(tag) },
    ],
    mt('cancel')
  );
}

let longPressFired = false;
list.addEventListener('contextmenu', (event) => {
  const server = serverOf(event.target);
  if (!server) {
    // 长按分组标题（标签）：重命名、复制名称（“最近连接”“未分组”不是标签）
    const tag = (event.target as HTMLElement).closest<HTMLElement>('.cs-m-group-header')?.dataset.group;
    if (!tag || tag === RECENT_KEY || tag === UNGROUPED_KEY) return;
    event.preventDefault();
    longPressFired = true;
    showGroupActions(tag);
    return;
  }
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
  // 标签改名后，按标签名记住的折叠状态与手动排序跟过去
  window.addEventListener(TAG_RENAMED_EVENT, (event) => {
    const { from, to } = (event as CustomEvent<TagRenamed>).detail;
    if (state.collapsed.delete(from)) {
      state.collapsed.add(to);
      saveCollapsed();
    }
    nodeOrder().renameGroup(from, to);
    orderVersion++;
    scheduleRender();
  });
  window.addEventListener(ORDER_CHANGED_EVENT, () => {
    orderVersion++;
    scheduleRender();
  });
  subscribe(scheduleRender);
  onLocaleChange(() => {
    localeVersion++;
    applyTexts();
    scheduleRender();
  });
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) new MutationObserver(scheduleRender).observe(tabBar, { childList: true, subtree: true });
  // 页面切换：回到节点页时在这一帧画出来之前就补上渲染，不和进场动画抢同一帧
  const sections = new MutationObserver(() => {
    if (pageVisible()) flush();
  });
  for (const id of ['terminal-section', 'user-space-section']) {
    const node = document.getElementById(id);
    if (node) sections.observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  render();
  dirty = false;
}
