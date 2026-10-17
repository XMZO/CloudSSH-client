/**
 * “使用 GitHub 登录”：先选登录方式。
 * - 用浏览器登录：在系统浏览器的 Custom Tab 里完成 GitHub 登录与授权，passkey、密码管理器、
 *   浏览器里已登录的 GitHub 都能用；授权后点标签页底部的“完成登录”回到应用（Rust 侧见 oauth.rs）
 * - 在应用内登录：原来的方式，GitHub 页面在应用的 WebView 里打开（不支持 passkey）
 * 记住上次的选择，下次在面板里标出来。
 */
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { mt } from './i18n';
import { confirmSheet, showActions } from './sheet';
import { native } from './tauri';

type Method = 'browser' | 'app';

const METHOD_KEY = 'cloudssh_login_method';
const HINT_KEY = 'cloudssh_login_browser_hint';

function readMethod(): Method | null {
  try {
    const value = localStorage.getItem(METHOD_KEY);
    return value === 'browser' || value === 'app' ? value : null;
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 忽略
  }
}

/** 原来的方式：导航由 Rust 的导航钩子接管（oauth.rs 的 start_login） */
function loginInApp(): void {
  location.href = '/api/auth/github';
}

let browserLoginRunning = false;

async function loginInBrowser(): Promise<void> {
  if (browserLoginRunning) return;
  // 第一次用时说明：授权后浏览器里会显示 Worker 拒绝回调的文字页，这是正常的
  let hintSeen = false;
  try {
    hintSeen = localStorage.getItem(HINT_KEY) === '1';
  } catch {
    // 忽略
  }
  if (!hintSeen) {
    if (!(await confirmSheet(mt('loginBrowserHint'), mt('loginBrowserContinue'), mt('cancel')))) return;
    remember(HINT_KEY, '1');
  }
  browserLoginRunning = true;
  try {
    await native.githubLoginBrowser();
    // session 已在 Rust 的 Cookie 罐里：重新加载页面，网页版按登录状态进入节点页
    location.href = '/?login=ok';
  } catch (error) {
    const code = String(error);
    if (code === 'cancelled') {
      notify(mt('loginCancelled'), { duration: 2000 });
    } else if (code === 'not_callback') {
      notify(mt('loginNotCallback'), { variant: 'warning' });
    } else if (code === 'no_browser') {
      notify(mt('loginNoBrowser'), { variant: 'warning' });
      loginInApp();
    } else {
      notify(mt('loginFailed', { reason: code }), { variant: 'danger' });
    }
  } finally {
    browserLoginRunning = false;
  }
}

function chooseMethod(): void {
  const last = readMethod();
  showActions(
    mt('loginMethodTitle'),
    [
      {
        label: mt('loginBrowser'),
        icon: 'passkey',
        current: last === 'browser',
        action: () => {
          remember(METHOD_KEY, 'browser');
          void loginInBrowser();
        },
      },
      {
        label: mt('loginInApp'),
        icon: 'login',
        current: last === 'app',
        action: () => {
          remember(METHOD_KEY, 'app');
          loginInApp();
        },
      },
    ],
    mt('cancel')
  );
}

/** 网页版的登录按钮会被重新渲染：在捕获阶段统一拦截点击，先于按钮自己的跳转 */
export function installGithubLogin(): void {
  document.addEventListener(
    'click',
    (event) => {
      const button = event.target instanceof Element ? event.target.closest('#github-login-btn') : null;
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      chooseMethod();
    },
    true
  );
}
