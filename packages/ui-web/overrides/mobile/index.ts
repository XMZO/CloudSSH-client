/**
 * 移动端界面功能（在网页版之后执行）：
 * - 节点分组首页（nodes.ts）与设置面板（settings.ts）
 * - 返回键：关闭最上层浮层 → 终端回到节点页 → 退到后台（保持会话）
 * - 后台保活：有会话时让 Android 前台服务保持连接
 * - 登录结果、下载结果提示
 */
import { onBackButtonPress } from '@tauri-apps/api/app';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import '../desktop.css';
import { tabCount, terminalVisible } from '../sidebar/hooks';
import { installFetchObserver } from '../sidebar/store';
import { mt } from './i18n';
import './mobile.css';
import { mountNodes } from './nodes';
import { closePanel, panelIsOpen } from './skin/panels';
import { startSkin } from './skin';
import { keepAliveEnabled } from './settings';
import { closeSheet, isSheetOpen } from './sheet';
import { mountTabs } from './tabs';
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

// ---------- 启动 ----------

if (isTauri()) {
  installFetchObserver();
  const start = () => {
    mountNodes();
    mountTabs();
    startSkin();
    installKeepAlive();
    installSystemBars();
    installDownloadNotices();
    reportLoginResult();
    void installBackButton().catch((error: unknown) => console.warn('[cloudssh] back button', error));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
