/**
 * 平台适配层：凭据预设的本地保管。
 *
 * 预设列表由页面整理成 JSON（名称、用户名、认证方式、加密后的密码/私钥），存在配置目录的
 * credential-presets.json；密码和私钥用系统提供的加密（Electron safeStorage：Windows 为 DPAPI，
 * 绑定当前 Windows 账户；macOS 为钥匙串；Linux 为 libsecret / kwallet）加密后才写进去，明文只在内存里。
 * Linux 上没有可用的密钥服务时（safeStorage 只能退回固定密钥）视为不可用，页面会提示而不是假装加密。
 *
 * 只有内置界面（窗口由界面自己画标题栏的 ui-web 构建或开发服务器）能调用；跟随 Worker 的网页拿不到。
 */
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { configStore } from '../config/store';
import { createLogger } from '../logger';
import { hasCustomChrome, instanceIdOfWebContents } from './windows';

const log = createLogger('vault');

/** 预设列表的大小上限（几十条私钥也远小于这个数） */
const MAX_DATA_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;

function filePath(): string {
  return path.join(app.getPath('userData'), 'credential-presets.json');
}

function assertBuiltInUi(event: IpcMainInvokeEvent): void {
  const id = instanceIdOfWebContents(event.sender.id);
  const instance = id ? configStore.getInstance(id) : undefined;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!instance || !hasCustomChrome(window)) throw new Error('Forbidden: credential presets need the built-in UI');
}

export function vaultAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (backend === 'basic_text' || backend === 'unknown') return false;
  }
  return true;
}

function readData(): string | null {
  try {
    return fs.readFileSync(filePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('读取凭据预设失败', (error as Error).message);
    return null;
  }
}

function writeData(data: string): void {
  const target = filePath();
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, data, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
}

export function registerVaultIpc(): void {
  ipcMain.handle('desktop:vault', (event, op: unknown, value: unknown) => {
    assertBuiltInUi(event);
    switch (op) {
      case 'available':
        return vaultAvailable();
      case 'read':
        return readData();
      case 'write': {
        if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_DATA_BYTES) throw new Error('预设数据无效');
        JSON.parse(value);
        writeData(value);
        return;
      }
      case 'encrypt': {
        if (!vaultAvailable()) throw new Error('系统无法安全保存凭据');
        if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error('凭据无效');
        return safeStorage.encryptString(value).toString('base64');
      }
      case 'decrypt': {
        if (typeof value !== 'string') throw new Error('凭据无效');
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
      }
      default:
        throw new Error('未知操作');
    }
  });
}
