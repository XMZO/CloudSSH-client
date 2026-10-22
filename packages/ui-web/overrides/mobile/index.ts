/**
 * 移动端界面功能（在网页版之后执行）：
 * - 节点分组首页（nodes.ts）与设置面板（settings.ts），匿名连接页的设置入口（auth-entry.ts）
 * - 返回键：关闭最上层浮层 → 终端回到节点页 → 退到后台（保持会话）
 * - 后台保活：有会话时让 Android 前台服务保持连接
 * - GitHub 登录方式（浏览器 / 应用内，github-login.ts）、登录结果与下载结果提示
 * - 终端触摸操作：长按选中复制、双击选词、双指缩放字号（terminal-touch.ts）
 * - 快捷键栏：按住方向键等连续输入，长按不选中图标、不弹系统菜单（key-repeat.ts）
 * - nano、less 这类全屏程序里上下滑动：换成方向键（alt-scroll.ts）
 * - 命令行里点哪光标到哪；编辑器没开鼠标支持时提示怎么打开（tap-cursor.ts）
 */
import { onBackButtonPress } from '@tauri-apps/api/app';
import { t } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import '../desktop.css';
import '../shared/web-fixes.css';
import { installLanguagePicker, type LanguageMenu } from '../shared/language-picker';
import { installAgentOutput } from '../shared/agent-output';
import { installCompactServerForm } from '../shared/server-form';
import { installTagPicker } from '../shared/server-tags';
import { installSnippetSort } from '../shared/snippet-sort';
import { installTerminalEnhancements } from '../shared/terminal';
import { tabCount, terminalVisible } from '../sidebar/hooks';
import { installFetchObserver } from '../sidebar/store';
import { attachBoot } from '../shared/boot';
import { installLiveSync } from '../shared/live-sync';
import { mountAuthSettings } from './auth-entry';
import { installGithubLogin } from './github-login';
import { mt } from './i18n';
import './mobile.css';
import { mountNodes } from './nodes';
import { closePanel, panelIsOpen } from './skin/panels';
import { startSkin } from './skin';
import { keepAliveEnabled } from './settings';
import { closeSheet, isSheetOpen, showActions } from './sheet';
import { mountTabs } from './tabs';
import { configurePresets, installCredentialPresets, localVault } from '../shared/credential-presets';
import { installMobileNotifications } from './notifications';
import { installAltScroll } from './alt-scroll';
import { installKeyRepeat } from './key-repeat';
import { installKeyboardShift } from './keyboard-shift';
import { installMobileToasts } from './toasts';
import { installTapCursor } from './tap-cursor';
import { installTerminalTouch } from './terminal-touch';
import { isTauri, native } from './tauri';

// ---------- 返回键 ----------

const pressEscape = (target: EventTarget) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));

function isShown(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement) || node.classList.contains('hidden')) return false;
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = node.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left < innerWidth - 4 &&
    rect.right > 4 &&
    rect.top < innerHeight - 4 &&
    rect.bottom > 4
  );
}

/** 关闭最上层浮层；有可关闭的返回 true。复用网页版自己的 Escape 处理。 */
function closeTopOverlay(): boolean {
  if (isSheetOpen()) {
    closeSheet();
    return true;
  }
  const dialog = [...document.querySelectorAll('dialog[open]')].pop() as HTMLDialogElement | undefined;
  if (dialog) {
    pressEscape(dialog);
    if (dialog.open) dialog.close();
    return true;
  }
  const modal = [...document.querySelectorAll('.responsive-modal, [role="dialog"]')].filter(isShown).pop();
  if (modal) {
    pressEscape(modal);
    return true;
  }
  if (isShown(document.getElementById('mobile-more-menu'))) {
    document.querySelector<HTMLElement>('[aria-controls="mobile-more-menu"]')?.click();
    return true;
  }
  // 每个会话各有一个同 id 的 SFTP / AI 助手面板，必须逐个检查；开关状态以网页版写入的样式为准
  for (const id of ['snippet-panel', 'agent-panel', 'sftp-panel']) {
    for (const panel of document.querySelectorAll<HTMLElement>(`[id="${id}"]`)) {
      if (panelIsOpen(panel) && isShown(panel)) {
        closePanel(panel);
        return true;
      }
    }
  }
  return false;
}

async function installBackButton(): Promise<void> {
  const listener = await onBackButtonPress(() => {
    if (closeTopOverlay()) return;
    if (terminalVisible()) {
      // 网页版的“+”就是回到连接页，会话保持不变
      document.getElementById('new-tab-btn')?.click();
      return;
    }
    void native.moveToBackground();
  });
  // 跳去 GitHub 登录页时交还默认行为（那边没有我们的脚本）
  window.addEventListener('pagehide', () => void listener.unregister(), { once: true });
}

// ---------- 后台保活 ----------

let lastReported = -1;
function syncKeepAlive(): void {
  const sessions = keepAliveEnabled() ? tabCount() : 0;
  if (sessions === lastReported) return;
  lastReported = sessions;
  native.keepAlive(sessions).catch((error: unknown) => console.warn('[cloudssh] keepAlive', error));
}

