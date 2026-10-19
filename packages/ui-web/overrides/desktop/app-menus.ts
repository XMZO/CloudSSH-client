/**
 * 标题栏左上角的两个菜单（页面里画，不用系统原生菜单）：
 * - 应用菜单（Logo）：视图（重新加载、开发者工具、缩放、全屏）、实例管理、配置目录与日志、版本、退出
 * - 实例菜单（实例名）：切换实例（行尾按钮在新窗口打开）、GitHub 登录、实例管理
 * 数据与动作由主进程提供（desktop:menu-state / desktop:command）；快捷键仍由隐藏的应用菜单负责。
 */
import { dt } from './i18n';
import { closeMenu, isMenuOpen, showMenu, type MenuItem } from './menu';

let openFor: HTMLElement | null = null;
/** 菜单开着时再点它的按钮：按下时菜单已因“点了外面”关掉，随后的 click 不能再把它打开。
 *  window 上的捕获监听最先执行，在那里记下按下前菜单是不是这个按钮的 */
let pressedWhileOpen: HTMLElement | null = null;
window.addEventListener(
  'pointerdown',
  (event) => {
    pressedWhileOpen = isMenuOpen() && openFor?.contains(event.target as Node) ? openFor : null;
  },
  true
);

function toggle(anchor: HTMLElement, build: (state: CloudSSHDesktopMenuState) => MenuItem[]): void {
  const bridge = window.cloudsshDesktop;
  if (!bridge?.menuState) return;
  if (pressedWhileOpen === anchor || (isMenuOpen() && openFor === anchor)) {
    pressedWhileOpen = null;
    closeMenu();
    openFor = null;
    return;
  }
  void bridge.menuState().then((state) => {
    const rect = anchor.getBoundingClientRect();
    showMenu(rect.left, rect.bottom + 4, build(state), () => {
      if (openFor === anchor) openFor = null;
    });
    openFor = anchor;
  });
}

const run = (command: string, argument?: string) => () => void window.cloudsshDesktop?.command?.(command, argument);

function shortcut(keys: string, mac: boolean): string {
  return mac ? keys.replace('Ctrl+', '⌘').replace('Shift+', '⇧') : keys;
}

export function toggleAppMenu(anchor: HTMLElement, mac: boolean): void {
  toggle(anchor, (state) => [
    { label: dt('menuReload'), icon: 'refresh', shortcut: shortcut('Ctrl+Shift+R', mac), action: run('reload') },
    { label: dt('menuForceReload'), icon: 'sync', action: run('force-reload') },
    { label: dt('menuDevtools'), icon: 'code', shortcut: shortcut('Ctrl+Shift+I', mac), action: run('devtools') },
    { label: dt('menuZoomReset'), icon: 'fit_screen', shortcut: shortcut('Ctrl+0', mac), separated: true, action: run('zoom-reset') },
    { label: dt('menuZoomIn'), icon: 'zoom_in', shortcut: shortcut('Ctrl+=', mac), action: run('zoom-in') },
    { label: dt('menuZoomOut'), icon: 'zoom_out', shortcut: shortcut('Ctrl+-', mac), action: run('zoom-out') },
    {
      label: state.fullscreen ? dt('menuExitFullscreen') : dt('menuFullscreen'),
      icon: state.fullscreen ? 'fullscreen_exit' : 'fullscreen',
      shortcut: 'F11',
      action: run('fullscreen'),
    },
    { label: dt('instanceManager'), icon: 'dns', shortcut: shortcut('Ctrl+Shift+M', mac), separated: true, action: run('manager') },
    { label: dt('cliSkill'), icon: 'terminal', action: run('cli-settings') },
    { label: dt('menuConfigDir'), icon: 'folder_open', action: run('open-config') },
    { label: dt('menuLogs'), icon: 'description', action: run('open-logs') },
    { label: state.version, icon: 'info', separated: true, disabled: true },
    { label: dt('menuQuit'), icon: 'logout', action: run('quit') },
  ]);
}

export function toggleInstanceMenu(anchor: HTMLElement, mac: boolean): void {
  toggle(anchor, (state) => [
    ...state.instances.map(
      (instance): MenuItem => ({
        label: instance.name,
        detail: instance.host,
        checked: instance.id === state.currentId,
        action: instance.id === state.currentId ? undefined : run('switch-instance', instance.id),
        trailing: { icon: 'open_in_new', label: dt('menuNewWindow'), action: run('new-window', instance.id) },
      })
    ),
    { label: dt('menuLogin'), icon: 'login', separated: true, action: run('login') },
    { label: dt('instanceManager'), icon: 'dns', shortcut: shortcut('Ctrl+Shift+M', mac), action: run('manager') },
  ]);
}
