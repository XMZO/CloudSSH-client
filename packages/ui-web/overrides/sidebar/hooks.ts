/**
 * 访问网页版内部实例（由 vite.config.ts 的 desktopHooks 在构建时登记）。
 * 这些都是上游的私有实现细节：每个调用都做存在性检查，找不到就返回 false 让侧栏降级。
 */
import { t } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';

interface TerminalLike {
  insertSnippet?: (command: string, run: boolean) => boolean;
  focus?: () => void;
  blur?: () => void;
  /** 网页版 SSHTerminal 的私有字段：当前的终端 WebSocket（断开或等待重连时为 null） */
  ws?: { readyState?: number } | null;
}

interface TabInfoLike {
  id: string;
  label?: string;
  state?: 'connecting' | 'connected' | 'disconnected' | string;
  hostInfo?: { host: string; port: number; username?: string; serverId?: number };
  wsLatency?: number;
  cfLatency?: number;
  /** 会话就绪后才创建（SFTP 需要 Shell 就绪） */
  sftpPanel?: unknown;
  /** 仅登录用户且 Agent 可用时创建 */
  agentPanel?: unknown;
  terminal?: TerminalLike;
}

interface ServerListLike {
  servers?: { id: number; name?: string }[];
  connectServer?: (id: number) => Promise<void>;
  showModal?: (mode: string, server?: unknown) => void;
  /** 重新拉取服务器列表（网页版回到主页时也会调用） */
  refresh?: () => Promise<void>;
  /** 删除：网页版自己的确认框 → DELETE → 从列表里去掉（被用作跳板等错误由它提示） */
  deleteServer?: (id: number) => Promise<void>;
  /** Worker 开启了一次性分享（/api/config 的 sshSharingEnabled） */
  sharingEnabled?: boolean;
  shareManager?: { open?: (id: number, name: string) => Promise<void> };
}

interface TabManagerLike {
  tabs?: Map<string, TabInfoLike>;
  switchTab?: (id: string) => void;
  closeTab?: (id: string) => void;
  getActiveTab?: () => TabInfoLike | null;
}

export type TabInfo = TabInfoLike;

/**
 * 会话是否真的连着（Shell 已就绪且终端 WebSocket 打开）。正在连接、重连中、已断开都算没连着。
 * 不能只看 tab.state：网页版在几条重连放弃的路径上（例如断网后申请连接令牌一直失败）不会把标签改成
 * “已断开”，会一直停在“连接中”；短暂断线还没被发现时状态也可能仍是“已连接”。
 */
export function sessionIsConnected(tab: TabInfo | null | undefined): boolean {
  if (!tab || tab.state !== 'connected') return false;
  const socket = tab.terminal?.ws;
  // 网页版内部字段变了时退回只看状态
  if (socket === undefined) return true;
  return socket !== null && socket.readyState === 1;
}

function serverList(): ServerListLike | null {
  return ((globalThis as Record<string, unknown>).__cloudsshServerList as ServerListLike) ?? null;
}

function tabManager(): TabManagerLike | null {
  return ((globalThis as Record<string, unknown>).__cloudsshTabManager as TabManagerLike) ?? null;
}

export function canConnect(): boolean {
  return typeof serverList()?.connectServer === 'function';
}

/**
 * 在网页版自己的服务器列表里找这台服务器。网页版只操作它列表里有的服务器，而节点页/侧栏显示的是另一份缓存，
 * 两者可能不一致（例如网页版的列表还没加载出来，或者某次刷新失败被清空过）。找不到就先让网页版重新拉一次；
 * 仍找不到（多半是网络不通）时提示，而不是点了没反应。
 */
async function findListedServer(
  list: ServerListLike,
  id: number,
  failTitle = t('server.connectFailed')
): Promise<{ id: number; name?: string } | null> {
  const find = () => list.servers?.find((item) => item.id === id) ?? null;
  const listed = find();
  if (listed) return listed;
  try {
    await list.refresh?.();
  } catch {
    // 下面统一提示
  }
  const server = find();
  if (!server) notify(t('server.loadFailed'), { title: failTitle, variant: 'danger' });
  return server;
}

/** 走网页版自己的连接流程（申请一次性 token → 新建终端标签）；返回 false 表示网页版钩子不可用 */
export function connectServer(id: number): boolean {
  const list = serverList();
  if (typeof list?.connectServer !== 'function') return false;
  const connect = list.connectServer.bind(list);
  void findListedServer(list, id).then((server) => server && connect(id));
  return true;
}

