/**
 * 偏好设置“保持面板”：SFTP、自定义命令、AI 助手三个面板各一个开关（默认关）。开关打开的那个面板，在切换会话标签、
 * 连接新服务器、从服务器列表回到终端时保持打开（换成那个会话自己的面板），不会先收起再打开：
 * - 记住的是你自己打开 / 关上的面板；网页版因为切换标签、新建连接、离开终端页自动收起的不算
 * - 切到已连上的会话：同一瞬间换成新会话的面板，不播放滑入滑出动画，停靠宽度不变，终端不重算行列
 * - 新连接（SFTP、AI 助手的面板要连上后才有）：面板位置先放一块同宽的占位“连接后自动打开…”，停靠宽度照留，
 *   新终端一开始就是让出位置后的宽度；连上后换成真正的面板。30 秒还没连上就收起占位
 * - 自定义命令面板所有会话共用一个：直接保持打开
 * 两种界面主题都生效（经典主题的面板盖在终端上，没有停靠宽度）。
 *
 * 构建钩子（vite.config.ts）在网页版收起全部面板（closeAllDrawers）和切换标签之前调用 __cloudsshDrawerProgrammatic，
 * 这里据此区分“网页版自动收起”和“你自己关上”；切换标签后网页版派发 cloudssh:active-terminal-change，这里再打开。
 */
import { el, icon } from './dom';
import { dt } from './i18n';
import { currentView, VIEW_CHANGED_EVENT } from './state';
import { setDockHold } from './titlebar';
import './drawer-follow.css';

export type Drawer = 'sftp' | 'snippet' | 'agent';
export const DRAWERS: readonly Drawer[] = ['sftp', 'snippet', 'agent'];

const STORAGE_PREFIX = 'cloudssh_keep_drawer_';
/** 等新连接连上的最长时间 */
const WAIT_LIMIT_MS = 30_000;
const POLL_MS = 200;
const ICONS: Record<Drawer, string> = { sftp: 'folder_open', snippet: 'bolt', agent: 'smart_toy' };
const PANEL_IDS: Record<Drawer, string> = { sftp: 'sftp-panel', snippet: 'snippet-panel', agent: 'agent-panel' };

export function keepDrawer(drawer: Drawer): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + drawer) === '1';
  } catch {
    return false;
  }
}

export function setKeepDrawer(drawer: Drawer, on: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + drawer, on ? '1' : '0');
  } catch {
    // 记不住
  }
}

export function drawerLabel(drawer: Drawer): string {
  return drawer === 'sftp' ? dt('sftp') : drawer === 'snippet' ? dt('snippets') : dt('agent');
}

interface TabLike {
  state?: string;
  sftpPanel?: unknown;
  agentPanel?: unknown;
}

const button = (drawer: Drawer) => document.getElementById(`${drawer}-toggle-btn`);
const openDrawer = (): Drawer | null => DRAWERS.find((drawer) => button(drawer)?.classList.contains('active')) ?? null;
const activeTab = () =>
  (globalThis as { __cloudsshTabManager?: { getActiveTab?: () => TabLike | null } }).__cloudsshTabManager?.getActiveTab?.() ?? null;

/** 你最后一次自己打开的面板（自己关上时为 null） */
let desired: Drawer | null = null;
/** 网页版自动收起 / 这里代为打开的过程中：面板开合不算你的操作 */
let programmatic = 0;
/** 每个面板最近一次打开时的宽度（占位用） */
const widths = new Map<Drawer, number>();
let pending: { timer: number; poll: number; placeholder: HTMLElement } | null = null;

function markProgrammatic(): void {
  programmatic++;
  // 同一个任务里的开合与随后的 MutationObserver 回调（微任务）都算
  window.setTimeout(() => programmatic--, 0);
}

