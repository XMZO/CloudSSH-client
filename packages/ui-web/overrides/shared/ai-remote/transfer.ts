/**
 * 服务器之间传文件或目录（AI 的 copy 动作）。
 *
 * 1. 同一台服务器：cp -a。
 * 2. 直连（目标没有跳板、不是 CF 隧道）：源服务器直接 SSH 到目标，数据不经过客户端。
 *    - 先通过 Worker 已验证过指纹的后台会话读出目标的主机公钥，写进源上的临时 known_hosts，严格校验，不盲信；
 *    - 在源上生成一次性 ed25519 密钥，公钥带 restrict（禁止端口转发、终端等）临时加进目标的 authorized_keys；
 *    - 文件：ssh 目标 'cat > 临时文件 && mv'；目录：tar 打包经 ssh 在目标解开；
 *    - 无论成败都删掉两边的临时密钥；目标上顺带清理一小时前中断遗留的临时公钥（注释带时间戳）。
 *    任何一步失败（源上没有 ssh、连不过去、目标不接受密钥……）都改走中转。
 * 3. 中转：两台都通过客户端，SFTP 从源下载到内存再上传到目标；目录先在源上 tar 打包，到目标解开。
 *    受客户端内存限制：电脑 512MB、手机 128MB。
 */
import type { ServerConfig } from '@cloudssh/core';
import { remoteExec, remoteSession, type ExecResult } from './session';
import { routeOf } from './servers';
import { HeadlessSftp } from './sftp';

export interface CopyRequest {
  source: ServerConfig;
  srcPath: string;
  target: ServerConfig;
  dstPath: string;
}

export interface CopyPlan extends CopyRequest {
  kind: 'file' | 'dir';
  /** 源的绝对路径 */
  srcAbs: string;
  /** 文件字节数；目录为 du 的估算 */
  size: number;
  /** 最终落地的路径（目标上） */
  dest: string;
  destExists: boolean;
}

export interface CopyResult {
  method: 'local' | 'direct' | 'relay';
  bytes: number;
  dest: string;
  /** 直连失败后改走中转时的原因 */
  note?: string;
}

const IS_PHONE = /Android|iPhone|iPad/i.test(navigator.userAgent);
const RELAY_LIMIT = (IS_PHONE ? 128 : 512) * 1024 * 1024;
const TRANSFER_TIMEOUT = 3600;

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 本机 Shell 里的路径：~/ 开头展开成 $HOME */
function shellPath(path: string): string {
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"/${quote(path.slice(2))}`;
  return quote(path);
}

/** 经 ssh 在远端 Shell 里用的路径：远端命令在家目录执行，~/ 改成相对路径 */
function remotePath(path: string): string {
  if (path === '~') return '.';
  if (path.startsWith('~/')) return quote(path.slice(2) || '.');
  return quote(path);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  if (at < 0) return '.';
  return at === 0 ? '/' : trimmed.slice(0, at);
}

function failed(result: ExecResult): string | null {
  if (result.timedOut) return 'timed out';
  if (result.exitCode === 0) return null;
  return result.output.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `exit ${result.exitCode ?? '?'}`;
}

async function run(server: ServerConfig, command: string, timeout = 60): Promise<string> {
  const result = await remoteExec(server.id, command, timeout);
  const error = failed(result);
  if (error) throw new Error(`${server.name}: ${error}`);
  return result.output;
}

/** 查清源是什么、多大，目标落在哪、是否已存在 */
export async function planCopy(request: CopyRequest): Promise<CopyPlan> {
  const src = shellPath(request.srcPath);
  const info = await run(
    request.source,
    `p=${src}; if [ -d "$p" ]; then echo dir; du -sk "$p" 2>/dev/null | cut -f1; elif [ -f "$p" ]; then echo file; wc -c < "$p"; else echo missing; exit 3; fi;` +
      ` d=$(cd "$(dirname -- "$p")" && pwd -P) && printf '%s/%s\\n' "$d" "$(basename -- "$p")"`
  ).catch((error: Error) => {
    throw new Error(/exit 3|missing/.test(error.message) ? `${request.source.name}: ${request.srcPath} 不存在` : error.message);
  });
  const [kind, amount, srcAbs] = info.trim().split('\n').map((line) => line.trim());
  if ((kind !== 'file' && kind !== 'dir') || !srcAbs) throw new Error(`${request.source.name}: 无法读取 ${request.srcPath}`);
  const size = kind === 'dir' ? (Number(amount) || 0) * 1024 : Number(amount) || 0;

  const dst = shellPath(request.dstPath);
  const name = basename(srcAbs);
  const where = await run(
    request.target,
    `d=${dst}; case ${quote(request.dstPath)} in */) into=1;; *) into=0;; esac;` +
      ` if [ "$into" = 1 ] || [ -d "$d" ]; then f="\${d%/}/"${quote(name)}; else f="$d"; fi;` +
      ` if [ -e "$f" ]; then echo exists; else echo new; fi; printf '%s\\n' "$f"`
  );
  const [state, dest] = where.trim().split('\n').map((line) => line.trim());
  return { ...request, kind, srcAbs, size, dest: dest || request.dstPath, destExists: state === 'exists' };
}

