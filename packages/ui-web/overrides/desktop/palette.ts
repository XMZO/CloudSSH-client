/**
 * 命令面板：一个搜索框找服务器、已打开的会话、命令片段和常用操作，回车执行。
 *
 *   Ctrl+Shift+P      任何时候打开 / 关闭（终端里也可以，终端收不到这个组合键）
 *   Ctrl+K            不在终端里输入时打开（终端里 Ctrl+K 是 Shell 的删除到行尾，不拦截）
 *   系统全局快捷键    客户端主进程注册（默认 Ctrl+Alt+Space）：把窗口叫到前台并打开面板，用来快速连接
 *
 * 结果：服务器（回车新建会话）、会话（切到该标签）、命令片段（回车填入当前终端不执行，Ctrl+回车填入并执行，
 * 有 {{参数}} 时照网页版弹框录入）、操作（SFTP、AI、界面、实例……）。输入 > 开头只看操作。
 * 搜索不区分大小写，多个词用空格分开、需全部命中；名称连续命中排在前面，其次是首字母缩写式的跳字命中。
 */
import type { ServerConfig } from '@cloudssh/core';
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { getLocale, setLocale } from '../../upstream/frontend/src/i18n';
import { LANGUAGE_CHOICES } from '../shared/language-picker';
import { osIcon } from '../shared/os-icon';
import { openHighlightEditor } from '../shared/terminal';
import { ht } from '../shared/terminal/i18n';
import {
  activeTabId,
  closeTabById,
  connectServer,
  listTabs,
  openServerModal,
  sessionIsConnected,
  sessionsByServer,
  switchToTab,
} from '../sidebar/hooks';
import { getServers } from '../sidebar/store';
import { sortSnippets } from '../shared/snippet-order';
import { el, icon } from './dom';
import { dt } from './i18n';
import { clickById, currentView, desktopSkin, setDesktopSkin } from './state';
import './palette.css';

interface RunOptions {
  /** Ctrl / Cmd + 回车 */
  ctrl: boolean;
}

type Kind = 'session' | 'server' | 'snippet' | 'action';

interface Item {
  kind: Kind;
  title: string;
  detail?: string;
  /** 只参与搜索、不显示的文字（标签、分类、英文别名） */
  keywords?: string;
  icon?: string;
  os?: string | null;
  badge?: string;
  /** 徽标的状态色：ok / busy / off */
  badgeTone?: 'ok' | 'busy' | 'off';
  run: (options: RunOptions) => void;
}

interface Snippet {
  id: string;
  name: string;
  command: string;
  category?: string;
}

interface SnippetManagerLike {
  store?: { list?: () => Promise<Snippet[]> };
  deps?: { isAuthenticated?: () => boolean };
  insertSnippet?: (snippet: Snippet, run: boolean) => Promise<void>;
}

const MAX_ROWS = 80;
const KIND_ORDER: Kind[] = ['session', 'server', 'snippet', 'action'];

function snippetManager(): SnippetManagerLike | null {
  return ((globalThis as Record<string, unknown>).__cloudsshSnippetManager as SnippetManagerLike) ?? null;
}

function kindLabel(kind: Kind): string {
  if (kind === 'session') return dt('paletteSessions');
  if (kind === 'server') return dt('paletteServers');
  if (kind === 'snippet') return dt('paletteSnippets');
  return dt('paletteActions');
}

// ---------- 数据 ----------

/** 与服务器列表一致：IP 地址打码显示（完整地址仍可搜索） */
function serverAddress(server: ServerConfig): string {
  const raw = server.transport_type === 'cf_tunnel' && server.cf_tunnel_host ? server.cf_tunnel_host : server.host;
  const host = maskIPAddress(raw) ?? raw;
  const port = server.transport_type === 'cf_tunnel' || server.port === 22 ? '' : `:${server.port}`;
  return `${server.username}@${host}${port}`;
}

