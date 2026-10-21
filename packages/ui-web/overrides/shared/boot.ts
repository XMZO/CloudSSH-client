/**
 * 打开就是完整的服务器列表（手机、电脑共用），状态见 ./boot-core.ts。
 *
 * - 缓存：服务器列表每次变化（网页版拉取、连接后更新最近连接时间、删除、识别出系统）都写进客户端的应用数据目录
 *   （手机 Rust、电脑主进程，按实例分开；不受“清除缓存”影响；内容没有密码与私钥）。登出、登录失效时删掉
 * - 启动：有缓存（上次登录着）就先用它填上数据源、直接显示列表页，马上完成启动；登录检查与拉取在后台照常进行，
 *   回来后静默换成最新的。登录失效时网页版照常换成连接页（缓存同时删掉，下次不再先显示）
 * - 没缓存（第一次、刚登录）：等列表到了再完成启动，不露出骨架
 * - 用缓存显示后，网页版自己的拉取没成功（离线、网络不好）就隔一会儿再拉，直到拿到最新的，不提示。
 *   打开着时跟上别处的改动（定时、切回前台时刷新）见 ./live-sync.ts
 */
import type { ServerConfig } from '@cloudssh/core';
import { getServers, primeServers, reloadServers, resetServers, setServerPersistor, subscribe } from '../sidebar/store';
import { bootCore } from './boot-core';

/** 用缓存显示后，过这么久还没拿到最新列表就自己拉 */
const FIRST_SYNC_MS = 6000;
/** 自己拉失败后的重试间隔 */
const RETRY_MS = [5000, 15_000, 30_000, 60_000, 300_000];
/** 写缓存合并：短时间内多次变化只写一次 */
const WRITE_DELAY_MS = 400;

function parseCached(text: string | null): ServerConfig[] | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text) as unknown;
    return Array.isArray(data) && data.every((item) => item && typeof item === 'object' && typeof (item as ServerConfig).id === 'number')
      ? (data as ServerConfig[])
      : null;
  } catch {
    return null;
  }
}

/** 网页版登录检查通过时做的页面切换，先做一遍（之后网页版自己再做一遍，不会冲突） */
function showServerListPage(): boolean {
  const space = document.getElementById('user-space-section');
  if (!space) return false;
  document.getElementById('auth-section')?.classList.add('hidden');
  space.classList.remove('hidden');
  space.classList.add('flex');
  return true;
}

export function attachBoot(options: { canShowEarly: () => boolean }): void {
  const core = bootCore();
  if (!core) return;

  // ---- 写缓存 ----
  let lastFresh = 0;
  let writeTimer = 0;
  let pending: ServerConfig[] | null | undefined;
  setServerPersistor((next, unchanged) => {
    if (next) lastFresh = Date.now();
    // 和手上的一样（定时刷新多半如此）：缓存里已经是它了
    if (!core.write || (unchanged && next)) return;
    pending = next;
    window.clearTimeout(writeTimer);
    const flush = () => {
      const value = pending;
      pending = undefined;
      if (value === undefined) return;
      void core.write!(value ? JSON.stringify(value) : null).catch(() => undefined);
    };
    // 登出、登录失效马上删；列表变化合并一下再写
    if (next === null) flush();
    else writeTimer = window.setTimeout(flush, WRITE_DELAY_MS);
  });

  // ---- 没缓存时：列表页显示了且列表到了才完成 ----
  // 列表组件在下一帧（requestAnimationFrame）里画，完成也放到那一帧，同一次绘制里一起出现，不会先露出空列表页
  const finishWhenListed = () => {
    if (core.userShown && getServers() !== null && !core.done) requestAnimationFrame(() => core.finish());
  };
  core.onUserShown(finishWhenListed);
  subscribe(finishWhenListed);

  // ---- 用缓存显示后，直到拿到最新列表 ----
  let syncing = false;
  let retry = 0;
  let retryTimer = 0;
  const sync = async () => {
    if (syncing || getServers() === null) return;
    syncing = true;
    const before = lastFresh;
    try {
      await reloadServers();
    } catch {
      // 网络不通：下面按间隔重试
    } finally {
      syncing = false;
    }
    window.clearTimeout(retryTimer);
    if (lastFresh !== before || getServers() === null) {
      retry = 0;
      return;
    }
    retryTimer = window.setTimeout(() => void sync(), RETRY_MS[Math.min(retry++, RETRY_MS.length - 1)]);
  };

  // ---- 有缓存：直接显示完整列表 ----
  let primed = false;
  // 随后发现没登录、登录失效（网页版换成连接页）：缓存的列表从数据源里拿掉（电脑侧栏等不再显示它）
  core.onAuthShown(() => {
    if (primed && lastFresh === 0) resetServers();
  });
  void core.cached.then((text) => {
    const cached = parseCached(text);
    if (!cached || core.done || core.settled || getServers() !== null || !options.canShowEarly()) return;
    primed = true;
    primeServers(cached);
    if (!showServerListPage()) return;
    // 列表组件在下一帧里画（电脑端表格），完成也放到那一帧，同一次绘制里一起出现
    requestAnimationFrame(() => core.finish());
    // 网页版自己的拉取（登录检查通过后）一般会先到；没到就自己拉
    window.setTimeout(() => {
      if (lastFresh === 0) void sync();
    }, FIRST_SYNC_MS);
  });
}
