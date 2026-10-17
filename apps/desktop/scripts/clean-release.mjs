/**
 * 打包前清空 apps/desktop/release/。
 *
 * 正在运行 release/win-unpacked/CloudSSH.exe 时目录里的文件被占用：直接递归删除会删到一半才报错
 * （旧安装包已经没了，正在用的那份还在）。所以先把整个目录改名——Windows 上目录里有文件被占用时改名会失败，
 * 改名成功才删除；改名失败就什么都不删，提示先关闭正在运行的 CloudSSH。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');

if (fs.existsSync(release)) {
  const trash = path.join(root, `.release-trash-${process.pid}`);
  try {
    fs.renameSync(release, trash);
  } catch (error) {
    if (['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
      console.error(
        '[desktop] apps/desktop/release 里的文件正在被使用（多半是正在运行的 release\\win-unpacked\\CloudSSH.exe）。' +
          '请先关闭 CloudSSH 再打包；这次没有删除任何文件。'
      );
      process.exit(1);
    }
    throw error;
  }
  fs.rmSync(trash, { recursive: true, force: true });
}