/** 目标路径在远端 Shell 里的写法（planCopy 得到的 dest 已经展开了 $HOME） */
function destArg(plan: CopyPlan, remote: boolean): string {
  return remote ? remotePath(plan.dest) : quote(plan.dest);
}

async function copyLocal(plan: CopyPlan): Promise<CopyResult> {
  const dest = quote(plan.dest);
  const src = quote(plan.srcAbs);
  await run(
    plan.source,
    plan.kind === 'dir'
      ? `mkdir -p ${dest} && cp -a ${src}/. ${dest}/`
      : `mkdir -p "$(dirname -- ${dest})" && cp -a ${src} ${dest}`,
    TRANSFER_TIMEOUT
  );
  return { method: 'local', bytes: plan.size, dest: plan.dest };
}

async function copyDirect(plan: CopyPlan, onStatus: (text: string) => void): Promise<CopyResult> {
  const { source, target } = plan;
  if (routeOf(target) !== 'direct' || !target.host) throw new Error('目标需要经跳板或隧道，无法直连');
  onStatus('direct-prepare');
  // 1. 目标的主机公钥（经 Worker 已验证的通道读出）
  const keys = (await run(target, 'cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null; true'))
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && /^(ssh-|ecdsa-)/.test(parts[0]) && /^[A-Za-z0-9+/=]+$/.test(parts[1]));
  if (!keys.length) throw new Error('读不到目标的主机公钥');
  const hostPattern = target.port && target.port !== 22 ? `[${target.host}]:${target.port}` : target.host;
  const knownHosts = keys.map((parts) => `${hostPattern} ${parts[0]} ${parts[1]}`);

  // 2. 源上生成一次性密钥
  const tag = `cloudssh-xfer-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}`;
  const made = await run(
    source,
    `command -v ssh >/dev/null && command -v ssh-keygen >/dev/null || { echo 'ssh or ssh-keygen missing' >&2; exit 4; };` +
      ` umask 077; d=$(mktemp -d 2>/dev/null || mktemp -d -t cloudssh) && ssh-keygen -q -t ed25519 -N '' -C ${quote(tag)} -f "$d/k" >/dev/null` +
      ` && printf '%s\\n' ${knownHosts.map(quote).join(' ')} > "$d/kh" && printf '%s\\n' "$d" && cat "$d/k.pub"`
  );
  const [dir, publicKey] = made.trim().split('\n').map((line) => line.trim());
  if (!dir || !/^ssh-ed25519 [A-Za-z0-9+/=]+/.test(publicKey ?? '')) throw new Error('生成临时密钥失败');

  const purge =
    `f=~/.ssh/authorized_keys; [ -f "$f" ] && awk -v now="$(date +%s)" '/${tag}/ { next } { if (match($0, /cloudssh-xfer-[0-9]+-/)) { ts = substr($0, RSTART + 14, RLENGTH - 15) + 0; if (now - ts > 3600) next } print }' "$f" > "$f.cs-tmp" && cat "$f.cs-tmp" > "$f"; rm -f "$f.cs-tmp"`;
  try {
    // 3. 公钥临时加进目标（restrict：只允许执行命令）
    // 原文件末尾没有换行时先补一个，免得临时公钥接在最后一把密钥后面把它弄坏
    await run(
      target,
      `umask 077; mkdir -p ~/.ssh && f=~/.ssh/authorized_keys; if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then echo >> "$f"; fi;` +
        ` printf '%s\\n' ${quote(`restrict ${publicKey}`)} >> "$f"`
    );
    // 4. 源直接传到目标
    onStatus('direct-copy');
    const ssh =
      `ssh -F /dev/null -i "$k/k" -p ${Number(target.port) || 22} -o BatchMode=yes -o IdentitiesOnly=yes -o UserKnownHostsFile="$k/kh"` +
      ` -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o LogLevel=ERROR ${quote(`${target.username}@${target.host}`)}`;
    const dest = destArg(plan, true);
    const remote =
      plan.kind === 'dir'
        ? `mkdir -p ${dest} && tar xzf - -C ${dest} --strip-components=1`
        : `mkdir -p "$(dirname -- ${dest})" && cat > ${dest}.cs-part && mv -f ${dest}.cs-part ${dest}`;
    const transfer =
      plan.kind === 'dir'
        ? `tar czf - -C ${quote(dirname(plan.srcAbs))} ${quote(basename(plan.srcAbs))} | ${ssh} ${quote(remote)}`
        : `${ssh} ${quote(remote)} < ${quote(plan.srcAbs)}`;
    await run(source, `k=${quote(dir)}; ${transfer}`, TRANSFER_TIMEOUT);
    return { method: 'direct', bytes: plan.size, dest: plan.dest };
  } finally {
    // 5. 清理两边的临时密钥（失败也继续，不影响结果）
    await run(target, purge).catch(() => undefined);
    await run(source, `rm -rf ${quote(dir)}`).catch(() => undefined);
    if (plan.kind === 'file') await run(target, `rm -f ${quote(plan.dest)}.cs-part`).catch(() => undefined);
  }
}