function sessionItems(): Item[] {
  const activeId = activeTabId();
  const inTerminal = currentView() === 'term';
  return listTabs().map((tab) => {
    const connected = sessionIsConnected(tab);
    const host = tab.hostInfo
      ? `${tab.hostInfo.username ? `${tab.hostInfo.username}@` : ''}${maskIPAddress(tab.hostInfo.host) ?? tab.hostInfo.host}`
      : '';
    const current = tab.id === activeId && inTerminal;
    return {
      kind: 'session',
      title: tab.label || host || tab.id,
      detail: host,
      icon: 'terminal',
      badge: current
        ? dt('paletteCurrent')
        : connected
          ? dt('paletteConnected')
          : tab.state === 'disconnected'
            ? dt('paletteDisconnected')
            : dt('paletteConnecting'),
      badgeTone: connected ? 'ok' : tab.state === 'disconnected' ? 'off' : 'busy',
      run: () => switchToTab(tab.id),
    };
  });
}

function serverItems(): Item[] {
  const servers = [...(getServers() ?? [])];
  // 最近连接过的排前面，其余按名称
  servers.sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0) || a.name.localeCompare(b.name));
  const sessions = sessionsByServer();
  return servers.map((server) => {
    const count = sessions.get(server.id)?.length ?? 0;
    return {
      kind: 'server',
      title: server.name,
      detail: serverAddress(server),
      keywords: [server.host, server.cf_tunnel_host ?? '', ...(server.tags ?? [])].join(' '),
      os: server.os,
      icon: 'dns',
      badge: count ? dt('sessions', { n: count }) : undefined,
      badgeTone: count ? 'ok' : undefined,
      run: () => void connectServer(server.id),
    };
  });
}

function snippetItems(snippets: Snippet[]): Item[] {
  const manager = snippetManager();
  if (!manager?.insertSnippet) return [];
  const insert = manager.insertSnippet.bind(manager);
  return snippets.map((snippet) => ({
    kind: 'snippet',
    title: snippet.name,
    detail: snippet.command.replace(/\s*\n\s*/g, ' ⏎ '),
    keywords: snippet.category ?? '',
    icon: 'bolt',
    run: ({ ctrl }) => void insert(snippet, ctrl),
  }));
}

/** 网页版收起的按钮还在页面上、没被隐藏时才算可用 */
function available(id: string): boolean {
  const node = document.getElementById(id);
  return !!node && !node.classList.contains('hidden') && !(node as HTMLButtonElement).disabled;
}

function loggedIn(): boolean {
  return !!document.getElementById('user-info')?.textContent?.trim();
}

