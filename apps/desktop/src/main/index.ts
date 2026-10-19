/**
 * CloudSSH 桌面客户端主进程入口：装配各层。
 *
 *   连接与配置层  config/store.ts（实例、偏好、窗口状态）+ @cloudssh/core（URL/路由/OAuth 规则）
 *   平台适配层    platform/*（窗口、托盘、菜单、会话分区、origin bridge、登录、IPC、更新预留）
 *   UI 层         ui/providers.ts 解析 UI 来源；UI 本身是任意静态站点（默认 packages/ui-web）
 *
 * 命令行参数：--instance=<id> 启动时打开指定实例
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { configStore } from './config/store';
import { createLogger } from './logger';
import { refreshCliInstall } from './platform/cli-install';
import { applyCliSync } from './platform/cli-sync';
import { registerDragOutIpc } from './platform/drag-out';
import { registerIpc } from './platform/ipc';
import { openManagerWindow } from './platform/manager-window';
import { buildAppMenu, buildTray, refreshMenus } from './platform/menus';
import { installGlobalShortcut } from './platform/shortcut';
import { startUpdates } from './platform/updater';
import { registerVaultIpc } from './platform/vault';
import { versionLabel } from './platform/version';
import {
  instanceWindows,
  markQuitting,
  openInstance,
  setOpenManagerHandler,
  showWindow,
} from './platform/windows';

const log = createLogger('main');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.xmzo.cloudssh');
}

// 独立配置目录（调试/测试用）：与正在运行的客户端互不影响，单实例锁也按此目录区分
if (process.env.CLOUDSSH_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.CLOUDSSH_USER_DATA_DIR));
}

function instanceFromArgv(argv: string[]): string | undefined {
  const arg = argv.find((item) => item.startsWith('--instance='));
  return arg?.slice('--instance='.length) || undefined;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const requested = instanceFromArgv(argv);
    if (requested && configStore.getInstance(requested)) {
      void openInstance(requested);
      return;
    }
    const window = instanceWindows()[0];
    if (window) showWindow(window);
    else void openInstance(configStore.defaultInstanceId);
  });

  app.whenReady().then(async () => {
    configStore.load();
    log.info(`启动 CloudSSH 桌面客户端 ${versionLabel()}（Electron ${process.versions.electron}）`);
    log.info('配置文件', configStore.path);

    registerIpc();
    registerVaultIpc();
    registerDragOutIpc();
    installGlobalShortcut();
    setOpenManagerHandler(() => openManagerWindow());
    buildAppMenu();
    buildTray();

    configStore.on('instances-changed', () => {
      refreshMenus();
      if (configStore.preferences.cliLoginSync) applyCliSync(true);
    });
    applyCliSync(configStore.preferences.cliLoginSync);
    void refreshCliInstall();
    app.on('browser-window-focus', () => refreshMenus());

    const requested = instanceFromArgv(process.argv);
    const initial = requested && configStore.getInstance(requested) ? requested : configStore.defaultInstanceId;
    await openInstance(initial, { newWindow: true });

    // 自动更新：状态变化推给所有窗口（左下角版本号）
    const updater = await startUpdates();
    updater.onStatus((status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('desktop:update-status', status);
      }
    });
  });

  app.on('before-quit', () => markQuitting());

  app.on('window-all-closed', () => {
    // 托盘常驻模式下窗口是隐藏而不是关闭，走到这里说明用户确实关掉了所有窗口
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void openInstance(configStore.defaultInstanceId);
  });

  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));
}
