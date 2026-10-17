/**
 * 平台适配层：应用菜单与托盘。
 *
 * 快捷键刻意避开终端常用键（Ctrl+R/W/F5 等）：Electron 只在网页没处理该按键时才触发菜单快捷键，
 * 而 xterm 会吃掉它处理的按键，所以这里的组合（Ctrl+Shift+…、F11）不会和终端程序冲突。
 * 菜单栏默认隐藏（避免单按 Alt 抢走终端焦点），可在实例管理里打开。
 */
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import { configStore } from '../config/store';
import { logFilePath } from '../logger';
import { openManagerWindow } from './manager-window';
import { versionLabel } from './version';
import {
  focusedInstanceWindow,
  instanceIdOf,
  instanceWindows,
  openInstance,
  resourcePath,
  showWindow,
  startLogin,
} from './windows';

let tray: Tray | null = null;

function instanceSwitchItems(newWindow: boolean): Electron.MenuItemConstructorOptions[] {
  const activeId = instanceIdOf(focusedInstanceWindow());
  return configStore.instances.map((instance) => ({
    label: `${instance.name}  (${new URL(instance.baseUrl).host})`,
    type: newWindow ? 'normal' : 'radio',
    checked: !newWindow && instance.id === activeId,
    click: () => void openInstance(instance.id, { newWindow }),
  }));
}

function withFocused(action: (window: BrowserWindow) => void): () => void {
  return () => {
    const window = focusedInstanceWindow();
    if (window) action(window);
  };
}

export function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '实例',
      submenu: [
        { label: '切换实例', submenu: instanceSwitchItems(false) },
        { label: '在新窗口打开', submenu: instanceSwitchItems(true) },
        { type: 'separator' },
        {
          label: '使用 GitHub 登录…',
          click: withFocused((window) => {
            const id = instanceIdOf(window);
            if (id) void startLogin(id, window);
          }),
        },
        { label: '实例管理…', accelerator: 'CmdOrCtrl+Shift+M', click: () => openManagerWindow() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    ...(process.platform === 'darwin' ? [{ role: 'editMenu' as const }] : []),
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: withFocused((w) => w.webContents.reload()) },
        { label: '强制重新加载', click: withFocused((w) => w.webContents.reloadIgnoringCache()) },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: withFocused((w) => w.webContents.toggleDevTools()) },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开配置目录', click: () => void shell.openPath(app.getPath('userData')) },
        { label: '打开日志', click: () => void shell.openPath(logFilePath()) },
        { type: 'separator' },
        { label: `CloudSSH 桌面客户端 ${versionLabel()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(resourcePath('tray.png'));
  const hidpi = nativeImage.createFromPath(resourcePath('tray@2x.png'));
  if (!hidpi.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: hidpi.toPNG() });
  return image;
}

export function buildTray(): void {
  if (!tray) {
    tray = new Tray(trayImage());
    tray.setToolTip('CloudSSH');
    tray.on('click', () => {
      const windows = instanceWindows();
      if (windows.length === 0) {
        void openInstance(configStore.defaultInstanceId);
        return;
      }
      const target = focusedInstanceWindow() ?? windows[0];
      if (target.isVisible() && target.isFocused()) target.hide();
      else showWindow(target);
    });
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => {
          const windows = instanceWindows();
          if (windows.length) windows.forEach(showWindow);
          else void openInstance(configStore.defaultInstanceId);
        },
      },
      { label: '切换实例', submenu: instanceSwitchItems(false) },
      { label: '在新窗口打开', submenu: instanceSwitchItems(true) },
      { label: '实例管理…', click: () => openManagerWindow() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

/** 自绘标题栏左侧的菜单按钮：弹出应用菜单（与系统菜单栏同一份） */
export function popupAppMenu(window: BrowserWindow, x: number, y: number): void {
  Menu.getApplicationMenu()?.popup({ window, x: Math.round(x), y: Math.round(y) });
}

/** 自绘标题栏上的实例名：切换实例、在新窗口打开、登录、实例管理 */
export function popupInstanceMenu(window: BrowserWindow, x: number, y: number): void {
  Menu.buildFromTemplate([
    ...instanceSwitchItems(false),
    { type: 'separator' },
    { label: '在新窗口打开', submenu: instanceSwitchItems(true) },
    {
      label: '使用 GitHub 登录…',
      click: () => {
        const id = instanceIdOf(window);
        if (id) void startLogin(id, window);
      },
    },
    { label: '实例管理…', accelerator: 'CmdOrCtrl+Shift+M', click: () => openManagerWindow() },
  ]).popup({ window, x: Math.round(x), y: Math.round(y) });
}

/** 实例列表或焦点变化时刷新菜单里的实例项 */
export function refreshMenus(): void {
  buildAppMenu();
  buildTray();
}