async function actionItems(): Promise<Item[]> {
  const items: Item[] = [];
  const add = (title: string, iconName: string, run: () => void, keywords = '') =>
    items.push({ kind: 'action', title, icon: iconName, keywords, run });
  const view = currentView();

  if (view === 'term') {
    add(dt('actionBackHome'), 'dns', () => clickById('new-tab-btn'), 'home servers');
    for (const [id, iconName, key, keywords] of [
      ['sftp-toggle-btn', 'folder_open', 'sftp', 'sftp files upload download'],
      ['snippet-toggle-btn', 'bolt', 'snippets', 'snippets commands'],
      ['agent-toggle-btn', 'smart_toy', 'agent', 'ai agent assistant'],
      ['search-btn', 'search', 'search', 'find'],
      ['export-btn', 'download', 'export', 'export log'],
    ] as const) {
      if (available(id)) add(dt(key), iconName, () => clickById(id), keywords);
    }
    const tabId = activeTabId();
    if (tabId) add(dt('actionCloseTab'), 'close', () => closeTabById(tabId), 'close tab');
    if (available('disconnect-btn')) add(dt('disconnect'), 'power_settings_new', () => clickById('disconnect-btn'), 'disconnect');
  }
  if (getServers()) add(dt('addServer'), 'add', () => openServerModal('add'), 'add new server');

  const settingsButton = document.querySelector<HTMLElement>('.cs-tb-settings');
  if (settingsButton) add(dt('settings'), 'settings', () => settingsButton.click(), 'settings preferences');
  const other = desktopSkin() === 'workbench' ? 'classic' : 'workbench';
  add(
    dt('actionSkin', { name: dt(other === 'workbench' ? 'skinWorkbench' : 'skinClassic') }),
    'dashboard',
    () => setDesktopSkin(other),
    'skin layout theme'
  );
  const themes = document.querySelector<HTMLSelectElement>('#user-theme-selector, #theme-selector');
  if (themes) {
    for (const option of themes.options) {
      if (option.value === themes.value) continue;
      add(
        dt('actionColors', { name: option.textContent?.trim() || option.value }),
        'palette',
        () => {
          themes.value = option.value;
          themes.dispatchEvent(new Event('change', { bubbles: true }));
        },
        'theme colors'
      );
    }
  }
  for (const choice of LANGUAGE_CHOICES) {
    if (choice.locale !== getLocale()) add(dt('actionLanguage', { name: choice.name }), 'translate', () => setLocale(choice.locale), 'language');
  }
  const aiConfig = document.getElementById('ai-config-btn');
  if (aiConfig && loggedIn()) add(dt('aiSettings'), 'psychology', () => aiConfig.click(), 'ai model settings');
  add(ht('title'), 'format_color_text', () => openHighlightEditor(), 'highlight keywords');

  const bridge = window.cloudsshDesktop;
  if (bridge?.command) {
    const command = bridge.command.bind(bridge);
    const state = await bridge.menuState?.().catch(() => null);
    for (const instance of state?.instances ?? []) {
      if (instance.id === state?.currentId) continue;
      add(dt('actionSwitchInstance', { name: instance.name }), 'swap_horiz', () => void command('switch-instance', instance.id), `instance ${instance.host}`);
      add(dt('actionInstanceWindow', { name: instance.name }), 'open_in_new', () => void command('new-window', instance.id), `instance window ${instance.host}`);
    }
    add(dt('instanceManager'), 'tune', () => void command('manager'), 'instances');
    add(state?.fullscreen ? dt('menuExitFullscreen') : dt('menuFullscreen'), 'fullscreen', () => void command('fullscreen'), 'fullscreen');
    add(dt('menuZoomIn'), 'zoom_in', () => void command('zoom-in'), 'zoom');
    add(dt('menuZoomOut'), 'zoom_out', () => void command('zoom-out'), 'zoom');
    add(dt('menuZoomReset'), 'fit_screen', () => void command('zoom-reset'), 'zoom reset');
    add(dt('menuReload'), 'refresh', () => void command('reload'), 'reload');
    add(dt('menuConfigDir'), 'folder', () => void command('open-config'), 'config');
    add(dt('menuLogs'), 'description', () => void command('open-logs'), 'logs');
    add(dt('menuDevtools'), 'code', () => void command('devtools'), 'devtools');
  }
  for (const extra of extraActions) {
    const item = extra();
    if (item) items.push({ kind: 'action', ...item });
  }
  return items;
}

/** 其他模块登记的操作（例如凭据预设） */
const extraActions: (() => Omit<Item, 'kind'> | null)[] = [];

export function registerPaletteAction(factory: () => Omit<Item, 'kind'> | null): void {
  extraActions.push(factory);
}

// ---------- 匹配 ----------

interface Match {
  item: Item;
  score: number;
  /** 标题里命中的区间（高亮用） */
  ranges: [number, number][];
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return /[\s\-_./@:]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(text[index]));
}

/** 跳字命中（例如 hkp 命中 HK-Prod）：返回每个字符的位置 */
function subsequence(text: string, token: string): number[] | null {
  const positions: number[] = [];
  let from = 0;
  for (const char of token) {
    const index = text.indexOf(char, from);
    if (index < 0) return null;
    positions.push(index);
    from = index + 1;
  }
  return positions;
}

