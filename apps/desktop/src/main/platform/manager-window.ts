/**
 * 实例管理窗口：本地页面（file://），通过专用 preload 与主进程通信。
 * 与实例窗口一样去掉系统边框、由页面画标题栏（Windows / Linux 保留系统窗口按钮）。
 * 配色跟随实例页面的主题（./ui-palette.ts）；还没有实例页面报过配色时跟随系统深浅色
 */
import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import { currentPalette, type UiPalette } from './ui-palette';
import { preloadPath, resourcePath, showWindow } from './windows';

let managerWindow: BrowserWindow | null = null;

/** 与 manager/style.css 的 --tb-height 一致 */
const TITLEBAR_HEIGHT = 36;

/** 窗口底色与标题栏（与 manager/style.css 的 --bg / --surface / --text 一致） */
function colors(): { background: string; bar: string; symbol: string } {
  const palette = currentPalette();
  if (palette) return { background: palette.bg, bar: palette.surface, symbol: palette.text };
  return nativeTheme.shouldUseDarkColors
    ? { background: '#0f1115', bar: '#161a22', symbol: '#e6edf3' }
    : { background: '#f6f8fa', bar: '#ffffff', symbol: '#1f2328' };
}

function titleBarOverlay(): Electron.TitleBarOverlay {
  const { bar, symbol } = colors();
  return { color: bar, symbolColor: symbol, height: TITLEBAR_HEIGHT };
}

function repaint(): void {
  if (!managerWindow || managerWindow.isDestroyed()) return;
  managerWindow.setBackgroundColor(colors().background);
  if (process.platform !== 'darwin') managerWindow.setTitleBarOverlay(titleBarOverlay());
}

nativeTheme.on('updated', () => {
  if (!currentPalette()) repaint();
});

/** 实例页面换了主题：实例管理窗口立即换上 */
export function applyManagerPalette(palette: UiPalette): void {
  repaint();
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send('manager:palette', palette);
}

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
    width: 760,
    height: 560,
    minWidth: 660,
    minHeight: 480,
    parent,
    show: false,
    title: 'CloudSSH 实例管理',
    icon: resourcePath('icon.png'),
    backgroundColor: colors().background,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 11 } }
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