/** 这一刻的面板开合不播放滑入滑出动画（下一帧之后恢复） */
function instant(): void {
  const html = document.documentElement;
  html.classList.add('cs-drawer-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('cs-drawer-instant')));
}

function measure(drawer: Drawer): void {
  let width = 0;
  for (const node of document.querySelectorAll<HTMLElement>(`[id="${PANEL_IDS[drawer]}"]`)) width = Math.max(width, node.offsetWidth);
  if (width > 0) widths.set(drawer, width);
}

/** 当前会话的这个面板能不能打开（SFTP、AI 助手要连上之后才有面板；AI 助手只给登录用户） */
function ready(drawer: Drawer): boolean | 'never' {
  if (drawer === 'snippet') return !button(drawer)?.classList.contains('hidden');
  const tab = activeTab();
  if (!tab || tab.state !== 'connected') return false;
  const panel = drawer === 'sftp' ? tab.sftpPanel : tab.agentPanel;
  if (panel) return true;
  return drawer === 'agent' || button(drawer)?.classList.contains('hidden') ? 'never' : false;
}

function open(drawer: Drawer): void {
  if (openDrawer() === drawer) return;
  markProgrammatic();
  instant();
  button(drawer)?.click();
}

function cancelPending(): void {
  if (!pending) return;
  window.clearTimeout(pending.timer);
  window.clearInterval(pending.poll);
  pending.placeholder.remove();
  pending = null;
  setDockHold(0);
}

/** 新连接还没连上：面板位置先放占位，连上后换成真正的面板 */
function waitFor(drawer: Drawer): void {
  const placeholder = el('div', 'cs-drawer-hold');
  const width = widths.get(drawer) ?? 0;
  if (width > 0) placeholder.style.width = `${width}px`;
  const body = el('div', 'cs-drawer-hold-body');
  body.append(icon(ICONS[drawer]), el('span', 'cs-drawer-hold-name', drawerLabel(drawer)), el('span', 'cs-drawer-hold-wait', dt('keepWaiting')));
  const cancel = el('button', 'cs-drawer-hold-cancel', dt('keepCancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    desired = null;
    cancelPending();
  });
  body.append(cancel);
  placeholder.append(body);
  document.body.append(placeholder);
  setDockHold(placeholder.offsetWidth);

  const check = () => {
    if (currentView() !== 'term') return cancelPending();
    const state = ready(drawer);
    if (state === 'never') return cancelPending();
    if (!state) return;
    // 真正的面板打开（停靠宽度由它接上）之后再撤占位，中间不露空
    open(drawer);
    cancelPending();
  };
  pending = {
    placeholder,
    poll: window.setInterval(check, POLL_MS),
    timer: window.setTimeout(cancelPending, WAIT_LIMIT_MS),
  };
}

/** 到了一个会话（切换、新建、回到终端页）：你记住的面板开关打开着，就为这个会话打开它 */
function follow(): void {
  cancelPending();
  const drawer = desired;
  if (!drawer || !keepDrawer(drawer) || currentView() !== 'term' || openDrawer() === drawer) return;
  const state = ready(drawer);
  if (state === 'never') return;
  if (state) open(drawer);
  else waitFor(drawer);
}

export function installDrawerFollow(): void {
  (globalThis as { __cloudsshDrawerProgrammatic?: () => void }).__cloudsshDrawerProgrammatic = () => {
    const current = openDrawer();
    if (current) measure(current);
    markProgrammatic();
    if (desired && keepDrawer(desired)) instant();
  };

  // 你自己打开 / 关上面板（网页版自动收起、这里代为打开的不算）
  const observer = new MutationObserver(() => {
    if (programmatic > 0) return;
    const current = openDrawer();
    if (current === desired) return;
    desired = current;
    if (current) measure(current);
    cancelPending();
  });
  for (const drawer of DRAWERS) {
    const node = button(drawer);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  desired = openDrawer();

  // 网页版的监听先注册，它在这个事件里收起命令面板、同步分段条之后，这里再打开
  document.addEventListener('cloudssh:active-terminal-change', () => follow());
  window.addEventListener(VIEW_CHANGED_EVENT, () => {
    if (currentView() === 'term') follow();
    else cancelPending();
  });
}
