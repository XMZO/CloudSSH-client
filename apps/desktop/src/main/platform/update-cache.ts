/**
 * 自动更新缓存的清理。electron-updater 的缓存目录是 <本地缓存目录>/<app-update.yml 的 updaterCacheDirName>
 * （Windows 上是 %LOCALAPPDATA%\@cloudsshdesktop-updater），里面：
 * - installer.exe + current.blockmap：当前版本的安装包（安装程序装完把自己复制过来），下次差分下载的基准，保留
 * - pending/：下载好的新版本（安装包、blockmap、update-info.json）。装好以后 electron-updater 不删它，
 *   要等下次下载新版本时才换掉，期间和 installer.exe 是同一个文件，白占一份安装包大小
 * 卸载时整个目录由安装包的卸载程序删除（resources/installer.nsh）。
 * 不依赖 electron，方便单独测试（test/update-cache.test.mjs）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 和 electron-updater 的 getAppCacheDir 一致 */
function baseCacheDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(home, '.cache');
}

/** 缓存目录；读不到 app-update.yml 或里面没有 updaterCacheDirName 时返回 null（不清理） */
export function updaterCacheDir(configFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    return null;
  }
  const name = /^updaterCacheDirName:\s*(['"]?)([^'"\r\n]+)\1\s*$/m.exec(text)?.[2]?.trim();
  if (!name || name !== path.basename(name)) return null;
  return path.join(baseCacheDir(), name);
}

/** 安装包文件名里的版本：CloudSSH-Setup-<x.y.z>-<arch>.exe（electron-builder.yml 的 nsis.artifactName）；认不出返回 null */
export function installerVersion(fileName: string): string | null {
  return /-(\d+\.\d+\.\d+)-[^-]+\.exe$/i.exec(fileName)?.[1] ?? null;
}

/** a ≤ b，只比较 x.y.z；有认不出的部分按“不是”处理 */
function atMost(a: string, b: string): boolean {
  const x = a.split('.').map((part) => Number.parseInt(part, 10));
  const y = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return false;
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return true;
}

export type PendingCleanup =
  | { removed: false }
  | { removed: true; version: string; bytes: number };

/**
 * pending 里的安装包版本不高于当前版本（已经装好，或者更旧）就删掉整个 pending；
 * 比当前版本新的（下载好还没装）留着，下次检查到同一版本时直接用。只读 update-info.json 指明的安装包，认不出就不动。
 * 先删安装包本身，删不掉（例如安装程序还在运行）就整个留着，下次启动再删，免得只剩安装包而没了 update-info.json。
 */
export async function removeInstalledPending(cacheDir: string, currentVersion: string): Promise<PendingCleanup> {
  const pending = path.join(cacheDir, 'pending');
  let fileName: unknown;
  try {
    fileName = JSON.parse(await fs.promises.readFile(path.join(pending, 'update-info.json'), 'utf8'))?.fileName;
  } catch {
    return { removed: false };
  }
  if (typeof fileName !== 'string' || fileName !== path.basename(fileName)) return { removed: false };
  const version = installerVersion(fileName);
  if (!version || !atMost(version, currentVersion)) return { removed: false };

  const installer = path.join(pending, fileName);
  const bytes = await fs.promises.stat(installer).then(
    (stat) => stat.size,
    () => 0,
  );
  await fs.promises.rm(installer, { force: true });
  await fs.promises.rm(pending, { recursive: true, force: true });
  return { removed: true, version, bytes };
}
