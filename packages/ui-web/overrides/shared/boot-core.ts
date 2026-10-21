/**
 * 启动首屏（手机、电脑共用）的核心状态：在网页版脚本之前装上（mobile/early.ts、desktop/early.ts），只记状态、不依赖数据源。
 *
 * 网页版的 HTML 默认显示匿名连接页，登录检查（/api/auth/me）回来才换成服务器列表页，列表页先是骨架、/api/servers 回来才有内容。
 * 样式（mobile.css、desktop/boot.css）在启动完成（html.cs-booted）前把连接页和列表页都藏起来，中间等久了转个圈；
 * 什么时候算完成：
 * - 有缓存的服务器列表（上次登录着）：shared/boot.ts 直接用它显示完整列表，马上完成，登录检查与刷新在后台进行
 * - 网页版决定显示匿名连接页、分享落地页、独立终端标签页（构建钩子调用 __cloudsshBootDone）：马上完成
 * - 网页版显示了列表页：等服务器列表到了再完成（不露出骨架），最多再等 USER_WAIT_MS
 * - 兜底 BOOT_TIMEOUT_MS：不管怎样都完成，不会一直空白
 */

export type BootKind = 'user' | 'auth' | 'share' | 'terminal';

export interface BootCore {
  /** 启动已完成（藏着的页面放出来了） */
  readonly done: boolean;
  /** 网页版已决定显示匿名连接页、分享落地页或独立终端：不能再用缓存的列表盖上去 */
  readonly settled: boolean;
  /** 网页版已显示服务器列表页（登录检查通过） */
  readonly userShown: boolean;
  /** 缓存的服务器列表（JSON 文本）；读不到、当前实例没登录过时为 null */
  readonly cached: Promise<string | null>;
  /** 写缓存（null 删除）；不在客户端里、旧版客户端没有时为 null */
  readonly write: ((value: string | null) => Promise<void>) | null;
  finish(): void;
  /** 网页版显示了列表页时通知（已经显示过就马上调用） */
  onUserShown(listener: () => void): void;
  /** 网页版显示了匿名连接页（没登录、登录失效）时通知 */
  onAuthShown(listener: () => void): void;
}

const BOOT_TIMEOUT_MS = 8000;
const USER_WAIT_MS = 4000;
const DONE_CLASS = 'cs-booted';

interface Scope {
  __cloudsshBootCore?: BootCore;
  __cloudsshBootDone?: (kind?: BootKind) => void;
}

export function bootCore(): BootCore | null {
  return (globalThis as Scope).__cloudsshBootCore ?? null;
}

/** 装上启动状态（只装一次）。cached / write 由平台提供：手机走 Rust、电脑走主进程，都存在应用数据目录 */
export function installBootCore(options: {
  cached: Promise<string | null>;
  write: ((value: string | null) => Promise<void>) | null;
}): BootCore {
  const scope = globalThis as Scope;
  if (scope.__cloudsshBootCore) return scope.__cloudsshBootCore;
  const root = document.documentElement;
  const userListeners: (() => void)[] = [];
  const authListeners: (() => void)[] = [];
  let done = false;
  let settled = false;
  let userShown = false;
  let timer = 0;

  const finish = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    root.classList.add(DONE_CLASS);
  };
  timer = window.setTimeout(finish, BOOT_TIMEOUT_MS);

  const core: BootCore = {
    get done() {
      return done;
    },
    get settled() {
      return settled;
    },
    get userShown() {
      return userShown;
    },
    cached: options.cached.catch(() => null),
    write: options.write,
    finish,
    onUserShown(listener) {
      if (userShown) listener();
      else userListeners.push(listener);
    },
    onAuthShown(listener) {
      authListeners.push(listener);
    },
  };
  scope.__cloudsshBootCore = core;
  scope.__cloudsshBootDone = (kind = 'auth') => {
    if (kind !== 'user') {
      settled = true;
      finish();
      if (kind === 'auth') {
        // 没登录、登录失效：缓存的列表作废，下次启动不再先显示它（网页版第一次登录检查早于数据源旁听，不能等那边删）
        void options.write?.(null).catch(() => undefined);
        for (const listener of authListeners) listener();
      }
      return;
    }
    if (userShown) return;
    userShown = true;
    // 列表一直没到（/api/servers 失败）也不能一直藏着
    window.setTimeout(finish, USER_WAIT_MS);
    for (const listener of userListeners.splice(0)) listener();
  };
  return core;
}

/** 不在客户端里（浏览器直接打开）：没有缓存可用，页面照常显示 */
export function skipBoot(): void {
  document.documentElement.classList.add(DONE_CLASS);
}

const AUTH_RETRY_MS = [1000, 2000, 4000, 8000, 15_000];

/**
 * 启动时的登录检查（网页版 init 里的 GET /api/auth/me）因为网络不通失败时，网页版会当成没登录换成连接页，之后也不再检查。
 * 有缓存的列表（上次登录着）时不让它失败：一直等着重试（递增间隔，网络恢复时立即），列表照常显示，网络回来后网页版接着往下走；
 * 真的没登录（401）照常返回。只管第一次检查，之后的请求原样。要在网页版脚本之前、手机网络垫片之后装上
 */
export function installAuthRetry(core: BootCore): void {
  const inner = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let path = '';
    try {
      path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    } catch {
      // 不是 /api/auth/me
    }
    if (path !== '/api/auth/me' || core.userShown || core.settled) return inner(input, init);
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner(input, init);
      } catch (error) {
        if (core.userShown || core.settled || init?.signal?.aborted || !(await core.cached)) throw error;
        await new Promise<void>((resolve) => {
          const done = () => {
            window.clearTimeout(timer);
            window.removeEventListener('online', done);
            resolve();
          };
          const timer = window.setTimeout(done, AUTH_RETRY_MS[Math.min(attempt, AUTH_RETRY_MS.length - 1)]);
          window.addEventListener('online', done);
        });
      }
    }
  };
}
