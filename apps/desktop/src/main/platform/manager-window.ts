/**
 * 实例管理窗口：本地页面（file://），通过专用 preload 与主进程通信。
 * 与实例窗口一样去掉系统边框、由页面画标题栏（Windows / Linux 保留系统窗口按钮，颜色跟随系统深浅色）
 */
import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import { preloadPath, resourcePath, showWindow } from './windows';

let managerWindow: BrowserWindow | null = null;

/** 与 manager/style.css 的标题栏一致（--surface / --text） */
function titleBarOverlay(): Electron.TitleBarOverlay {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#161a22', symbolColor: '#e6edf3', height: 40 }
    : { color: '#ffffff', symbolColor: '#1f2328', height: 40 };
}

nativeTheme.on('updated', () => {
  if (!managerWindow || managerWindow.isDestroyed()) return;
  managerWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f8fa');
  if (process.platform !== 'darwin') managerWindow.setTitleBarOverlay(titleBarOverlay());
});

export function isManagerWebContents(id: number): boolean {
  return !!managerWindow && !managerWindow.isDestroyed() && managerWindow.webContents.id === id;
}

/** view 为 cli 时直接打开“命令行与 Skill”设置页 */
export function openManagerWindow(parent?: BrowserWindow, view?: 'cli'): BrowserWindow {
  if (managerWindow && !managerWindow.isDestroyed()) {
    showWindow(managerWindow);
    if (view) managerWindow.webContents.send('manager:show-view', view);
    return managerWindow;
  }
  managerWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    parent,
    show: false,
    title: 'CloudSSH 实例管理',
    icon: resourcePath('icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f8fa',
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: preloadPath('manager'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  managerWindow.setMenuBarVisibility(false);
  managerWindow.once('ready-to-show', () => managerWindow?.show());
  managerWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  managerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  managerWindow.on('closed', () => {
    managerWindow = null;
  });
  void managerWindow.loadFile(path.join(app.getAppPath(), 'dist', 'manager', 'index.html'), view ? { hash: view } : undefined);
  return managerWindow;
}

/** 配置变化后通知管理页刷新 */
export function notifyManager(channel: string, payload?: unknown): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send(channel, payload);
  }
}
