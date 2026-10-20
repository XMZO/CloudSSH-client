/**
 * IPC 通道。两类调用方，各自只能用自己的通道：
 * - 实例页面（运行在 Worker origin 的网页 UI）：只读的桌面信息 + 打开实例管理
 * - 实例管理窗口（本地页面）：实例/偏好的增删改查
 * 每个 handler 都校验发送方，防止网页内容越权调用管理接口。
 */
import {
  CloudSSHApiClient,
  createInstanceId,
  normalizeWorkerUrl,
  type InstanceConfig,
  isSameInstanceOrigin,
} from '@cloudssh/core';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, net, shell } from 'electron';
import { configStore, type Preferences } from '../config/store';
import { createLogger, logFilePath } from '../logger';
import { listBundledUis } from '../ui/providers';
import { isManagerWebContents, notifyManager, openManagerWindow } from './manager-window';
import { refreshMenus } from './menus';
import { cliSettings, cliStatus, type CliSettingsPatch, installCli, setCliMcp, uninstallCli, updateCliSettings } from './cli-install';
import { applyCliSync } from './cli-sync';
import { probeOAuthRedirectUri } from './oauth';
import { versionLabel } from './version';
import { clearInstanceData } from './session';
import { applyGlobalShortcut, isAcceleratorText, shortcutStatus } from './shortcut';
import { getUpdater } from './updater';
import {
  applyMenuBarVisibility,
  closeInstanceWindows,
  hasCustomChrome,
  instanceIdOfWebContents,
  instanceWindows,
  markQuitting,
  openInstance,
  reloadInstance,
  showWindow,
  startLogin,
  TITLEBAR_HEIGHT,
} from './windows';

const log = createLogger('ipc');

function assertManager(event: IpcMainInvokeEvent): void {
  if (!isManagerWebContents(event.sender.id)) {
    throw new Error('Forbidden: not the instance manager');
  }
}

function senderInstance(event: IpcMainInvokeEvent): InstanceConfig {
  const id = instanceIdOfWebContents(event.sender.id);
  const instance = id ? configStore.getInstance(id) : undefined;
  const frameUrl = event.senderFrame?.url ?? '';
  if (!instance || !isSameInstanceOrigin(frameUrl, instance.baseUrl)) {
    throw new Error('Forbidden: sender is not an instance page');
  }
  return instance;
}

function managerState() {
  const openIds = new Set(
    instanceWindows()
      .map((window) => instanceIdOfWebContents(window.webContents.id))
      .filter(Boolean)
  );
  return {
    ...configStore.snapshot,
    openInstanceIds: [...openIds],
    bundledUis: listBundledUis().map(({ id, manifest }) => ({ id, manifest })),
    appVersion: app.getVersion(),
    appVersionLabel: versionLabel(),
    electronVersion: process.versions.electron,
    configPath: configStore.path,
    quickConnect: { status: shortcutStatus() },
  };
}

function broadcastChanged(): void {
  refreshMenus();
  notifyManager('manager:changed', managerState());
}

