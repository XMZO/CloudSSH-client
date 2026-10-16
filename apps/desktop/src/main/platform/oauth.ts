/**
 * GitHub 登录：独立登录窗口 + Cookie 迁移。
 *
 * 服务端回调地址固定为 Worker 自己的域名（BASE_URL 或请求 origin），且 state 校验依赖同一 Cookie 罐，
 * 所以登录必须在“直接访问 Worker”的浏览器环境里完成。这里用一个独立分区（不挂 origin bridge，
 * 完全原生）打开 /api/auth/github，GitHub 授权回调写入 session Cookie 后，把它复制到实例分区。
 *
 * 好处：GitHub 页面不经过任何拦截；主窗口永远停留在 Worker origin；
 * GitHub 的登录状态保存在独立分区，下次登录只需一键授权。
 */
import {
  githubLoginUrl,
  type InstanceConfig,
  isPostLoginLanding,
  originOf,
  SESSION_COOKIE_NAME,
} from '@cloudssh/core';
import { BrowserWindow, type Cookie, session, shell } from 'electron';
import { createLogger } from '../logger';
import { getInstanceSession, oauthPartition } from './session';

const log = createLogger('oauth');

const inFlight = new Map<string, Promise<boolean>>();
const loginWindows = new Map<string, BrowserWindow>();

function cookieMatchesHost(cookie: Cookie, host: string): boolean {
  const domain = (cookie.domain ?? '').replace(/^\./, '');
  return domain === host || (!cookie.hostOnly && host.endsWith(`.${domain}`));
}

async function copySessionCookie(instance: InstanceConfig, cookie: Cookie): Promise<void> {
  const target = getInstanceSession(instance);
  const origin = originOf(instance.baseUrl)!;
  await target.cookies.set({
    url: `${origin}/`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    secure: cookie.secure ?? origin.startsWith('https:'),
    httpOnly: cookie.httpOnly ?? true,
    sameSite: cookie.sameSite === 'unspecified' ? 'lax' : cookie.sameSite,
    expirationDate: cookie.expirationDate,
    // 不传 domain：保持 host-only，与服务端 Set-Cookie 语义一致
  });
  await target.cookies.flushStore();
}

/**
 * 打开登录窗口，成功返回 true（session Cookie 已写入实例分区），用户关闭窗口返回 false。
 * 同一实例重复调用会复用进行中的登录。
 */
export function loginWithGitHub(instance: InstanceConfig, parent?: BrowserWindow): Promise<boolean> {
  const existing = inFlight.get(instance.id);
  if (existing) {
    const win = loginWindows.get(instance.id);
    if (win && !win.isDestroyed()) win.focus();
    return existing;
  }
  const task = runLogin(instance, parent).finally(() => inFlight.delete(instance.id));
  inFlight.set(instance.id, task);
  return task;
}

async function runLogin(instance: InstanceConfig, parent?: BrowserWindow): Promise<boolean> {
  const origin = originOf(instance.baseUrl)!;
  const host = new URL(origin).host;
  const authSession = session.fromPartition(oauthPartition(instance.id));

  // 清掉上次遗留的 Worker Cookie，避免把旧 session 误当成新登录结果
  for (const cookie of await authSession.cookies.get({ url: origin })) {
    if (cookie.name === SESSION_COOKIE_NAME) await authSession.cookies.remove(origin, cookie.name);
  }

  const win = new BrowserWindow({
    width: 520,
    height: 760,
    parent,
    modal: false,
    title: `登录 GitHub — ${instance.name}`,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      session: authSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  loginWindows.set(instance.id, win);
  win.on('page-title-updated', (event) => event.preventDefault());

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = async (cookie: Cookie | null) => {
      if (settled) return;
      settled = true;
      authSession.cookies.removeListener('changed', onCookieChanged);
      if (cookie) {
        try {
          await copySessionCookie(instance, cookie);
          await authSession.cookies.remove(origin, SESSION_COOKIE_NAME);
          log.info('GitHub 登录成功，session 已写入实例', instance.id);
        } catch (error) {
          log.error('迁移 session Cookie 失败', error);
          cookie = null;
        }
      }
      if (!win.isDestroyed()) win.destroy();
      resolve(!!cookie);
    };

    const tryFinishFromJar = async () => {
      const cookies = await authSession.cookies.get({ url: origin, name: SESSION_COOKIE_NAME });
      const found = cookies.find((cookie) => cookie.value && cookieMatchesHost(cookie, host));
      if (found) await finish(found);
    };

    const onCookieChanged = (_event: unknown, cookie: Cookie, _cause: string, removed: boolean) => {
      if (!removed && cookie.name === SESSION_COOKIE_NAME && cookie.value && cookieMatchesHost(cookie, host)) {
        void finish(cookie);
      }
    };
    authSession.cookies.on('changed', onCookieChanged);

    // 回调成功后服务端会 302 回 Worker 首页：拦下来，不在登录窗口里加载完整应用
    const onLanding = (event: Electron.Event, url: string) => {
      if (isPostLoginLanding(url, origin)) {
        event.preventDefault();
        void tryFinishFromJar();
      }
    };
    win.webContents.on('will-redirect', onLanding);
    win.webContents.on('will-navigate', onLanding);

    // GitHub 页面里的“忘记密码”等新窗口链接交给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 = ERR_ABORTED（被我们拦下的跳转），忽略
      if (isMainFrame && code !== -3) log.warn('登录页加载失败', code, description, url);
    });

    win.on('closed', () => {
      loginWindows.delete(instance.id);
      void finish(null);
    });

    log.info('打开 GitHub 登录窗口', instance.id, origin);
    void win.loadURL(githubLoginUrl(origin));
  });
}