function match(item: Item, tokens: string[]): Match | null {
  if (!tokens.length) return { item, score: 0, ranges: [] };
  const title = item.title.toLowerCase();
  const rest = `${item.detail ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  let score = 0;
  const ranges: [number, number][] = [];
  for (const token of tokens) {
    const index = title.indexOf(token);
    if (index >= 0) {
      score += index === 0 ? 100 : isWordStart(item.title, index) ? 80 : 60;
      ranges.push([index, index + token.length]);
      continue;
    }
    if (rest.includes(token)) {
      score += 40;
      continue;
    }
    const positions = token.length > 1 ? subsequence(title, token) : null;
    if (!positions) return null;
    // 跳得越散分越低
    score += Math.max(5, 30 - (positions[positions.length - 1] - positions[0] - token.length));
    for (const position of positions) ranges.push([position, position + 1]);
  }
  return { item, score, ranges };
}

function highlighted(text: string, ranges: [number, number][]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!ranges.length) {
    fragment.append(text);
    return fragment;
  }
  const marks = new Array<boolean>(text.length).fill(false);
  for (const [start, end] of ranges) for (let i = start; i < end && i < text.length; i++) marks[i] = true;
  let index = 0;
  while (index < text.length) {
    const on = marks[index];
    let end = index;
    while (end < text.length && marks[end] === on) end++;
    const part = text.slice(index, end);
    fragment.append(on ? el('mark', 'cs-pal-mark', part) : part);
    index = end;
  }
  return fragment;
}

// ---------- 界面 ----------

interface PaletteState {
  root: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  items: Item[];
  snippets: Snippet[];
  results: Match[];
  selected: number;
  restoreFocus: HTMLElement | null;
}

let state: PaletteState | null = null;

export function isPaletteOpen(): boolean {
  return state !== null;
}

export function closePalette(restore = true): void {
  if (!state) return;
  const { root, restoreFocus } = state;
  state = null;
  root.remove();
  if (restore && restoreFocus?.isConnected) restoreFocus.focus();
}

function runSelected(options: RunOptions): void {
  if (!state) return;
  const result = state.results[state.selected];
  if (!result) return;
  // 先关面板、把焦点还给终端，再执行（新建会话、填入命令都要终端拿到焦点）
  closePalette();
  setTimeout(() => result.item.run(options), 0);
}

function render(): void {
  if (!state) return;
  const raw = state.input.value;
  const actionsOnly = raw.trimStart().startsWith('>');
  const query = (actionsOnly ? raw.trimStart().slice(1) : raw).trim().toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  let pool = state.items;
  if (actionsOnly) pool = pool.filter((item) => item.kind === 'action');
  else if (tokens.length) pool = [...pool, ...snippetItems(state.snippets)];

  let results = pool.map((item) => match(item, tokens)).filter((value): value is Match => value !== null);
  const grouped = !tokens.length;
  if (grouped) {
    results.sort((a, b) => KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind));
  } else {
    // 同分时按类别（会话、服务器、片段、操作）再按原顺序；Array.prototype.sort 是稳定排序
    results.sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind));
  }
  results = results.slice(0, MAX_ROWS);
  state.results = results;
  state.selected = Math.min(state.selected, Math.max(0, results.length - 1));

  const list = state.list;
  list.replaceChildren();
  if (!results.length) {
    list.append(el('div', 'cs-pal-empty', dt('paletteEmpty')));
    return;
  }
  let lastKind: Kind | null = null;
  results.forEach((result, index) => {
    const { item } = result;
    if (grouped && item.kind !== lastKind) {
      list.append(el('div', 'cs-pal-section', kindLabel(item.kind)));
      lastKind = item.kind;
    }
    const row = el('div', 'cs-pal-row');
    row.id = `cs-pal-row-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === state!.selected));
    const lead = el('span', 'cs-pal-lead');
    const svg = item.os ? osIcon(item.os) : null;
    if (svg) lead.append(svg);
    else lead.append(icon(item.icon ?? 'chevron_right'));
    const text = el('span', 'cs-pal-text');
    const title = el('span', 'cs-pal-title');
    title.append(highlighted(item.title, result.ranges));
    text.append(title);
    if (item.detail) text.append(el('span', 'cs-pal-detail', item.detail));
    row.append(lead, text);
    if (item.badge) {
      const badge = el('span', 'cs-pal-badge', item.badge);
      if (item.badgeTone) badge.dataset.tone = item.badgeTone;
      row.append(badge);
    }
    if (!grouped) row.append(el('span', 'cs-pal-kind', kindLabel(item.kind)));
    row.addEventListener('pointermove', () => select(index, false));
    row.addEventListener('click', (event) => {
      select(index, false);
      runSelected({ ctrl: event.ctrlKey || event.metaKey });
    });
    list.append(row);
  });
  syncSelection(true);
}

function syncSelection(scroll: boolean): void {
  if (!state) return;
  const { list, selected, input } = state;
  list.querySelectorAll<HTMLElement>('.cs-pal-row').forEach((row) => {
    const on = row.id === `cs-pal-row-${selected}`;
    row.setAttribute('aria-selected', String(on));
    row.classList.toggle('is-selected', on);
    if (on && scroll) row.scrollIntoView({ block: 'nearest' });
  });
  input.setAttribute('aria-activedescendant', `cs-pal-row-${selected}`);
  const result = state.results[selected];
  state.root.querySelector('.cs-pal-hint-ctrl')?.classList.toggle('hidden', result?.item.kind !== 'snippet');
}

