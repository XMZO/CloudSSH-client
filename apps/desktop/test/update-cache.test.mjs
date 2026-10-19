/**
 * 自动更新缓存的清理（src/main/platform/update-cache.ts）：装好的版本留在 pending 里的安装包删掉，
 * 还没装的新版本、差分下载用的 installer.exe 保留，认不出的不动。全部在临时目录里做。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-update-cache-'));
const bundle = path.join(temp, 'update-cache.mjs');
await build({
  entryPoints: [path.join(here, '..', 'src', 'main', 'platform', 'update-cache.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'silent',
});
const { installerVersion, removeInstalledPending, updaterCacheDir } = await import(pathToFileURL(bundle).href);

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const SIZE = 4096;

/** 一个缓存目录：根目录 installer.exe + current.blockmap，pending 里放 fileName 指向的安装包 */
function makeCache(name, fileName, { info = { fileName, sha512: 'x', isAdminRightsRequired: false }, installer = true } = {}) {
  const dir = path.join(temp, name);
  const pending = path.join(dir, 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installer.exe'), Buffer.alloc(SIZE));
  fs.writeFileSync(path.join(dir, 'current.blockmap'), 'base');
  fs.writeFileSync(path.join(pending, 'current.blockmap'), 'new');
  if (info !== null) fs.writeFileSync(path.join(pending, 'update-info.json'), typeof info === 'string' ? info : JSON.stringify(info));
  if (installer && fileName && fileName === path.basename(fileName)) fs.writeFileSync(path.join(pending, fileName), Buffer.alloc(SIZE));
  return { dir, pending };
}

function assertBaseKept(dir) {
  assert.equal(fs.statSync(path.join(dir, 'installer.exe')).size, SIZE, 'installer.exe 要保留');
  assert.ok(fs.existsSync(path.join(dir, 'current.blockmap')), 'current.blockmap 要保留');
}

describe('updaterCacheDir', () => {
  const base = path.join(temp, 'local-cache');
  beforeEach(() => {
    process.env.LOCALAPPDATA = base;
    process.env.XDG_CACHE_HOME = base;
  });

  function config(text) {
    const file = path.join(temp, `app-update-${Math.random().toString(16).slice(2)}.yml`);
    fs.writeFileSync(file, text);
    return file;
  }

  test('读 app-update.yml 的 updaterCacheDirName，放在本地缓存目录下', () => {
    const dir = updaterCacheDir(config("owner: XMZO\r\nprovider: github\r\nupdaterCacheDirName: '@cloudsshdesktop-updater'\r\n"));
    assert.equal(path.basename(dir), '@cloudsshdesktop-updater');
    if (process.platform !== 'darwin') assert.equal(path.dirname(dir), base);
    assert.equal(path.basename(updaterCacheDir(config('updaterCacheDirName: plain-updater\n'))), 'plain-updater');
  });

  test('没有配置、没有这一项、名字像路径时不清理', () => {
    assert.equal(updaterCacheDir(path.join(temp, 'missing.yml')), null);
    assert.equal(updaterCacheDir(config('provider: github\n')), null);
    assert.equal(updaterCacheDir(config("updaterCacheDirName: '../escape'\n")), null);
  });
});

describe('installerVersion', () => {
  test('认出安装包文件名里的版本', () => {
    assert.equal(installerVersion('CloudSSH-Setup-0.3.31-x64.exe'), '0.3.31');
    assert.equal(installerVersion('CloudSSH-Setup-12.0.105-arm64.exe'), '12.0.105');
  });

  test('预发布版本和别的文件名认不出', () => {
    assert.equal(installerVersion('CloudSSH-Setup-0.4.0-beta.1-x64.exe'), null);
    assert.equal(installerVersion('installer.exe'), null);
    assert.equal(installerVersion('CloudSSH-0.3.31-win-x64.zip'), null);
  });
});

describe('removeInstalledPending', () => {
  test('pending 是当前版本：整个删掉，installer.exe 与 current.blockmap 保留', async () => {
    const { dir, pending } = makeCache('same', 'CloudSSH-Setup-0.3.31-x64.exe');
    assert.deepEqual(await removeInstalledPending(dir, '0.3.31'), { removed: true, version: '0.3.31', bytes: SIZE });
    assert.equal(fs.existsSync(pending), false);
    assertBaseKept(dir);
  });

  test('pending 比当前版本旧：删掉（逐段按数字比较）', async () => {
    const { dir, pending } = makeCache('older', 'CloudSSH-Setup-0.3.9-x64.exe');
    assert.equal((await removeInstalledPending(dir, '0.3.31')).removed, true);
    assert.equal(fs.existsSync(pending), false);
    assertBaseKept(dir);
  });

  test('pending 比当前版本新（下载好还没装）：保留', async () => {
    for (const [name, version] of [['newer-patch', '0.3.32'], ['newer-minor', '0.4.0'], ['newer-major', '1.0.0']]) {
      const fileName = `CloudSSH-Setup-${version}-x64.exe`;
      const { dir, pending } = makeCache(name, fileName);
      assert.deepEqual(await removeInstalledPending(dir, '0.3.31'), { removed: false });
      assert.ok(fs.existsSync(path.join(pending, fileName)), version);
      assert.ok(fs.existsSync(path.join(pending, 'update-info.json')), version);
    }
  });

  test('当前版本是预发布、认不出：不动', async () => {
    const { dir, pending } = makeCache('prerelease-current', 'CloudSSH-Setup-0.3.31-x64.exe');
    assert.deepEqual(await removeInstalledPending(dir, 'dev'), { removed: false });
    assert.ok(fs.existsSync(path.join(pending, 'CloudSSH-Setup-0.3.31-x64.exe')));
  });

  test('没有 pending、没有或读不懂 update-info.json、文件名认不出：不动也不报错', async () => {
    const empty = path.join(temp, 'no-pending');
    fs.mkdirSync(empty, { recursive: true });
    assert.deepEqual(await removeInstalledPending(empty, '0.3.31'), { removed: false });
    assert.deepEqual(await removeInstalledPending(path.join(temp, 'no-cache-dir'), '0.3.31'), { removed: false });

    const cases = [
      makeCache('no-info', 'CloudSSH-Setup-0.3.31-x64.exe', { info: null }),
      makeCache('bad-json', 'CloudSSH-Setup-0.3.31-x64.exe', { info: '{not json' }),
      makeCache('no-filename', 'CloudSSH-Setup-0.3.31-x64.exe', { info: { sha512: 'x' } }),
      makeCache('odd-name', 'something.exe'),
    ];
    for (const { dir, pending } of cases) {
      assert.deepEqual(await removeInstalledPending(dir, '0.3.31'), { removed: false }, dir);
      assert.ok(fs.existsSync(pending), dir);
    }
  });

  test('update-info.json 的文件名带路径：不动，碰不到 pending 外面的文件', async () => {
    const { dir, pending } = makeCache('traversal', '../CloudSSH-Setup-0.3.31-x64.exe', { installer: false });
    fs.writeFileSync(path.join(dir, 'CloudSSH-Setup-0.3.31-x64.exe'), 'outside');
    assert.deepEqual(await removeInstalledPending(dir, '0.3.31'), { removed: false });
    assert.ok(fs.existsSync(pending));
    assert.ok(fs.existsSync(path.join(dir, 'CloudSSH-Setup-0.3.31-x64.exe')));
    assertBaseKept(dir);
  });

  test('安装包已经不在了：剩下的 pending 也删掉', async () => {
    const { dir, pending } = makeCache('installer-gone', 'CloudSSH-Setup-0.3.30-x64.exe', { installer: false });
    assert.deepEqual(await removeInstalledPending(dir, '0.3.31'), { removed: true, version: '0.3.30', bytes: 0 });
    assert.equal(fs.existsSync(pending), false);
    assertBaseKept(dir);
  });

  test('安装包正在运行删不掉：报错，pending 原样留着，之后能再删', { skip: process.platform !== 'win32' }, async () => {
    const fileName = 'CloudSSH-Setup-0.3.31-x64.exe';
    const { dir, pending } = makeCache('busy', fileName, { installer: false });
    // 运行中的 exe 在 Windows 上删不掉：借 ping.exe 当作“还在运行的安装程序”
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), path.join(pending, fileName));
    const child = spawn(path.join(pending, fileName), ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      await assert.rejects(removeInstalledPending(dir, '0.3.31'));
      assert.ok(fs.existsSync(path.join(pending, 'update-info.json')), 'update-info.json 要留着，下次才认得出');
      assert.ok(fs.existsSync(path.join(pending, fileName)));
    } finally {
      child.kill();
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    }
    assert.equal((await removeInstalledPending(dir, '0.3.31')).removed, true);
    assert.equal(fs.existsSync(pending), false);
    assertBaseKept(dir);
  });
});
