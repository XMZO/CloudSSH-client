/**
 * 访问网页版内部实例（由 vite.config.ts 的 desktopHooks 在构建时登记）。
 * 这些都是上游的私有实现细节：每个调用都做存在性检查，找不到就返回 false 让侧栏降级。
 */

interface TabInfoLike {
  id: string;
  label?: string;
  hostInfo?: { host: string; port: number; username?: string; serverId?: number };
}

interface ServerListLike {
  servers?: { id: number }[];
  connectServer?: (id: number) => Promise<void>;
  showModal?: (mode: string, server?: unknown) => void;
}

interface TabManagerLike {
  tabs?: Map<string, TabInfoLike>;
  switchTab?: (id: string) => void;
  getActiveTab?: () => TabInfoLike | null;
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

/** 走网页版自己的连接流程（申请一次性 token → 新建终端标签） */
export function connectServer(id: number): boolean {
  const list = serverList();
  if (typeof list?.connectServer !== 'function') return false;
  void list.connectServer(id);
  return true;
}

export function openServerModal(mode: 'add' | 'edit' | 'clone', id?: number): boolean {
  const list = serverList();
  if (typeof list?.showModal !== 'function') return false;
  if (mode === 'add') {
    list.showModal('add');
    return true;
  }
  const server = list.servers?.find((item) => item.id === id);
  if (!server) return false;
  list.showModal(mode, server);
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