function select(index: number, scroll = true): void {
  if (!state || !state.results.length) return;
  const count = state.results.length;
  const next = ((index % count) + count) % count;
  if (next === state.selected && !scroll) return;
  state.selected = next;
  syncSelection(scroll);
}

function hint(keys: string, label: string, className = ''): HTMLElement {
  const node = el('span', `cs-pal-hint ${className}`.trim());
  for (const key of keys.split(' ')) node.append(el('kbd', '', key));
  node.append(el('span', '', label));
  return node;
}

export async function openPalette(initial = ''): Promise<void> {
  if (state) {
    state.input.value = initial;
    state.input.focus();
    render();
    return;
  }
  const root = el('div', 'cs-pal-backdrop');
  const panel = el('div', 'cs-pal');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', dt('palette'));
  const head = el('div', 'cs-pal-head');
  head.append(icon('search'));
  const input = el('input', 'cs-pal-input');
  input.type = 'text';
  input.placeholder = dt('palettePlaceholder');
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'cs-pal-list');
  input.value = initial;
  head.append(input);
  const list = el('div', 'cs-pal-list');
  list.id = 'cs-pal-list';
  list.setAttribute('role', 'listbox');
  const foot = el('div', 'cs-pal-foot');
  foot.append(
    hint('↑ ↓', dt('paletteHintMove')),
    hint('Enter', dt('paletteHintRun')),
    hint('Ctrl Enter', dt('paletteHintRunSnippet'), 'cs-pal-hint-ctrl hidden'),
    hint('Esc', dt('paletteHintClose'))
  );
  panel.append(head, list, foot);
  root.append(panel);

  const active = document.activeElement;
  state = {
    root,
    input,
    list,
    items: [],
    snippets: [],
    results: [],
    selected: 0,
    restoreFocus: active instanceof HTMLElement && active !== document.body ? active : null,
  };
  const current = state;
  document.body.append(root);
  input.focus();

  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) {
      event.preventDefault();
      closePalette();
    }
  });
  input.addEventListener('input', () => {
    if (!state) return;
    state.selected = 0;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const page = Math.max(1, Math.floor(list.clientHeight / 44));
    if (event.key === 'ArrowDown') select((state?.selected ?? 0) + 1);
    else if (event.key === 'ArrowUp') select((state?.selected ?? 0) - 1);
    else if (event.key === 'PageDown') select(Math.min((state?.selected ?? 0) + page, (state?.results.length ?? 1) - 1));
    else if (event.key === 'PageUp') select(Math.max((state?.selected ?? 0) - page, 0));
    else if (event.key === 'Enter') runSelected({ ctrl: event.ctrlKey || event.metaKey });
    else if (event.key === 'Escape') closePalette();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  current.items = [...sessionItems(), ...serverItems()];
  render();
  const actions = await actionItems();
  if (state !== current) return;
  current.items = [...current.items, ...actions];
  render();
  // 命令片段只在终端里有意义（填入当前终端）；登录用户的片段要请求接口，晚一点到也没关系
  const manager = snippetManager();
  if (currentView() === 'term' && manager?.store?.list) {
    try {
      const snippets = await manager.store.list();
      if (state !== current) return;
      // 与命令片段面板一致：按手动调整过的顺序
      current.snippets = sortSnippets(snippets, manager.deps?.isAuthenticated?.() === true);
      if (input.value.trim()) render();
    } catch {
      // 拉取失败时只是搜不到片段
    }
  }
}

export function togglePalette(): void {
  if (state) closePalette();
  else void openPalette();
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.xterm');
}

function inEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function installPalette(): void {
  document.addEventListener(
    'keydown',
    (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const shiftP = event.shiftKey && (key === 'p' || event.code === 'KeyP');
      const plainK = !event.shiftKey && (key === 'k' || event.code === 'KeyK') && !inTerminal(event.target) && !inEditable(event.target);
      if (!shiftP && !plainK) return;
      // 网页版自己的对话框开着时不打断
      if (!state && document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopPropagation();
      togglePalette();
    },
    true
  );
  // 系统全局快捷键：主进程已把窗口叫到前台
  window.cloudsshDesktop?.onPalette?.((toggle) => {
    if (toggle && state) closePalette();
    else void openPalette();
  });
}
