/** 实例管理窗口：本地页面（file://），通过专用 preload 与主进程通信 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { preloadPath, resourcePath, showWindow } from './windows';

let managerWindow: BrowserWindow | null = null;

export function isManagerWebContents(id: number): boolean {
  return !!managerWindow && !managerWindow.isDestroyed() && managerWindow.webContents.id === id;
}

export function openManagerWindow(parent?: BrowserWindow): BrowserWindow {
  if (managerWindow && !managerWindow.isDestroyed()) {
    showWindow(managerWindow);
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
    backgroundColor: '#131313',
    autoHideMenuBar: true,
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
  void managerWindow.loadFile(path.join(app.getAppPath(), 'dist', 'manager', 'index.html'));
  return managerWindow;
}

/** 配置变化后通知管理页刷新 */
export function notifyManager(channel: string, payload?: unknown): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.webContents.send(channel, payload);
  }
}
