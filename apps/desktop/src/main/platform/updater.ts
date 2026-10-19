/**
 * 自动更新：electron-updater，发布源是公开的 GitHub 仓库 XMZO/CloudSSH-client 的 Releases（electron-builder.yml 的
 * publish；打包时生成 resources/app-update.yml，发布时上传安装包、blockmap 与 latest.yml）。
 *
 * - 启动 15 秒后检查一次，之后每 6 小时一次；有新版本就在后台静默下载（差分下载），下载完不打扰：
 *   左下角版本号变成“重启更新”，点了确认后重启安装；不点也会在退出客户端时自动安装
 * - 只有用安装包装的客户端才更新：开发版、免安装版（zip，没有卸载程序）不检查，左下角说明原因
 * - 装好新版本后，第一次检查前删掉缓存里多余的那份安装包；卸载时整个更新缓存由卸载程序删除（update-cache.ts）
 * - 调试：CLOUDSSH_UPDATE_URL 指向一个 generic 发布目录（latest.yml + 安装包），不打包也能走一遍检查与下载
 * 界面层只依赖 UpdateProvider（状态、检查、安装、订阅），不直接依赖更新库。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';
import { removeInstalledPending, updaterCacheDir } from './update-cache';

const log = createLogger('updater');

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 3600_000;

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'not-available'; checkedAt: number }
  | { state: 'error'; message: string }
  | { state: 'disabled'; reason: string };

export interface UpdateProvider {
  readonly name: string;
  /** 当前状态（界面打开时先取一次，之后靠 onStatus） */
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  /** 已下载好时：退出并安装，装完重新打开 */
  quitAndInstall(): void;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
}

export class NoopUpdater implements UpdateProvider {
  readonly name = 'noop';
  constructor(private readonly reason = '当前版本未配置自动更新') {}

  status(): UpdateStatus {
    return { state: 'disabled', reason: this.reason };
  }

  async check(): Promise<UpdateStatus> {
    return this.status();
  }

  quitAndInstall(): void {
    // 没有更新源，无操作
  }

  onStatus(): () => void {
    return () => undefined;
  }
}

/** 网络错误等说短一点，界面上放得下 */
function shortMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n')[0];
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(text)) return '连不上 GitHub';
  if (/\b404\b|No published versions/i.test(text)) return '还没有发布过版本';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * 最新的 Release 里还没有 latest.yml：新版本正在上传（文件还没传完），不是检查失败。
 * 当作“暂时没有可用的更新”，过几分钟再查
 */
function stillPublishing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /latest\.yml[\s\S]*\b404\b/i.test(text);
}

const PUBLISHING_RETRY_MS = 5 * 60_000;

/**
 * 第一次检查前（启动 15 秒后，安装程序早已退出），删掉已经装好的版本留在更新缓存 pending 里的安装包，
 * 保留差分下载用的 installer.exe（见 update-cache.ts）。放在检查之前，不会和下载新版本撞在一起；不会失败，删不掉下次启动再删
 */
async function cleanInstalledUpdate(): Promise<void> {
  // 和 electron-updater 读的是同一份配置
  const config = app.isPackaged
    ? path.join(process.resourcesPath, 'app-update.yml')
    : path.join(app.getAppPath(), 'dev-app-update.yml');
  const dir = updaterCacheDir(config);
  if (!dir) return;
  try {
    const result = await removeInstalledPending(dir, app.getVersion());
    if (result.removed) {
      log.info(`已清理装好的 ${result.version} 安装包（${(result.bytes / 1048576).toFixed(1)}MB）`);
    }
  } catch (error) {
    log.warn('清理已安装版本的安装包失败，下次启动再试', error instanceof Error ? error.message : String(error));
  }
}

class GitHubUpdater implements UpdateProvider {
  readonly name = 'github';
  private current: UpdateStatus = { state: 'idle' };
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private checking: Promise<UpdateStatus> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private cleaned: Promise<void> | null = null;

