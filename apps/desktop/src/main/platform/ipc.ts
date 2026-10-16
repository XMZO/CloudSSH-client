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
import { probeOAuthRedirectUri } from './oauth';
import { clearInstanceData } from './session';
import { getUpdater } from './updater';
import {
  applyMenuBarVisibility,
  closeInstanceWindows,
  instanceIdOfWebContents,
  instanceWindows,
  openInstance,
  reloadInstance,
  startLogin,
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
    electronVersion: process.versions.electron,
    configPath: configStore.path,
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
    };
  });
  ipcMain.handle('desktop:open-manager', (event) => {
    senderInstance(event);
    openManagerWindow();
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
    const prefs = configStore.setPreferences(patch);
    applyMenuBarVisibility(prefs.showMenuBar);
    broadcastChanged();
    return prefs;
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
}

export { broadcastChanged };