function installKeepAlive(): void {
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(syncKeepAlive, 300);
  };
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) new MutationObserver(schedule).observe(tabBar, { childList: true, subtree: true });
  window.addEventListener('cloudssh:keepalive-changed', schedule);
  schedule();
}

// ---------- 系统栏配色 ----------

let lastBarColor = '';
function syncSystemBars(): void {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  if (!match) return;
  const color = `#${match.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  if (color === lastBarColor) return;
  lastBarColor = color;
  native.systemBars(color).catch(() => undefined);
}

/** 网页版切换主题时改的是 html 上的 CSS 变量与 data-* 属性 */
function installSystemBars(): void {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(syncSystemBars);
  };
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true });
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  schedule();
}

// ---------- 提示 ----------

function reportLoginResult(): void {
  const params = new URLSearchParams(location.search);
  if (!params.has('login') && !params.has('login_error')) return;
  if (params.get('login') === 'ok') notify(mt('loginOk'), { variant: 'success', duration: 2000 });
  else notify(mt('loginFailed', { reason: params.get('login_error') ?? '' }), { variant: 'danger' });
  history.replaceState(null, '', location.pathname + location.hash);
}

function installDownloadNotices(): void {
  window.addEventListener('cloudssh:downloaded', (event) => {
    notify(mt('downloaded', { name: (event as CustomEvent<{ name: string }>).detail.name }), { variant: 'success' });
  });
  window.addEventListener('cloudssh:download-failed', (event) => {
    notify(mt('downloadFailed', { reason: String((event as CustomEvent).detail) }), { variant: 'danger' });
  });
}

// ---------- 语言 ----------

/** 语言按钮点开后用底部面板选择（当前语言打勾） */
const sheetLanguageMenu: LanguageMenu = (_anchor, choices, current, pick) =>
  showActions(
    t('language.label'),
    choices.map((choice) => ({
      label: choice.name,
      icon: choice.locale === current ? 'check_circle' : 'radio_button_unchecked',
      current: choice.locale === current,
      action: () => pick(choice.locale),
    })),
    mt('cancel')
  );

// ---------- 凭据预设 ----------

/** 密码和私钥用 Android Keystore 里的密钥加密后存在 localStorage；预设与服务器的关联按实例分开记 */
function installPresets(): void {
  let supported: Promise<boolean> | null = null;
  const vault = localVault({
    available: () => {
      supported ??= native
        .secretEncrypt('probe')
        .then(() => true)
        .catch(() => false);
      return supported;
    },
    encrypt: (text) => native.secretEncrypt(text),
    decrypt: (text) => native.secretDecrypt(text),
  });
  installCredentialPresets({ vault });
  native
    .state()
    .then((state) => configurePresets({ scope: `instance:${state.currentId}` }))
    .catch(() => undefined);
}

// ---------- 启动 ----------

// 内置终端字体与关键词高亮：要在网页版创建第一个终端之前装好
installTerminalEnhancements();

if (isTauri()) {
  installFetchObserver();
  // 打开就是完整的服务器列表（../shared/boot.ts）：节点页在下面同步装好，缓存读出来时已经在了
  attachBoot({ canShowEarly: () => true });
  // 打开着时跟上别处的改动：服务器列表、自定义主题、手机快捷键（../shared/live-sync.ts）
  installLiveSync({ mobileShortcuts: true });
  const start = () => {
    // 返回键最先注册：没注册上时系统会直接结束 Activity（原生层已兜底改为退到后台）。
    // 其余各项互不影响，某一项出错不能让后面的都装不上
    const steps: [string, () => void][] = [
      ['back button', () => void installBackButton().catch((error: unknown) => console.warn('[cloudssh] back button', error))],
      ['nodes', mountNodes],
      ['auth settings', mountAuthSettings],
      ['github login', installGithubLogin],
      ['tabs', mountTabs],
      ['skin', startSkin],
      ['language', () => installLanguagePicker(sheetLanguageMenu)],
      ['tag picker', installTagPicker],
      ['server form', installCompactServerForm],
      ['agent output', installAgentOutput],
      // 命令面板里按住片段的拖动手柄调整顺序（存在本地，不改 Worker）
      ['snippet sort', () => installSnippetSort({ touchHandles: true })],
      ['terminal touch', installTerminalTouch],
      // 键盘开合时普通屏幕的终端只整体上下移动，不重算行数、不让远端重画
      ['keyboard shift', installKeyboardShift],
      ['key repeat', installKeyRepeat],
      // 要排在 terminal touch 后面：缩放、拖选时它先把事件拦下
      ['alt scroll', installAltScroll],
      ['tap cursor', installTapCursor],
      ['keep alive', installKeepAlive],
      ['notifications', installMobileNotifications],
      // 页面里的提示条：顶部、紧凑、可滑走、底边进度条（./toasts.ts）
      ['toasts', installMobileToasts],
      ['credential presets', installPresets],
      ['system bars', installSystemBars],
      ['downloads', installDownloadNotices],
      ['login result', reportLoginResult],
    ];
    for (const [name, step] of steps) {
      try {
        step();
      } catch (error) {
        console.error(`[cloudssh] ${name}`, error);
      }
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
