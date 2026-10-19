/**
 * 传文件：本机 ↔ 服务器（upload / download）与服务器之间（copy）。
 *
 * 本机 ↔ 服务器走 Worker 的 SFTP 通道（ai-remote/sftp.ts，与网页版 SFTP 面板同一套协议，上传带 SHA-256 校验）：
 * - 文件：先写 <目标>.cs-part，完成后改名，中途失败不留半截文件
 * - 目录：在一端用 tar 打包（Windows 10 起自带 tar），传过去再解开；目标已是目录时合并进去
 * 目标路径与 scp 一样：已存在的目录（或以 / 结尾）放进去、保留原名；否则就是最终路径。已存在的文件直接覆盖。
 * 下载的内容先放在内存里（默认上限 2GB，--max-size 可改）。
 * 服务器之间（copy）复用 AI 跨服务器操作的传输（ai-remote/transfer.ts）：能直连就让源服务器直接 SSH 到目标，
 * 否则经本机中转。
 */
import type { ServerConfig } from '@cloudssh/core';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { remoteExec, remoteSession } from '../../ui-web/overrides/shared/ai-remote/session';
import { HeadlessSftp } from '../../ui-web/overrides/shared/ai-remote/sftp';
import { planCopy, runCopy, type CopyResult } from '../../ui-web/overrides/shared/ai-remote/transfer';
import { UsageError } from './config';

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const LONG = 3600;

export interface Progress {
  (step: string, loaded?: number, total?: number): void;
}

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** 远端 Shell 里的路径：~/ 开头展开成 $HOME */
function shellPath(value: string): string {
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/')) return `"$HOME"/${quote(value.slice(2))}`;
  return quote(value);
}

async function run(server: ServerConfig, command: string, timeout = 60): Promise<string> {
  const result = await remoteExec(server.id, command, timeout);
  if (result.timedOut) throw new Error(`${server.name}: 超时`);
  if (result.exitCode !== 0) {
    const tail = result.output.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new Error(`${server.name}: ${tail || `退出码 ${result.exitCode ?? '?'}`}`);
  }
  return result.output;
}

async function openSftp(server: ServerConfig): Promise<HeadlessSftp> {
  const session = remoteSession(server.id);
  await session.ready;
  if (!session.sftpUrl) throw new Error(`${server.name}: 没有 SFTP 通道`);
  return HeadlessSftp.open(session.sftpUrl);
}

/** 本机的 tar：Windows 上用系统自带的 bsdtar（System32\tar.exe），Git 自带的 GNU tar 会把 C:\… 当成“主机:路径” */
function tarProgram(): string {
  if (process.platform !== 'win32') return 'tar';
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(system) ? system : 'tar';
}

function tar(args: string[]): void {
  const result = spawnSync(tarProgram(), args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.error) throw new Error(`本机没有 tar：${result.error.message}`);
  if (result.status !== 0) throw new Error(`tar 失败：${(result.stderr || '').trim().slice(0, 300)}`);
}

