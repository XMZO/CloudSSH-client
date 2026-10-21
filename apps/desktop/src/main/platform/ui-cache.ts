/**
 * 平台适配层：界面缓存（服务器列表等），启动时先用它显示，打开就是完整列表（见 packages/ui-web/overrides/shared/boot.ts）。
 *
 * 存在 userData/ui-cache/<实例 ID>-<键>.json：不在 Electron 的 Cache 目录里，清理缓存不会删；
 * 删除实例、清除实例数据时一起删（clearUiCache）。内容只有服务器的名称、地址、标签等，没有密码与私钥。
 * 只有内置界面（自绘标题栏的 ui-web 构建或开发服务器）能调用；跟随 Worker 的网页拿不到。
 */
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { configStore } from '../config/store';
import { hasCustomChrome, instanceIdOfWebContents } from './windows';

/** 单项上限（几百台服务器的列表也远小于这个数） */
const MAX_BYTES = 4 * 1024 * 1024;
/** 键拼进文件名：小写字母、数字、短横线 */
const KEY_PATTERN = /^[a-z0-9-]{1,32}$/;

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'ui-cache');
}

function cachePath(instanceId: string, key: string): string {
  return path.join(cacheDir(), `${instanceId}-${key}.json`);
}

function builtInInstanceId(event: IpcMainInvokeEvent): string {
  const id = instanceIdOfWebContents(event.sender.id);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!id || !configStore.getInstance(id) || !hasCustomChrome(window)) throw new Error('Forbidden: UI cache needs the built-in UI');
  return id;
}

/** 删除某个实例的全部界面缓存 */
export function clearUiCache(instanceId: string): void {
  const prefix = `${instanceId}-`;
  let names: string[] = [];
  try {
    names = fs.readdirSync(cacheDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(cacheDir(), name), { force: true });
    } catch {
      // 删不掉下次再说
    }
  }
}

export function registerUiCacheIpc(): void {
  ipcMain.handle('desktop:ui-cache', (event, op: unknown, key: unknown, value: unknown) => {
    const id = builtInInstanceId(event);
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new Error('缓存键无效');
    const target = cachePath(id, key);
    switch (op) {
      case 'read':
        try {
          return fs.readFileSync(target, 'utf8');
        } catch {
          return null;
        }
      case 'write': {
        if (value === null) {
          fs.rmSync(target, { force: true });
          return;
        }
        if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw new Error('缓存内容无效');
        fs.mkdirSync(cacheDir(), { recursive: true });
        const temp = `${target}.tmp`;
        fs.writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temp, target);
        return;
      }
      default:
        throw new Error('未知操作');
    }
  });
}
