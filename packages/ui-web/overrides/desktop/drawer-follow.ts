/**
 * 偏好设置“保持面板”：SFTP、自定义命令、AI 助手三个面板各一个开关（默认关）。每个会话标签记住自己开着的面板，
 * 网页版原来切换标签、离开终端页时一律收起：
 * - 离开一个标签（切到别的标签、连接新服务器、回到服务器列表）时记下它开着哪个面板；切回它、回到终端页时照原样
 *   打开（那个面板的开关开着才算），它原来什么都没开就什么都不开。A 开着 SFTP、B 开着 AI 助手、C 什么都没开，
 *   切到哪个就是哪个的样子
 * - 新连接的标签还没有自己的记录：沿用连接时开着的面板
 * - 切到已连上的会话：同一瞬间换成它的面板，不播放滑入滑出动画；两边开着同一种面板时停靠宽度不变，终端不重算行列
 * - 新连接（SFTP、AI 助手的面板要连上后才有）：面板位置先放一块同宽的占位“连接后自动打开…”，停靠宽度照留，
 *   新终端一开始就是让出位置后的宽度；连上后换成真正的面板。30 秒还没连上就收起占位
 * - 自定义命令面板所有会话共用一个：两边都开着它时根本不收起（网页版原来先收起再打开，每次清空搜索、
 *   重新加载一遍列表），面板原样留着：列表、搜索、滚动位置都不变
 * - SFTP 面板每个会话一个：网页版切走时把它收起，会断开 SFTP 连接、取消传输，切回来重新连接、重新列目录。
 *   现在切走时只是停放（看不见，连接和传输照旧），切回来原样出现：还在原来的目录、原来的选中项，传输接着进行。
 *   你在那个标签里自己关上 SFTP、关掉 SFTP 的开关、关掉那个标签时才真正收起
 * 两种界面主题都生效（经典主题的面板盖在终端上，没有停靠宽度）。
 *
 * 构建钩子（vite.config.ts）在网页版收起全部面板（closeAllDrawers）和切换标签之前调用 __cloudsshDrawerProgrammatic：
 * 这一刻面板还是离开的那个标签的样子，在这里记下；随后网页版的收起不算你的操作。切换标签后网页版派发
 * cloudssh:active-terminal-change，这里按新标签的记录打开。
 * 另外：网页版收起命令面板之前问 __cloudsshKeepSnippet、SFTP 面板收起之前问 __cloudsshParkSftp，返回 true 就不收起；
 * 新建会话标签（连接服务器、克隆会话）之前调用 __cloudsshDrawersStay（紧接着的收起全部面板是留在终端页的）。
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
  if (!on && drawer === 'sftp') releaseParked();
}

export function drawerLabel(drawer: Drawer): string {
  return drawer === 'sftp' ? dt('sftp') : drawer === 'snippet' ? dt('snippets') : dt('agent');
}

/** 网页版 SFTPPanel 里用到的成员（TypeScript 的 private，运行时照常可用） */
interface SftpLike {
  visible?: boolean;
  container?: HTMLElement;
  hide(): void;
  __cloudsshParked?: boolean;
}

interface TabLike {
  state?: string;
  sftpPanel?: SftpLike | null;
  agentPanel?: unknown;
}

const button = (drawer: Drawer) => document.getElementById(`${drawer}-toggle-btn`);
const openDrawer = (): Drawer | null => DRAWERS.find((drawer) => button(drawer)?.classList.contains('active')) ?? null;
const activeTab = () =>
  (globalThis as { __cloudsshTabManager?: { getActiveTab?: () => TabLike | null } }).__cloudsshTabManager?.getActiveTab?.() ?? null;

