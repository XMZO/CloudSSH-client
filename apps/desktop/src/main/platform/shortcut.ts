/**
 * 平台适配层：快速连接的系统全局快捷键。
 *
 * 在任何程序里按下（默认 Ctrl+Alt+T，可在实例管理里改成别的组合或关闭），把最近使用的实例窗口叫到前台
 * （托盘里隐藏的、最小化的也会恢复）并打开页面里的命令面板；窗口本来就在前台时再按一次关闭面板。
 * 没有打开的窗口时先打开默认实例，页面装好命令面板后再打开（desktop:palette-pending）。
 * 组合键被别的程序占用时注册失败，实例管理的偏好设置里会提示。
 */
import { app, type BrowserWindow, globalShortcut, ipcMain } from 'electron';
import { configStore } from '../config/store';
import { createLogger } from '../logger';
import { instanceIdOfWebContents, instanceWindows, openInstance, showWindow } from './windows';

const log = createLogger('shortcut');

/** off = 未设置；taken = 被其他程序占用；invalid = 组合键无效 */
export type ShortcutStatus = 'off' | 'on' | 'taken' | 'invalid';

let status: ShortcutStatus = 'off';
let registered: string | null = null;
let lastFocused: BrowserWindow | null = null;
/** 等页面装好命令面板后再打开（新开的窗口） */
const pending = new Set<number>();

export function shortcutStatus(): ShortcutStatus {
  return status;
}

/** Electron 加速键字符串是否像样（偏好里存的值来自管理窗口的录制，这里再兜一层） */
export function isAcceleratorText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 48 && /^[A-Za-z0-9+`\-=[\];',./\\]*$/.test(value);
}

function targetWindow(): BrowserWindow | null {
  if (lastFocused && !lastFocused.isDestroyed() && instanceIdOfWebContents(lastFocused.webContents.id)) return lastFocused;
  return instanceWindows()[0] ?? null;
}

async function summon(): Promise<void> {
  let window = targetWindow();
  const wasForeground = !!window && window.isVisible() && !window.isMinimized() && window.isFocused();
  if (!window) {
    window = await openInstance(configStore.defaultInstanceId, { newWindow: true });
    if (!window) return;
    pending.add(window.webContents.id);
    return;
  }
  showWindow(window);
  // Windows 的前台锁可能不让后台程序直接抢到前台（只在任务栏闪烁）：临时置顶一下再取消，通常就能到最前并拿到焦点
  if (process.platform === 'win32' && !window.isFocused()) {
    window.setAlwaysOnTop(true);
    window.focus();
    window.setAlwaysOnTop(false);
  }
  window.webContents.send('desktop:palette', wasForeground);
}

/** 按偏好注册（空串表示关闭）；返回注册结果 */
export function applyGlobalShortcut(accelerator: string): ShortcutStatus {
  if (registered) {
    globalShortcut.unregister(registered);
    registered = null;
  }
  if (!accelerator) {
    status = 'off';
    return status;
  }
  try {
    if (globalShortcut.register(accelerator, () => void summon())) {
      registered = accelerator;
      status = 'on';
    } else {
      status = 'taken';
      log.warn('全局快捷键已被其他程序占用', accelerator);
    }
  } catch (error) {
    status = 'invalid';
    log.warn('全局快捷键无效', accelerator, (error as Error).message);
  }
  return status;
}

export function installGlobalShortcut(): void {
  app.on('browser-window-focus', (_event, window) => {
    if (instanceIdOfWebContents(window.webContents.id)) lastFocused = window;
  });
  // 页面注册命令面板时问一下：是不是被全局快捷键打开的新窗口
  ipcMain.handle('desktop:palette-pending', (event) => pending.delete(event.sender.id));
  applyGlobalShortcut(configStore.preferences.quickConnectShortcut);
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
