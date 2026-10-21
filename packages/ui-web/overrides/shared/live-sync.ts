/**
 * 打开着时跟上别处（其他客户端、网页）的改动：服务器列表、自定义主题、手机快捷键（手机、电脑共用）。
 *
 * Worker 没有推送，只能问：
 * - 在前台时每 REFRESH_MS 问一次；切回前台、窗口重新获得焦点、网络恢复时，距上次超过 RECHECK_MS 也马上问
 * - 只在登录着（数据源里有列表）、页面看得见时问；后台不问
 * - 都不提示：内容没变就什么都不动（不重画、不打断选中、滚动、菜单），问不到就等下一次
 * 服务器列表走数据源自己的请求（网页版的 refresh 在断网时会把它自己的列表清空），有变化时顺带更新网页版内存里的列表
 * （经典主题的卡片、连接与编辑都用它）。主题、手机快捷键先拿原始内容和上次比，变了才交给网页版自己的同步
 * （构建钩子 __cloudsshCloudSync；主题只在本机选的是自定义主题时切换，与网页版启动时一致）。
 */
import type { ServerConfig } from '@cloudssh/core';
import { getServers, reloadServers, subscribe } from '../sidebar/store';

/** 在前台时多久问一次 */
const REFRESH_MS = 150_000;
/** 切回前台、获得焦点、网络恢复时，距上次超过这么久才再问（避免来回切换时连着问） */
const RECHECK_MS = 15_000;
/** 定时检查的粒度 */
const TICK_MS = 30_000;
/** 第一次拿到列表后过这么久记下主题、快捷键的“上次内容”（网页版启动时自己已经同步过一次） */
const BASELINE_DELAY_MS = 5000;

interface CloudSync {
  theme(): Promise<void>;
  mobileShortcuts(): Promise<void> | void;
}

interface UpstreamList {
  servers?: ServerConfig[];
  renderServerGrid?: () => void;
}

/** 数据源换成了新列表：网页版内存里的列表也换上（它的卡片照常重画，隐藏时看不见） */
function syncUpstreamList(): void {
  const list = (globalThis as { __cloudsshServerList?: UpstreamList }).__cloudsshServerList;
  const servers = getServers();
  if (!list || !servers || !Array.isArray(list.servers)) return;
  list.servers = servers.map((server) => ({ ...server, tags: Array.isArray(server.tags) ? server.tags : [] }));
  try {
    list.renderServerGrid?.();
  } catch {
    // 网页版内部变了：只是卡片晚一点更新
  }
}

export function installLiveSync(options: { mobileShortcuts: boolean }): void {
  let lastCheck = Date.now();
  let running = false;
  const previous = new Map<string, string>();

  /** 这份内容和上次比变了没有（第一次只记下，算没变） */
  const changed = async (key: string, path: string): Promise<boolean> => {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) return false;
    const text = await response.text();
    const before = previous.get(key);
    previous.set(key, text);
    return before !== undefined && before !== text;
  };

  const check = async () => {
    if (running || document.visibilityState !== 'visible' || getServers() === null) return;
    running = true;
    lastCheck = Date.now();
    try {
      if ((await reloadServers().catch(() => 'failed')) === 'changed') syncUpstreamList();
      if (getServers() === null) return;
      const sync = (globalThis as { __cloudsshCloudSync?: CloudSync }).__cloudsshCloudSync;
      if (!sync) return;
      if (await changed('theme', '/api/user/theme').catch(() => false)) await Promise.resolve(sync.theme()).catch(() => undefined);
      if (options.mobileShortcuts && (await changed('shortcuts', '/api/user/mobile-shortcuts').catch(() => false))) {
        await Promise.resolve(sync.mobileShortcuts()).catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };

  const recheck = () => {
    if (Date.now() - lastCheck >= RECHECK_MS) void check();
  };
  window.setInterval(() => {
    if (Date.now() - lastCheck >= REFRESH_MS) void check();
  }, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheck();
  });
  window.addEventListener('focus', recheck);
  window.addEventListener('online', recheck);

  // 登录后第一次拿到列表：过一会儿问一次，记下主题、快捷键的“上次内容”
  let baselined = false;
  const baseline = () => {
    if (baselined || getServers() === null) return;
    baselined = true;
    window.setTimeout(() => void check(), BASELINE_DELAY_MS);
  };
  subscribe(baseline);
  baseline();
}
