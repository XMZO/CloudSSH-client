/**
 * 桌面端界面主题的状态：
 * - 主题：工作台（为桌面重新设计）或经典（网页版原样），保存在本地，切换时不重载页面（会话保持）
 * - 当前视图：登录页 / 服务器列表 / 终端，写到 <html> 上给样式用（cs-view-auth / cs-view-home / cs-view-term）
 * - 窗口环境：是否由界面自己画标题栏（无系统边框），来自桌面桥接
 */
export type DesktopSkin = 'workbench' | 'classic';

const SKIN_KEY = 'cloudssh_desktop_skin';
export const SKIN_CHANGED_EVENT = 'cloudssh:desktop-skin';
export const VIEW_CHANGED_EVENT = 'cloudssh:desktop-view';

export function desktopSkin(): DesktopSkin {
  try {
    return localStorage.getItem(SKIN_KEY) === 'classic' ? 'classic' : 'workbench';
  } catch {
    return 'workbench';
  }
}

export function setDesktopSkin(skin: DesktopSkin): void {
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    // 忽略
  }
  document.documentElement.dataset.csDesk = skin;
  window.dispatchEvent(new Event(SKIN_CHANGED_EVENT));
}

export type DesktopView = 'auth' | 'home' | 'term';

function shown(id: string): boolean {
  const node = document.getElementById(id);
  return !!node && !node.classList.contains('hidden');
}

export function currentView(): DesktopView {
  if (shown('terminal-section')) return 'term';
  if (shown('user-space-section')) return 'home';
  return 'auth';
}

/** 跟踪网页版三个页面的切换，写到 <html> 上并派发事件 */
export function trackView(): void {
  let last: DesktopView | null = null;
  const sync = () => {
    const view = currentView();
    if (view === last) return;
    last = view;
    const html = document.documentElement;
    for (const name of ['auth', 'home', 'term'] as const) html.classList.toggle(`cs-view-${name}`, view === name);
    window.dispatchEvent(new Event(VIEW_CHANGED_EVENT));
  };
  const observer = new MutationObserver(sync);
  for (const id of ['auth-section', 'user-space-section', 'terminal-section']) {
    const node = document.getElementById(id);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  sync();
}

/** 点击网页版里隐藏起来的按钮（按 id），返回是否找到 */
export function clickById(id: string): boolean {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) return false;
  node.click();
  return true;
}