  constructor(private readonly updater: import('electron-updater').AppUpdater) {
    updater.logger = {
      info: (message: unknown) => log.info(String(message)),
      warn: (message: unknown) => log.warn(String(message)),
      error: (message: unknown) => log.error(String(message)),
      debug: () => undefined,
    };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    // Windows（NsisUpdater）：发布的是完整安装包，不用网络安装包
    (updater as { disableWebInstaller?: boolean }).disableWebInstaller = true;
    updater.on('checking-for-update', () => this.set({ state: 'checking' }));
    updater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0 }));
    updater.on('download-progress', (progress) => {
      if (this.current.state === 'downloading') this.set({ ...this.current, percent: Math.floor(progress.percent) });
    });
    updater.on('update-not-available', () => this.set({ state: 'not-available', checkedAt: Date.now() }));
    updater.on('update-downloaded', (info) => this.set({ state: 'downloaded', version: info.version }));
    updater.on('error', (error) => this.fail(error));
  }

  /** 检查出错：已下载好的不因为后面一次失败丢掉“重启更新”；新版本正在发布时按“暂时没有更新”处理并稍后再查 */
  private fail(error: unknown): void {
    if (this.current.state === 'downloaded') return;
    if (stillPublishing(error)) {
      if (this.current.state !== 'not-available') this.set({ state: 'not-available', checkedAt: Date.now() });
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.check();
        }, PUBLISHING_RETRY_MS);
        this.retryTimer.unref?.();
      }
      return;
    }
    this.set({ state: 'error', message: shortMessage(error) });
  }

  private set(status: UpdateStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }

  status(): UpdateStatus {
    return this.current;
  }

  check(): Promise<UpdateStatus> {
    // 正在下载或已下载好时不再检查；同时只跑一次
    if (this.current.state === 'downloading' || this.current.state === 'downloaded') return Promise.resolve(this.current);
    this.checking ??= (this.cleaned ??= cleanInstalledUpdate())
      .then(() => this.updater.checkForUpdates())
      .catch((error: unknown) => this.fail(error))
      .then(() => this.current)
      .finally(() => (this.checking = null));
    return this.checking;
  }

  quitAndInstall(): void {
    if (this.current.state !== 'downloaded') return;
    log.info(`退出并安装 ${this.current.version}`);
    // 静默安装（按装时的位置与权限），装完重新打开
    this.updater.quitAndInstall(true, true);
  }

  onStatus(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

let current: UpdateProvider = new NoopUpdater();

export function getUpdater(): UpdateProvider {
  return current;
}

export function setUpdater(provider: UpdateProvider): void {
  current = provider;
}

/** 用安装包装的（NSIS 会在程序目录放卸载程序）；免安装版（zip）没有，不能自己替换自己 */
function installedWithInstaller(): boolean {
  if (process.platform !== 'win32') return true;
  const dir = path.dirname(process.execPath);
  try {
    return fs.readdirSync(dir).some((name) => /^Uninstall .+\.exe$/i.test(name));
  } catch {
    return false;
  }
}

/** 按运行方式选更新器并开始定时检查 */
export async function startUpdates(): Promise<UpdateProvider> {
  const feed = process.env.CLOUDSSH_UPDATE_URL;
  let provider: UpdateProvider;
  if (!feed && !app.isPackaged) provider = new NoopUpdater('开发版不检查更新');
  else if (!feed && !installedWithInstaller()) provider = new NoopUpdater('免安装版不自动更新，请到 GitHub Releases 下载新版本');
  else {
    const { autoUpdater } = await import('electron-updater');
    if (feed) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: feed });
      log.info('使用调试更新源', feed);
    }
    provider = new GitHubUpdater(autoUpdater);
  }
  setUpdater(provider);
  if (provider.name !== 'noop') {
    setTimeout(() => void provider.check(), FIRST_CHECK_MS).unref();
    setInterval(() => void provider.check(), CHECK_EVERY_MS).unref();
  }
  return provider;
}