async function openSftp(server: ServerConfig): Promise<HeadlessSftp> {
  const session = remoteSession(server.id);
  await session.ready;
  if (!session.sftpUrl) throw new Error(`${server.name}: 没有 SFTP 通道`);
  return HeadlessSftp.open(session.sftpUrl);
}

async function copyRelay(plan: CopyPlan, onStatus: (text: string, percent?: number) => void): Promise<CopyResult> {
  const { source, target } = plan;
  const temp = `/tmp/cloudssh-xfer-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tgz`;
  let remotePathOnSource = plan.srcAbs;
  if (plan.kind === 'dir') {
    onStatus('relay-pack');
    await run(source, `tar czf ${quote(temp)} -C ${quote(dirname(plan.srcAbs))} ${quote(basename(plan.srcAbs))}`, TRANSFER_TIMEOUT);
    remotePathOnSource = temp;
  }
  let blob: Blob;
  const from = await openSftp(source);
  try {
    blob = await from.download(remotePathOnSource, RELAY_LIMIT, (loaded, total) =>
      onStatus('relay-download', total ? Math.round((loaded / total) * 100) : undefined)
    );
  } finally {
    from.close();
    if (plan.kind === 'dir') await run(source, `rm -f ${quote(temp)}`).catch(() => undefined);
  }
  // 目标路径：SFTP 不展开 ~，换成绝对路径
  const home = (await run(target, 'printf %s "$HOME"')).trim();
  const absolute = (path: string) => (path.startsWith('/') ? path : `${home}/${path.replace(/^~\/?/, '')}`);
  const uploadPath = plan.kind === 'dir' ? temp : absolute(plan.dest);
  await run(target, `mkdir -p "$(dirname -- ${quote(uploadPath)})"`);
  const to = await openSftp(target);
  try {
    await to.upload(uploadPath, blob, (loaded, total) => onStatus('relay-upload', total ? Math.round((loaded / total) * 100) : undefined));
  } finally {
    to.close();
  }
  if (plan.kind === 'dir') {
    const dest = quote(absolute(plan.dest));
    await run(
      target,
      `mkdir -p ${dest} && tar xzf ${quote(temp)} -C ${dest} --strip-components=1; rc=$?; rm -f ${quote(temp)}; exit $rc`,
      TRANSFER_TIMEOUT
    );
  }
  return { method: 'relay', bytes: blob.size, dest: plan.dest };
}

/** 执行传输：同机 → 直连 → 中转 */
export async function runCopy(plan: CopyPlan, onStatus: (text: string, percent?: number) => void): Promise<CopyResult> {
  if (plan.source.id === plan.target.id) return copyLocal(plan);
  let note: string | undefined;
  if (routeOf(plan.target) === 'direct') {
    try {
      return await copyDirect(plan, onStatus);
    } catch (error) {
      note = `direct transfer failed (${error instanceof Error ? error.message : String(error)}), relayed through the client`;
    }
  } else {
    note = 'target is behind a jump host or tunnel, relayed through the client';
  }
  if (plan.size > RELAY_LIMIT) {
    throw new Error(`${note ?? ''}; size ${plan.size} bytes exceeds the relay limit ${RELAY_LIMIT} bytes`.replace(/^; /, ''));
  }
  const result = await copyRelay(plan, onStatus);
  return { ...result, note };
}
