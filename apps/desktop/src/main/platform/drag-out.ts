/**
 * 平台适配层：把 SFTP 里的远程文件拖到桌面 / 资源管理器。
 *
 * 系统拖放只能拖本地已有的文件，所以分两步：
 *   1. 页面开始拖动时（desktop:drag-prepare）登记要拖的文件名，再照常让网页版下载这些文件；
 *      这里在 will-download 认出它们，不弹保存框，直接存进临时目录（CloudSSH-drag/<token>/）。
 *   2. 全部下载完成后通知页面（desktop:drag-ready）；鼠标还按着时页面调用 desktop:drag-start，
 *      由系统接手拖放，松开到哪个文件夹就复制到哪里。没按着就留着，十分钟内再拖同样的文件直接开始。
 * 临时文件十分钟后、以及退出时删除。
 */
import { app, type DownloadItem, ipcMain, nativeImage, type NativeImage, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';
import { instanceIdOfWebContents, resourcePath } from './windows';

const log = createLogger('drag-out');

const KEEP_MS = 10 * 60 * 1000;
const MAX_FILES = 50;

interface DragSet {
  owner: number;
  names: string[];
  dir: string;
  files: Map<string, string>;
  inFlight: Set<string>;
  failed: boolean;
  done: boolean;
  timer: NodeJS.Timeout | null;
}

const sets = new Map<string, DragSet>();
let icon: NativeImage | null = null;

function baseDir(): string {
  return path.join(app.getPath('temp'), 'CloudSSH-drag');
}

/** Windows 文件名里不允许的字符换成下划线（网页版的文件名来自远端，什么都可能有） */
function safeName(name: string): string {
  let clean = path.basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) clean = `_${clean}`;
  return clean || 'download';
}

function dragIcon(): NativeImage {
  if (!icon) {
    const image = nativeImage.createFromPath(resourcePath('icon.png'));
    icon = image.isEmpty() ? image : image.resize({ width: 48, height: 48 });
  }
  return icon;
}

function removeSet(token: string): void {
  const set = sets.get(token);
  if (!set) return;
  sets.delete(token);
  if (set.timer) clearTimeout(set.timer);
  fs.rm(set.dir, { recursive: true, force: true }, () => undefined);
}

function scheduleCleanup(token: string, set: DragSet): void {
  if (set.timer) clearTimeout(set.timer);
  set.timer = setTimeout(() => removeSet(token), KEEP_MS);
}

/** session.ts 的 will-download 先问这里：是拖出准备中的文件就存进临时目录，返回 true */
export function claimDragDownload(item: DownloadItem, contents: WebContents | undefined): boolean {
  if (!contents || !item.getURL().startsWith('blob:')) return false;
  for (const [token, set] of sets) {
    if (set.owner !== contents.id || set.done) continue;
    const remaining = set.names.filter((name) => !set.files.has(name) && !set.inFlight.has(name));
    if (!remaining.length) continue;
    // 网页版按顺序一个个下载：文件名对得上就用它，对不上（被浏览器改过名）按顺序认领
    const suggested = item.getFilename();
    const name = remaining.includes(suggested) ? suggested : remaining[0];
    set.inFlight.add(name);
    fs.mkdirSync(set.dir, { recursive: true });
    const target = path.join(set.dir, safeName(name));
    item.setSavePath(target);
    item.once('done', (_event, state) => {
      set.inFlight.delete(name);
      if (state === 'completed') set.files.set(name, target);
      else set.failed = true;
      if (set.failed || set.files.size === set.names.length) {
        set.done = true;
        scheduleCleanup(token, set);
        if (!contents.isDestroyed()) contents.send('desktop:drag-ready', token, !set.failed);
        log.info('拖出文件已准备', set.files.size, '个', set.failed ? '（有失败）' : '');
      }
    });
    return true;
  }
  return false;
}

export function registerDragOutIpc(): void {
  fs.rm(baseDir(), { recursive: true, force: true }, () => undefined);

  ipcMain.handle('desktop:drag-prepare', (event, token: unknown, names: unknown) => {
    if (!instanceIdOfWebContents(event.sender.id)) throw new Error('Forbidden');
    if (typeof token !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(token)) throw new Error('无效的拖放标识');
    if (!Array.isArray(names) || !names.length || names.length > MAX_FILES || !names.every((name) => typeof name === 'string' && name)) {
      throw new Error('无效的文件列表');
    }
    removeSet(token);
    sets.set(token, {
      owner: event.sender.id,
      names: [...new Set(names as string[])],
      dir: path.join(baseDir(), token),
      files: new Map(),
      inFlight: new Set(),
      failed: false,
      done: false,
      timer: null,
    });
  });

  ipcMain.handle('desktop:drag-release', (event, token: unknown) => {
    const set = typeof token === 'string' ? sets.get(token) : undefined;
    if (set && set.owner === event.sender.id) removeSet(token as string);
  });

  // 必须在鼠标还按着时调用：系统拖放从当前光标位置开始，松开时结束
  ipcMain.on('desktop:drag-start', (event, token: unknown) => {
    const set = typeof token === 'string' ? sets.get(token) : undefined;
    if (!set || set.owner !== event.sender.id || !set.done || set.failed) return;
    const files = [...set.files.values()].filter((file) => fs.existsSync(file));
    if (!files.length) return;
    scheduleCleanup(token as string, set);
    event.sender.startDrag({ file: files[0], files, icon: dragIcon() });
  });

  app.on('will-quit', () => {
    for (const token of [...sets.keys()]) removeSet(token);
    try {
      fs.rmSync(baseDir(), { recursive: true, force: true });
    } catch {
      // 退出时删不掉（文件被占用）就留给下次启动
    }
  });
}