const tempName = () => `cloudssh-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface TransferResult {
  kind: 'file' | 'dir';
  bytes: number;
  /** 最终落地的路径 */
  dest: string;
  method?: CopyResult['method'];
  hops?: number;
  note?: string;
}

/** 本机 → 服务器 */
export async function upload(server: ServerConfig, localPath: string, remotePath: string, progress: Progress): Promise<TransferResult> {
  const source = path.resolve(localPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new UsageError(`本机没有 ${localPath}`);
  }
  const kind = stat.isDirectory() ? 'dir' : 'file';
  const name = path.basename(source);
  // 落在哪（相对路径从登录用户的家目录算）
  const where = await run(
    server,
    `d=${shellPath(remotePath)}; case ${quote(remotePath)} in */) into=1;; *) into=0;; esac;` +
      ` if [ "$into" = 1 ] || [ -d "$d" ]; then f="\${d%/}/"${quote(name)}; else f="$d"; fi;` +
      ` case "$f" in /*) ;; *) f="$PWD/$f";; esac; printf '%s\\n' "$f"`
  );
  const dest = where.trim().split('\n').pop()!.trim();
  await run(server, `mkdir -p "$(dirname -- ${quote(dest)})"`);
  let blobPath = source;
  let temp: string | null = null;
  if (kind === 'dir') {
    progress('pack');
    temp = path.join(os.tmpdir(), `${tempName()}.tgz`);
    tar(['-czf', temp, '-C', path.dirname(source), name]);
    blobPath = temp;
  }
  try {
    const blob = await fs.openAsBlob(blobPath);
    const remoteTemp = kind === 'dir' ? `/tmp/${tempName()}.tgz` : `${dest}.cs-part`;
    const sftp = await openSftp(server);
    try {
      await sftp.upload(remoteTemp, blob, (loaded, total) => progress('upload', loaded, total));
    } finally {
      sftp.close();
    }
    if (kind === 'file') {
      await run(server, `mv -f ${quote(remoteTemp)} ${quote(dest)}`);
    } else {
      progress('unpack');
      await run(
        server,
        `t=$(mktemp -d) && tar xzf ${quote(remoteTemp)} -C "$t"; rc=$?; rm -f ${quote(remoteTemp)}; [ $rc = 0 ] || { rm -rf "$t"; exit $rc; };` +
          ` f=${quote(dest)}; if [ -d "$f" ]; then cp -a "$t"/${quote(name)}/. "$f"/; else mv "$t"/${quote(name)} "$f"; fi; rc=$?; rm -rf "$t"; exit $rc`,
        LONG
      );
    }
    return { kind, bytes: blob.size, dest };
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
}

/** 服务器 → 本机 */
export async function download(
  server: ServerConfig,
  remotePath: string,
  localPath: string,
  maxBytes: number,
  progress: Progress
): Promise<TransferResult> {
  const info = await run(
    server,
    `p=${shellPath(remotePath)}; if [ -d "$p" ]; then echo dir; elif [ -f "$p" ]; then echo file; else echo missing; exit 3; fi;` +
      ` d=$(cd "$(dirname -- "$p")" && pwd -P) && printf '%s/%s\\n' "$d" "$(basename -- "$p")"`
  ).catch((error: Error) => {
    throw new UsageError(/missing|退出码 3/.test(error.message) ? `${server.name} 上没有 ${remotePath}` : error.message);
  });
  const lines = info.trim().split('\n').map((line) => line.trim());
  const kindText = lines[0];
  const remoteAbs = lines[lines.length - 1];
  const kind = kindText === 'dir' ? 'dir' : 'file';
  const name = remoteAbs.slice(remoteAbs.lastIndexOf('/') + 1);
  const target = path.resolve(localPath);
  const into = /[\\/]$/.test(localPath) || (fs.existsSync(target) && fs.statSync(target).isDirectory());
  const dest = into ? path.join(target, name) : target;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let remoteFile = remoteAbs;
  if (kind === 'dir') {
    progress('pack');
    remoteFile = `/tmp/${tempName()}.tgz`;
    const parent = remoteAbs.slice(0, remoteAbs.lastIndexOf('/')) || '/';
    await run(server, `tar czf ${quote(remoteFile)} -C ${quote(parent)} ${quote(name)}`, LONG);
  }
  let blob: Blob;
  const sftp = await openSftp(server);
  try {
    blob = await sftp.download(remoteFile, maxBytes, (loaded, total) => progress('download', loaded, total));
  } finally {
    sftp.close();
    if (kind === 'dir') await run(server, `rm -f ${quote(remoteFile)}`).catch(() => undefined);
  }
  if (kind === 'file') {
    const part = `${dest}.cs-part`;
    await pipeline(Readable.fromWeb(blob.stream() as never), fs.createWriteStream(part));
    fs.renameSync(part, dest);
  } else {
    progress('unpack');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-'));
    try {
      const archive = path.join(work, 'archive.tgz');
      await pipeline(Readable.fromWeb(blob.stream() as never), fs.createWriteStream(archive));
      const out = path.join(work, 'out');
      fs.mkdirSync(out);
      tar(['-xzf', archive, '-C', out]);
      fs.cpSync(path.join(out, name), dest, { recursive: true, force: true });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return { kind, bytes: blob.size, dest };
}

/** 服务器 → 服务器；目标已存在时要 overwrite 才覆盖 */
export async function copyBetween(
  source: ServerConfig,
  srcPath: string,
  target: ServerConfig,
  dstPath: string,
  overwrite: (dest: string) => Promise<boolean>,
  progress: Progress
): Promise<TransferResult> {
  const plan = await planCopy({ source, srcPath, target, dstPath });
  if (plan.destExists && !(await overwrite(plan.dest))) throw new UsageError(`${target.name} 上已有 ${plan.dest}：确认覆盖后加 --yes`);
  const result = await runCopy(plan, (step, percent) => progress(step, percent, percent === undefined ? undefined : 100));
  return { kind: plan.kind, bytes: result.bytes, dest: result.dest, method: result.method, hops: result.hops, note: result.note };
}

/**
 * 本机路径：Windows 上的 Git Bash 写法（/tmp/x、/c/Users/…、~ 已由 bash 展开成 /c/Users/…）换成 Windows 路径。
 * 启动脚本关掉了 MSYS 的参数改写（不然远程路径也会被改），本机路径要自己换：在 Git Bash 里（有 MSYSTEM）用 cygpath，
 * 没有 cygpath 时至少认 /c/… 这种盘符写法
 */
export function localPath(value: string): string {
  if (process.platform !== 'win32' || !value.startsWith('/')) return value;
  if (process.env.MSYSTEM) {
    const result = spawnSync('cygpath', ['-w', value], { encoding: 'utf8' });
    const converted = result.status === 0 ? result.stdout.trim() : '';
    if (converted) return converted;
  }
  const drive = /^\/([a-z])(\/.*)?$/i.exec(value);
  return drive ? `${drive[1].toUpperCase()}:${drive[2] ?? '/'}` : value;
}

/** "srv-12:/path" → [目标, 路径]；没有冒号前缀的是本机路径（Windows 盘符 C:\ 不算） */
export function splitRemote(spec: string): { target: string; path: string } | null {
  const match = /^([^:\\/]{2,}|srv-\d+):(.*)$/i.exec(spec);
  if (!match || !match[2]) return null;
  return { target: match[1], path: match[2] };
}