/** 每个会话标签离开时开着的面板（null = 什么都没开） */
const memory = new WeakMap<TabLike, Drawer | null>();
/** 最近一次离开的标签开着的面板：新连接的标签还没有自己的记录，沿用它 */
let inherit: Drawer | null = null;
/** 网页版自动收起 / 这里代为打开的过程中：面板开合不算你的操作 */
let programmatic = 0;
/** 每个面板最近一次打开时的宽度（占位用） */
const widths = new Map<Drawer, number>();
/** 新连接还没连上，等着为它打开的面板（tab：等的是哪个标签） */
let pending: { tab: TabLike; drawer: Drawer; timer: number; poll: number; placeholder: HTMLElement } | null = null;
/** 上一次看到的打开着的面板（用来分辨你自己换了面板） */
let lastOpen: Drawer | null = null;
/** 停放着的 SFTP 面板（切走了的会话标签的）：SFTP 连接、传输照旧，只是不显示 */
const parked = new Set<SftpLike>();
/** 正在真正收起停放着的面板：这时网页版的收起照常执行 */
let releasing = false;
/** 接下来那次收起全部面板是新建会话标签之前的（留在终端页） */
let stay = false;

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
function waitFor(tab: TabLike, drawer: Drawer): void {
  const placeholder = el('div', 'cs-drawer-hold');
  const width = widths.get(drawer) ?? 0;
  if (width > 0) placeholder.style.width = `${width}px`;
  const body = el('div', 'cs-drawer-hold-body');
  body.append(icon(ICONS[drawer]), el('span', 'cs-drawer-hold-name', drawerLabel(drawer)), el('span', 'cs-drawer-hold-wait', dt('keepWaiting')));
  const cancel = el('button', 'cs-drawer-hold-cancel', dt('keepCancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    memory.set(tab, null);
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
    tab,
    drawer,
    placeholder,
    poll: window.setInterval(check, POLL_MS),
    timer: window.setTimeout(cancelPending, WAIT_LIMIT_MS),
  };
}

/** 网页版要收起这个 SFTP 面板（切换标签、收起全部面板）：保持着 SFTP 时改为停放，返回 true（网页版不再收起） */
function parkSftp(panel: SftpLike): boolean {
  if (panel.__cloudsshParked) return !releasing;
  // 只停放正开着的（离开的标签开着 SFTP，记录里就是它，回来时原样出现）；你自己关上（不是网页版自动收起）照常收起
  if (releasing || programmatic === 0 || !keepDrawer('sftp') || panel.visible !== true || !panel.container) return false;
  panel.__cloudsshParked = true;
  panel.container.classList.add('cs-sftp-parked');
  parked.add(panel);
  return true;
}

/** 回到停放着面板的会话：原样显示（它本来就是打开状态，网页版的分段条已经按它标成 SFTP） */
function unpark(panel: SftpLike): void {
  panel.__cloudsshParked = false;
  parked.delete(panel);
  instant();
  panel.container?.classList.remove('cs-sftp-parked');
}

/** 不再保持 SFTP：停放着的真正收起（断开 SFTP 连接、结束传输，与网页版收起一样），收起后再撤掉停放（不会露出来滑走） */
function releaseParked(): void {
  releasing = true;
  try {
    for (const panel of [...parked]) {
      parked.delete(panel);
      panel.__cloudsshParked = false;
      // 会话标签已经关了：面板随之销毁，不用再收起
      if (panel.container?.isConnected) panel.hide();
      panel.container?.classList.remove('cs-sftp-parked');
    }
  } finally {
    releasing = false;
  }
}

/** 这个标签该开着的面板：它离开时的记录（新标签沿用最近离开的那个），开关关着的不算 */
function wanted(tab: TabLike | null): Drawer | null {
  if (!tab) return null;
  const drawer = memory.has(tab) ? (memory.get(tab) ?? null) : inherit;
  return drawer && keepDrawer(drawer) ? drawer : null;
}

/** 离开当前标签之前（切换、新建连接、离开终端页）：记下它开着的面板（还在等连上的，记它在等的那个） */
function remember(): void {
  const tab = activeTab();
  // 不在终端页（服务器列表里切标签、连新服务器）：面板在离开终端页时已经收起，那时记过了，别用“什么都没开”盖掉
  if (!tab || currentView() !== 'term') return;
  const drawer = pending?.tab === tab ? pending.drawer : openDrawer();
  memory.set(tab, drawer);
  inherit = drawer;
}

/**
 * 网页版要收起命令面板：切换标签时新标签也开着它、新建会话标签时它正开着（新标签沿用），就不收起，原样留着，返回 true
 */
function keepSnippet(context?: 'close-all'): boolean {
  if (!keepDrawer('snippet') || currentView() !== 'term' || openDrawer() !== 'snippet') return false;
  if (context === 'close-all') return stay;
  return wanted(activeTab()) === 'snippet';
}

/** 到了一个会话（切换、新建、回到终端页）：照它的记录打开面板，没有记录的沿用最近离开的那个标签 */
function follow(): void {
  cancelPending();
  if (currentView() !== 'term') return;
  const tab = activeTab();
  if (!tab) return;
  const drawer = wanted(tab);
  const panel = tab.sftpPanel;
  // 停放着的 SFTP 就是它离开时开着的：原样出现
  if (panel?.__cloudsshParked) unpark(panel);
  if (!drawer || openDrawer() === drawer) return;
  const state = ready(drawer);
  if (state === 'never') return;
  if (state) open(drawer);
  else waitFor(tab, drawer);
}

export function installDrawerFollow(): void {
  const hooks = globalThis as {
    __cloudsshDrawerProgrammatic?: () => void;
    __cloudsshDrawersStay?: () => void;
    __cloudsshKeepSnippet?: typeof keepSnippet;
    __cloudsshParkSftp?: typeof parkSftp;
  };
  hooks.__cloudsshDrawerProgrammatic = () => {
    const current = openDrawer();
    if (current) measure(current);
    // 同一次操作里的第一下（新建连接是先收起全部面板、再切到新标签）：这时面板还是离开的那个标签的样子
    if (programmatic === 0) remember();
    markProgrammatic();
    if (DRAWERS.some(keepDrawer)) instant();
  };
  hooks.__cloudsshDrawersStay = () => {
    stay = true;
    // 紧接着同步调用收起全部面板，用完即清
    window.setTimeout(() => (stay = false), 0);
  };
  hooks.__cloudsshKeepSnippet = keepSnippet;
  hooks.__cloudsshParkSftp = parkSftp;

  // 你自己换了面板（网页版自动收起、这里代为打开的不算）：在等新连接连上的占位就不用了
  const observer = new MutationObserver(() => {
    const current = openDrawer();
    if (current === lastOpen) return;
    lastOpen = current;
    if (programmatic > 0) return;
    if (current) measure(current);
    cancelPending();
  });
  for (const drawer of DRAWERS) {
    const node = button(drawer);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  lastOpen = openDrawer();

  // 网页版的监听先注册，它在这个事件里收起命令面板、同步分段条之后，这里再打开
  document.addEventListener('cloudssh:active-terminal-change', () => follow());
  window.addEventListener(VIEW_CHANGED_EVENT, () => {
    if (currentView() === 'term') follow();
    else cancelPending();
  });
  // 关掉的会话标签里停放着的面板已随标签销毁
  document.addEventListener('cloudssh:active-terminal-change', () => {
    for (const panel of parked) if (!panel.container?.isConnected) parked.delete(panel);
  });
}
