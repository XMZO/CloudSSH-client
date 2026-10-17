/**
 * 平台适配层：实例窗口管理。
 *
 * - 每个窗口绑定一个实例（会话分区在窗口创建时确定，切换实例 = 换窗口）
 * - 导航守卫：主窗口只停留在 Worker origin；点“使用 GitHub 登录”改走独立登录窗口；外链交给系统浏览器
 */
import {
  type InstanceConfig,
  isGitHubLoginStart,
  isSameInstanceOrigin,
  originOf,
} from '@cloudssh/core';
import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron';
import path from 'node:path';
import { configStore, type WindowState } from '../config/store';
import { createLogger } from '../logger';
import type { ResolvedUi } from '../ui/providers';
import { loginWithGitHub } from './oauth';
import { prepareInstanceSession } from './session';

const log = createLogger('window');

interface WindowEntry {
  window: BrowserWindow;
  instanceId: string;
  /** 界面自己画标题栏（窗口没有系统边框） */
  customChrome: boolean;
}

/** 自绘标题栏的高度（与 overrides/desktop/titlebar.css 的 --cs-tb-height 一致） */
export const TITLEBAR_HEIGHT = 40;

const entries = new Map<number, WindowEntry>();
let quitting = false;
let openManagerHandler: (() => void) | null = null;

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

export function setOpenManagerHandler(handler: () => void): void {
  openManagerHandler = handler;
}

export function resourcePath(...segments: string[]): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...segments)
    : path.join(app.getAppPath(), 'resources', ...segments);
}

export function preloadPath(name: string): string {
  return path.join(app.getAppPath(), 'dist', 'preload', `${name}.cjs`);
}

export function instanceWindows(instanceId?: string): BrowserWindow[] {
  return [...entries.values()]
    .filter((entry) => !entry.window.isDestroyed() && (!instanceId || entry.instanceId === instanceId))
    .map((entry) => entry.window);
}

/** 窗口是否由界面自己画标题栏 */
export function hasCustomChrome(window: BrowserWindow | null | undefined): boolean {
  return window ? entries.get(window.id)?.customChrome === true : false;
}

/**
 * 内置界面（本仓库的 ui-web 桌面构建，或开发服务器）自己画标题栏：去掉系统边框，窗口按钮由系统画在
 * 标题栏右侧（Windows 11 的贴靠布局照常可用）。跟随 Worker 的网页没有标题栏，保留系统边框。
 */
function usesCustomChrome(ui: ResolvedUi): boolean {
  if (ui.kind === 'proxy') return true;
  return ui.kind === 'static' && (ui.manifest?.desktopChrome ?? 0) >= 1;
}

function chromeOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } };
  }
  // 颜色先按深色给，页面加载后按当前主题改（desktop:titlebar）
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#131313', symbolColor: '#e5e2e1', height: TITLEBAR_HEIGHT } };
}

export function instanceIdOf(window: BrowserWindow | null | undefined): string | undefined {
  return window ? entries.get(window.id)?.instanceId : undefined;
}

/** 根据 webContents 找到所属实例（IPC 发送方校验用） */
export function instanceIdOfWebContents(webContentsId: number): string | undefined {
  for (const entry of entries.values()) {
    if (!entry.window.isDestroyed() && entry.window.webContents.id === webContentsId) return entry.instanceId;
  }
  return undefined;
}

export function focusedInstanceWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && entries.has(focused.id)) return focused;
  return instanceWindows()[0];
}

function visibleBounds(state: WindowState): Partial<Electron.Rectangle> {
  if (state.x === undefined || state.y === undefined) return { width: state.width, height: state.height };
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height };
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    return (
      rect.x < workArea.x + workArea.width - 64 &&
      rect.x + rect.width > workArea.x + 64 &&
      rect.y >= workArea.y - 8 &&
      rect.y < workArea.y + workArea.height - 64
    );
  });
  return visible ? rect : { width: state.width, height: state.height };
}

function rememberBounds(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized()) return;
  const maximized = window.isMaximized();
  const bounds = maximized ? configStore.windowState : window.getBounds();
  configStore.setWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized,
  });
}

/**
 * 打开实例。默认替换当前聚焦的实例窗口；newWindow=true 时另开窗口。
 * 已有该实例窗口时直接聚焦。
 */
export async function openInstance(
  instanceId: string,
  options: { newWindow?: boolean } = {}
): Promise<BrowserWindow | null> {
  const instance = configStore.getInstance(instanceId);
  if (!instance) {
    log.warn('实例不存在', instanceId);
    return null;
  }
  const existing = instanceWindows(instanceId)[0];
  if (existing && !options.newWindow) {
    showWindow(existing);
    return existing;
  }
  let replace = options.newWindow ? undefined : focusedInstanceWindow();
  if (replace) {
    // 切换实例会销毁当前窗口里的终端/SFTP 会话，先确认
    const { response } = await dialog.showMessageBox(replace, {
      type: 'question',
      title: '切换实例',
      message: `切换到「${instance.name}」？`,
      detail: '当前窗口中的终端与 SFTP 会话将被关闭。也可以在新窗口中打开，保留当前会话。',
      buttons: ['切换', '新窗口打开', '取消'],
      defaultId: 1,
      cancelId: 2,
    });
    if (response === 2) return null;
    if (response === 1) replace = undefined;
  }
  const window = createInstanceWindow(instance, replace);
  if (replace && !replace.isDestroyed()) {
    // 先建新窗口再关旧窗口，避免触发“所有窗口关闭 → 退出”
    entries.delete(replace.id);
    replace.destroy();
  }
  return window;
}