export function openServerModal(mode: 'add' | 'edit' | 'clone', id?: number): boolean {
  const list = serverList();
  if (typeof list?.showModal !== 'function') return false;
  if (mode === 'add') {
    list.showModal('add');
    return true;
  }
  const show = list.showModal.bind(list);
  if (id === undefined) return false;
  void findListedServer(list, id).then((server) => server && show(mode, server));
  return true;
}

/** 走网页版自己的删除流程（确认框 → DELETE → 从列表里去掉）；返回 false 表示网页版钩子不可用 */
export function deleteServer(id: number): boolean {
  const list = serverList();
  if (typeof list?.deleteServer !== 'function') return false;
  const remove = list.deleteServer.bind(list);
  void findListedServer(list, id, t('common.delete')).then((server) => server && remove(id));
  return true;
}

/** 让网页版重新拉取服务器列表（侧栏、节点页旁听同一个请求一起更新）；网页版钩子不可用时直接拉取 */
export async function refreshServerList(): Promise<void> {
  const list = serverList();
  if (typeof list?.refresh === 'function') await list.refresh();
  else await fetch('/api/servers', { credentials: 'same-origin' });
}

/** Worker 开启了一次性分享（网页版只在这时显示分享按钮） */
export function canShare(): boolean {
  const list = serverList();
  return list?.sharingEnabled === true && typeof list.shareManager?.open === 'function';
}

/** 打开网页版的分享管理（创建链接、撤销、审计记录） */
export function shareServer(id: number): boolean {
  const list = serverList();
  const manager = list?.shareManager;
  if (!list || typeof manager?.open !== 'function') return false;
  const open = manager.open.bind(manager);
  void findListedServer(list, id, t('share.create')).then((server) => server && open(id, server.name ?? ''));
  return true;
}

/** 每台服务器当前打开的终端标签 */
export function sessionsByServer(): Map<number, string[]> {
  const result = new Map<number, string[]>();
  const tabs = tabManager()?.tabs;
  if (!(tabs instanceof Map)) return result;
  for (const tab of tabs.values()) {
    const id = tab.hostInfo?.serverId;
    if (typeof id !== 'number') continue;
    const list = result.get(id);
    if (list) list.push(tab.id);
    else result.set(id, [tab.id]);
  }
  return result;
}

/** 当前打开的终端标签总数（含匿名连接） */
export function tabCount(): number {
  const tabs = tabManager()?.tabs;
  return tabs instanceof Map ? tabs.size : document.querySelectorAll('#tab-bar .tab-close').length;
}

export function terminalVisible(): boolean {
  const section = document.getElementById('terminal-section');
  return !!section && !section.classList.contains('hidden');
}

export function activeServerId(): number | null {
  const terminalVisible = !document.getElementById('terminal-section')?.classList.contains('hidden');
  if (!terminalVisible) return null;
  const id = tabManager()?.getActiveTab?.()?.hostInfo?.serverId;
  return typeof id === 'number' ? id : null;
}

/** 切到该服务器已打开的会话；多个会话时在它们之间轮换 */
export function focusSession(serverId: number): boolean {
  const manager = tabManager();
  const tabIds = sessionsByServer().get(serverId);
  if (!manager?.switchTab || !tabIds?.length) return false;
  const activeId = manager.getActiveTab?.()?.id;
  const index = activeId ? tabIds.indexOf(activeId) : -1;
  manager.switchTab(tabIds[(index + 1) % tabIds.length]);
  // 当前在服务器列表页时，借用网页版“返回终端”按钮切回终端视图
  if (document.getElementById('terminal-section')?.classList.contains('hidden')) {
    document.getElementById('back-to-terminal-btn')?.click();
  }
  return true;
}

/** 当前全部终端标签（按标签栏顺序） */
export function listTabs(): TabInfo[] {
  const tabs = tabManager()?.tabs;
  return tabs instanceof Map ? [...tabs.values()] : [];
}

export function activeTabId(): string | null {
  return tabManager()?.getActiveTab?.()?.id ?? null;
}

export function activeTab(): TabInfo | null {
  return tabManager()?.getActiveTab?.() ?? null;
}

/** 切到指定标签；在服务器列表页时同时切回终端视图 */
export function switchToTab(id: string): boolean {
  const manager = tabManager();
  if (!manager?.switchTab) return false;
  manager.switchTab(id);
  if (!terminalVisible()) document.getElementById('back-to-terminal-btn')?.click();
  return true;
}

export function closeTabById(id: string): boolean {
  const manager = tabManager();
  if (!manager?.closeTab) return false;
  manager.closeTab(id);
  return true;
}