export function registerIpc(): void {
  // ---------- 实例页面 ----------
  ipcMain.handle('desktop:info', (event) => {
    const instance = senderInstance(event);
    return {
      platform: process.platform,
      appVersion: app.getVersion(),
      instance: { id: instance.id, name: instance.name, baseUrl: instance.baseUrl },
      customChrome: hasCustomChrome(BrowserWindow.fromWebContents(event.sender)),
      titleBarHeight: TITLEBAR_HEIGHT,
    };
  });
  // 自动更新（左下角版本号）：当前状态、手动检查、已下载好时确认后重启安装
  ipcMain.handle('desktop:update-status', (event) => {
    senderInstance(event);
    return getUpdater().status();
  });
  ipcMain.handle('desktop:update-check', (event) => {
    senderInstance(event);
    return getUpdater().check();
  });
  ipcMain.handle('desktop:update-install', async (event, confirmed: unknown) => {
    senderInstance(event);
    const status = getUpdater().status();
    if (status.state !== 'downloaded') return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    // 内置界面已经用自己的弹窗（跟随主题）问过了；跟随 Worker 的网页、旧界面仍由这里弹系统对话框确认
    if (!(confirmed === true && hasCustomChrome(window))) {
      const options = {
        type: 'question' as const,
        buttons: ['立即重启更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        // 普通按钮（Windows 默认把自定义按钮画成整行的命令链接，又宽又不像对话框）
        noLink: true,
        title: 'CloudSSH 更新',
        message: `重启并更新到 v${status.version}？`,
        detail: '所有窗口会关闭，打开的终端会话会断开。不着急的话，退出客户端时也会自动更新。',
      };
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (response !== 0) return false;
    }
    markQuitting();
    getUpdater().quitAndInstall();
    return true;
  });
  // 自绘标题栏：系统窗口按钮的配色跟随页面主题
  ipcMain.handle('desktop:titlebar', (event, colors: unknown) => {
    senderInstance(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !hasCustomChrome(window) || process.platform === 'darwin') return;
    const { color, symbolColor } = (colors ?? {}) as { color?: unknown; symbolColor?: unknown };
    const valid = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    if (!valid(color) || !valid(symbolColor)) return;
    window.setTitleBarOverlay({ color: color as string, symbolColor: symbolColor as string, height: TITLEBAR_HEIGHT });
  });
  // 自绘标题栏的应用菜单、实例菜单（页面里画，数据与动作在这里）
  ipcMain.handle('desktop:menu-state', (event) => {
    const current = senderInstance(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    return {
      instances: configStore.instances.map((instance) => ({
        id: instance.id,
        name: instance.name,
        host: new URL(instance.baseUrl).host,
      })),
      currentId: current.id,
      version: versionLabel(),
      fullscreen: window?.isFullScreen() ?? false,
    };
  });
  ipcMain.handle('desktop:command', async (event, command: unknown, argument: unknown) => {
    const instance = senderInstance(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof command !== 'string') return;
    const contents = window.webContents;
    const targetId = typeof argument === 'string' && configStore.getInstance(argument) ? argument : null;
    switch (command) {
      case 'switch-instance':
        if (targetId) await openInstance(targetId);
        break;
      case 'new-window':
        if (targetId) await openInstance(targetId, { newWindow: true });
        break;
      case 'login':
        await startLogin(instance.id, window);
        break;
      case 'manager':
        openManagerWindow();
        break;
      case 'cli-settings':
        openManagerWindow(undefined, 'cli');
        break;
      case 'reload':
        contents.reload();
        break;
      case 'force-reload':
        contents.reloadIgnoringCache();
        break;
      case 'devtools':
        contents.toggleDevTools();
        break;
      case 'zoom-reset':
        contents.setZoomLevel(0);
        break;
      case 'zoom-in':
        contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 9));
        break;
      case 'zoom-out':
        contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -8));
        break;
      case 'fullscreen':
        window.setFullScreen(!window.isFullScreen());
        break;
      case 'open-config':
        await shell.openPath(app.getPath('userData'));
        break;
      case 'open-logs':
        await shell.openPath(logFilePath());
        break;
      case 'quit':
        app.quit();
        break;
      default:
        log.warn('未知的菜单命令', command);
    }
  });
  ipcMain.handle('desktop:open-manager', (event, view?: unknown) => {
    senderInstance(event);
    openManagerWindow(undefined, view === 'cli' ? 'cli' : undefined);
  });
  // 点了系统通知：把发通知的窗口叫到前台（托盘里隐藏的、最小化的也恢复）
  ipcMain.handle('desktop:focus', (event) => {
    senderInstance(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) showWindow(window);
  });

  // ---------- 实例管理 ----------
  ipcMain.handle('manager:state', (event) => {
    assertManager(event);
    return managerState();
  });

  ipcMain.handle('manager:save-instance', async (event, input: Partial<InstanceConfig>) => {
    assertManager(event);
    const existing = input.id ? configStore.getInstance(input.id) : undefined;
    const id =
      existing?.id ??
      createInstanceId(
        String(input.name ?? '') || new URL(normalizeWorkerUrl(String(input.baseUrl ?? ''))).hostname,
        configStore.instances.map((item) => item.id)
      );
    const saved = configStore.upsertInstance({ ...input, id });
    if (existing) {
      if (existing.baseUrl !== saved.baseUrl) {
        // 地址变了：旧窗口的导航守卫绑定的是旧 origin，直接重建窗口
        const hadWindow = instanceWindows(saved.id).length > 0;
        closeInstanceWindows(saved.id);
        if (hadWindow) await openInstance(saved.id, { newWindow: true });
      } else if (JSON.stringify(existing.ui) !== JSON.stringify(saved.ui)) {
        reloadInstance(saved.id);
      }
    }
    log.info('保存实例', saved.id, saved.baseUrl, saved.ui.kind);
    broadcastChanged();
    return saved;
  });

  ipcMain.handle('manager:delete-instance', async (event, id: string, clearData: boolean) => {
    assertManager(event);
    const instance = configStore.getInstance(id);
    if (!instance) return;
    configStore.removeInstance(id);
    closeInstanceWindows(id);
    if (clearData) await clearInstanceData(instance);
    log.info('删除实例', id, clearData ? '（已清除数据）' : '');
    broadcastChanged();
  });

  ipcMain.handle('manager:set-default', (event, id: string) => {
    assertManager(event);
    configStore.setDefaultInstance(id);
    broadcastChanged();
  });

  ipcMain.handle('manager:open-instance', async (event, id: string, newWindow: boolean) => {
    assertManager(event);
    await openInstance(id, { newWindow });
    broadcastChanged();
  });

  ipcMain.handle('manager:login', async (event, id: string) => {
    assertManager(event);
    const window = instanceWindows(id)[0] ?? (await openInstance(id, { newWindow: true }));
    if (window) await startLogin(id, window);
  });

  ipcMain.handle('manager:clear-data', async (event, id: string) => {
    assertManager(event);
    const instance = configStore.getInstance(id);
    if (!instance) return;
    await clearInstanceData(instance);
    reloadInstance(id);
  });

  ipcMain.handle('manager:test-instance', async (event, baseUrl: string) => {
    assertManager(event);
    const started = Date.now();
    try {
      const client = new CloudSSHApiClient({
        baseUrl,
        transport: { fetch: (input, init) => net.fetch(input, { ...init, credentials: 'omit' }) },
      });
      const [config, health] = await Promise.all([client.getConfig(), client.health()]);
      const latencyMs = Date.now() - started;
      const oauthRedirectUri = config.githubAuthEnabled ? await probeOAuthRedirectUri(client.baseUrl) : null;
      return { ok: true, latencyMs, config, health, oauthRedirectUri };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: (error as Error).message };
    }
  });

  ipcMain.handle('manager:set-preferences', (event, patch: Partial<Preferences>) => {
    assertManager(event);
    const before = configStore.preferences;
    if (patch.quickConnectShortcut !== undefined && !isAcceleratorText(patch.quickConnectShortcut)) {
      throw new Error('快捷键无效');
    }
    const prefs = configStore.setPreferences(patch);
    applyMenuBarVisibility(prefs.showMenuBar);
    if (prefs.cliLoginSync !== before.cliLoginSync) applyCliSync(prefs.cliLoginSync);
    // 改了快捷键（或重新录了同一个，例如占用它的程序已退出）都重新注册
    if (patch.quickConnectShortcut !== undefined || prefs.quickConnectShortcut !== before.quickConnectShortcut) {
      applyGlobalShortcut(prefs.quickConnectShortcut);
    }
    broadcastChanged();
    return prefs;
  });

  // 录制新快捷键期间先注销旧的：系统全局快捷键会截走按键，管理窗口收不到
  ipcMain.handle('manager:shortcut-recording', (event, recording: unknown) => {
    assertManager(event);
    applyGlobalShortcut(recording === true ? '' : configStore.preferences.quickConnectShortcut);
    broadcastChanged();
  });

  ipcMain.handle('manager:pick-directory', async (event) => {
    assertManager(event);
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: '选择 UI 目录（需包含 index.html）',
      properties: ['openDirectory'],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('manager:open-path', async (event, kind: 'config' | 'logs') => {
    assertManager(event);
    if (kind === 'logs') shell.showItemInFolder(logFilePath());
    else await shell.openPath(app.getPath('userData'));
  });

  ipcMain.handle('manager:check-update', async (event) => {
    assertManager(event);
    return getUpdater().check();
  });

  // 命令行 cloudssh 与 Claude Code skill
  ipcMain.handle('manager:cli-status', (event) => {
    assertManager(event);
    return cliStatus();
  });
  ipcMain.handle('manager:cli-install', async (event) => {
    assertManager(event);
    const firstInstall = !(await cliStatus()).installed;
    const status = await installCli();
    // 第一次装命令行时顺带打开“同步登录给命令行”：客户端里登录过的实例，命令行与 AI 直接能用，不用再登录一次
    // （重新安装时不动：用户可能是特意关掉的）
    if (firstInstall && status.installed && !configStore.preferences.cliLoginSync) {
      configStore.setPreferences({ cliLoginSync: true });
      applyCliSync(true);
      broadcastChanged();
    }
    return status;
  });
  ipcMain.handle('manager:cli-uninstall', (event) => {
    assertManager(event);
    return uninstallCli();
  });
  ipcMain.handle('manager:cli-settings', (event) => {
    assertManager(event);
    return cliSettings();
  });
  ipcMain.handle('manager:cli-settings-set', (event, patch: CliSettingsPatch) => {
    assertManager(event);
    return updateCliSettings(patch && typeof patch === 'object' ? patch : {});
  });
  ipcMain.handle('manager:cli-mcp-set', (event, id: unknown, on: unknown) => {
    assertManager(event);
    return setCliMcp(String(id), on === true);
  });
}

export { broadcastChanged };