export function showWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function windowTitle(instance: InstanceConfig, pageTitle?: string): string {
  const host = new URL(instance.baseUrl).host;
  const base = pageTitle && pageTitle !== 'CloudSSH' ? `${pageTitle} — CloudSSH` : 'CloudSSH';
  return `${base} · ${instance.name}（${host}）`;
}

function createInstanceWindow(instance: InstanceConfig, replace?: BrowserWindow): BrowserWindow {
  const prepared = prepareInstanceSession(instance);
  const state = configStore.windowState;
  const bounds = replace && !replace.isDestroyed() ? replace.getBounds() : visibleBounds(state);
  const customChrome = usesCustomChrome(prepared.ui);

  const window = new BrowserWindow({
    ...bounds,
    ...(customChrome ? chromeOptions() : {}),
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: windowTitle(instance),
    icon: resourcePath('icon.png'),
    backgroundColor: '#131313',
    autoHideMenuBar: false,
    webPreferences: {
      session: prepared.session,
      preload: preloadPath('app'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      // 窗口最小化/被遮挡时不节流定时器：终端输出 ACK（16ms 合并）、心跳与断线恢复都靠定时器，
      // 被长时间节流可能触发服务端 60s 无 ACK 断开（output_backlog_closed）
      backgroundThrottling: false,
    },
  });
  // 自绘标题栏时菜单收进标题栏左侧的菜单按钮（desktop:app-menu），不显示系统菜单栏
  window.setMenuBarVisibility(!customChrome && configStore.preferences.showMenuBar);
  entries.set(window.id, { window, instanceId: instance.id, customChrome });

  if ((replace && replace.isMaximized()) || (!replace && state.maximized)) window.maximize();
  window.once('ready-to-show', () => window.show());

  const origin = originOf(instance.baseUrl)!;
  const contents = window.webContents;

  window.on('page-title-updated', (event, title) => {
    event.preventDefault();
    window.setTitle(windowTitle(instance, title));
  });

  // ---------- 导航守卫 ----------
  contents.on('will-navigate', (event, url) => {
    if (isGitHubLoginStart(url, origin)) {
      event.preventDefault();
      void startLogin(instance.id, window);
      return;
    }
    if (isSameInstanceOrigin(url, origin)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isSameInstanceOrigin(url, origin)) {
      event.preventDefault();
      log.warn('阻止主窗口跳转到外部地址', url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());

  // 输入框/选中文本的右键编辑菜单（网页自己处理了 contextmenu 时不会触发）
  contents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
        { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { role: 'selectAll', label: '全选' }
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy', label: '复制' });
    }
    if (params.linkURL && /^https?:/i.test(params.linkURL)) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: '在浏览器中打开链接', click: () => openExternal(params.linkURL) });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });

  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log.error('页面加载失败', code, description, url);
    void dialog
      .showMessageBox(window, {
        type: 'error',
        title: '无法打开实例',
        message: `无法加载 ${instance.name}`,
        detail: `${url}\n${description}（${code}）\n\n请检查网络或 Worker 地址。`,
        buttons: ['重试', '实例管理', '关闭'],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (window.isDestroyed()) return;
        if (response === 0) void window.loadURL(`${origin}/`);
        if (response === 1) openManagerHandler?.();
      });
  });

  contents.on('render-process-gone', (_event, details) => {
    log.error('渲染进程退出', details.reason, details.exitCode);
  });

  // ---------- 窗口状态 ----------
  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => rememberBounds(window), 500);
  };
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);

  window.on('close', (event) => {
    rememberBounds(window);
    if (!quitting && configStore.preferences.closeToTray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    clearTimeout(saveTimer);
    entries.delete(window.id);
  });

  if (prepared.warning) {
    void dialog.showMessageBox(window, { type: 'warning', title: 'UI 来源', message: prepared.warning });
  }

  log.info('打开实例', instance.id, origin, 'UI =', prepared.ui.label);
  void window.loadURL(`${origin}/`);
  return window;
}

export async function startLogin(instanceId: string, parent?: BrowserWindow): Promise<void> {
  const instance = configStore.getInstance(instanceId);
  if (!instance) return;
  const ok = await loginWithGitHub(instance, parent);
  // 成功：带着新 Cookie 重新加载；取消：也重新加载，复位网页里“正在跳转”的状态
  for (const window of instanceWindows(instanceId)) {
    void window.loadURL(`${originOf(instance.baseUrl)}/`);
  }
  if (ok) log.info('登录完成，已刷新实例窗口', instanceId);
}

/** 重新加载某实例的全部窗口（UI 来源变更后调用：会重新挂载 bridge） */
export function reloadInstance(instanceId: string): void {
  const instance = configStore.getInstance(instanceId);
  if (!instance) return;
  const windows = instanceWindows(instanceId);
  if (!windows.length) return;
  const { ui } = prepareInstanceSession(instance);
  const customChrome = usesCustomChrome(ui);
  for (const window of windows) {
    if (hasCustomChrome(window) === customChrome) {
      void window.loadURL(`${originOf(instance.baseUrl)}/`);
      continue;
    }
    // 有没有系统边框只能在建窗口时决定：内置界面与“跟随 Worker”之间切换时换一个新窗口（位置、大小不变）
    createInstanceWindow(instance, window);
    entries.delete(window.id);
    window.destroy();
  }
}

/** 关闭某实例的全部窗口（删除实例或修改地址时） */
export function closeInstanceWindows(instanceId: string): void {
  for (const window of instanceWindows(instanceId)) {
    entries.delete(window.id);
    window.destroy();
  }
}

export function applyMenuBarVisibility(visible: boolean): void {
  for (const window of instanceWindows()) window.setMenuBarVisibility(visible && !hasCustomChrome(window));
}

export function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  } else {
    log.warn('忽略非 http(s) 外部链接', url);
  }
}
