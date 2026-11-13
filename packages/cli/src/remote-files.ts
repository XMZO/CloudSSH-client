/**
 * 服务器上的文件与后台任务（MCP 的 read_file / list_dir / write_file / edit_file / start_job / job_status）。
 *
 * 文件内容走 SFTP（与 upload / download 同一条通道）：不受命令输出 64KB 的限制，写入不经过 Shell 转义。
 * - 读：先查类型、大小与真实路径（跟随符号链接），再整个下载到内存（上限 20MB），按行切出要看的部分；二进制文件不读
 * - 写：先传到同目录的临时文件，再改名过去；覆盖已有文件时沿用原来的权限与属主（stat -c），符号链接写到它指向的文件
 * - 改（精确替换）：读出来、在内存里替换、写回；写回前核对文件的 SHA-256 与读时一致，被别人改过就不写
 * - 二进制：按字节写（内容是 base64，可分段）；按字节读（readBytes）时把整个文件留在内存里一会儿，同一个文件分段读不用每段都重新下载
 * 后台任务：命令写进 ~/.cloudssh-jobs/<任务>.cmd，用 setsid nohup 在新会话里跑（断开连接、会话关闭都不影响），
 * 输出写 .log、退出码写 .exit、进程号写 .pid；7 天前的任务文件启动新任务时顺手删掉。
 */
import type { ServerConfig } from '@cloudssh/core';
import { createHash, randomBytes } from 'node:crypto';
import { UsageError } from './config';
import { openSftp, quote, run, shellPath } from './files';

export const READ_MAX_BYTES = 20 * 1024 * 1024;
export const WRITE_MAX_BYTES = 10 * 1024 * 1024;
/** 一行最多显示多少字符（超长的行截断） */
const LINE_MAX = 2000;

const encoder = new TextEncoder();

export interface RemoteFileInfo {
  kind: 'file' | 'dir';
  size: number;
  /** 绝对路径（符号链接已解析） */
  path: string;
  /** 修改时间与 inode（stat 的原样输出，带纳秒）；拿不到时为空串 */
  mtime: string;
}

/** 查类型、大小与真实路径；不存在返回 null */
export async function statRemote(server: ServerConfig, path: string): Promise<RemoteFileInfo | null> {
  let output: string;
  try {
    output = await run(
      server,
      `p=${shellPath(path)}; if [ -d "$p" ]; then echo dir; elif [ -f "$p" ]; then echo file; else echo missing; exit 3; fi;` +
        ` if [ -f "$p" ]; then wc -c < "$p"; else echo 0; fi;` +
        ` { stat -c '%y %i' -- "$p" 2>/dev/null || date -r "$p" +%s 2>/dev/null || echo; } | head -n 1;` +
        ` r=$(readlink -f -- "$p" 2>/dev/null) || r=$(cd "$(dirname -- "$p")" && printf '%s/%s' "$(pwd -P)" "$(basename -- "$p")"); printf '%s\\n' "$r"`
    );
  } catch (error) {
    if (/missing|exit 3\b/.test((error as Error).message)) return null;
    throw error;
  }
  const lines = output.trim().split('\n').map((line) => line.trim());
  // 类型、大小、[修改时间]、真实路径
  return {
    kind: lines[0] === 'dir' ? 'dir' : 'file',
    size: Number(lines[1]) || 0,
    mtime: lines.length >= 4 ? lines[2] : '',
    path: lines[lines.length - 1],
  };
}

async function downloadBytes(server: ServerConfig, path: string, maxBytes: number): Promise<Uint8Array> {
  const sftp = await openSftp(server);
  try {
    return new Uint8Array(await (await sftp.download(path, maxBytes)).arrayBuffer());
  } finally {
    sftp.close();
  }
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ---------- 按字节读（带缓存） ----------

export interface BinaryFile {
  info: RemoteFileInfo;
  bytes: Uint8Array;
  sha256: string;
}

/** 按字节读到的整个文件在内存里留 10 分钟：分段读同一个文件时只下载一次（每次先 stat，大小或修改时间变了就重下） */
const BYTES_TTL_MS = 10 * 60_000;
const BYTES_CACHE_MAX = 64 * 1024 * 1024;
const bytesCache = new Map<string, BinaryFile & { at: number }>();

function rememberBytes(key: string, file: BinaryFile): void {
  bytesCache.delete(key);
  bytesCache.set(key, { ...file, at: Date.now() });
  let total = 0;
  for (const entry of bytesCache.values()) total += entry.bytes.length;
  // 先丢过期的，再从最早放进去的开始丢，直到不超过上限（刚放进去的留着）
  for (const [old, entry] of bytesCache) {
    if (old === key) continue;
    if (total <= BYTES_CACHE_MAX && Date.now() - entry.at < BYTES_TTL_MS) continue;
    bytesCache.delete(old);
    total -= entry.bytes.length;
  }
}

/** 读整个文件的字节（任何类型）；同一文件 10 分钟内大小与修改时间都没变时用缓存 */
export async function readBytes(server: ServerConfig, path: string, maxBytes = READ_MAX_BYTES): Promise<BinaryFile> {
  const info = await statRemote(server, path);
  if (!info) throw new UsageError(`${path} does not exist on ${server.name}`);
  if (info.kind === 'dir') throw new UsageError(`${info.path} is a directory; use list_dir`);
  if (info.size > maxBytes) {
    throw new UsageError(`${info.path} is ${info.size} bytes, over the ${Math.round(maxBytes / 1048576)} MB limit: move it with copy, or split it on the server (split) and read the pieces`);
  }
  const key = `${server.id}\u0000${info.path}`;
  const cached = bytesCache.get(key);
  if (cached && info.mtime && cached.info.mtime === info.mtime && cached.info.size === info.size && Date.now() - cached.at < BYTES_TTL_MS) {
    rememberBytes(key, cached);
    return cached;
  }
  const bytes = info.size ? await downloadBytes(server, info.path, maxBytes) : new Uint8Array();
  const file = { info: { ...info, size: bytes.length }, bytes, sha256: sha256Hex(bytes) };
  if (info.mtime) rememberBytes(key, file);
  return file;
}

/** 写过的文件从缓存里拿掉（修改时间的精度不够时也不会读到旧的） */
function forgetBytes(server: ServerConfig, path: string): void {
  bytesCache.delete(`${server.id}\u0000${path}`);
}

/** base64（也认 base64url，忽略空白），不合法就报错；allowTail 时末尾凑不满 4 个字符的部分不解，留给下一段 */
export function decodeBase64(text: string, allowTail = false): { bytes: Uint8Array; tail: string } {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new UsageError('content is not valid base64');
  const usable = allowTail && !clean.endsWith('=') ? clean.length - (clean.length % 4) : clean.length;
  const head = clean.slice(0, usable);
  if (head.length % 4 === 1) throw new UsageError('content is not valid base64 (invalid length; part of it may be missing)');
  return { bytes: new Uint8Array(Buffer.from(head, 'base64')), tail: clean.slice(usable) };
}

export interface TextFile {
  info: RemoteFileInfo;
  text: string;
  sha256: string;
}

/** 读文本文件（UTF-8）；strict 时内容不是合法 UTF-8 就拒绝（改文件时用，免得写回时把字节改坏） */
export async function readText(server: ServerConfig, path: string, maxBytes = READ_MAX_BYTES, strict = false): Promise<TextFile> {
  const info = await statRemote(server, path);
  if (!info) throw new UsageError(`${path} does not exist on ${server.name}`);
  if (info.kind === 'dir') throw new UsageError(`${info.path} is a directory; use list_dir`);
  if (info.size > maxBytes) {
    throw new UsageError(`${info.path} is ${info.size} bytes, over the ${Math.round(maxBytes / 1048576)} MB limit: view the parts you need with exec grep / tail / head / sed -n`);
  }
  const bytes = info.size ? await downloadBytes(server, info.path, maxBytes) : new Uint8Array();
  if (bytes.subarray(0, 8192).includes(0)) throw new UsageError(`${info.path} is binary (${bytes.length} bytes); inspect it with exec file / strings / xxd`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: strict }).decode(bytes);
  } catch {
    throw new UsageError(`${info.path} is not UTF-8 text and cannot be edited as text; use exec`);
  }
  return { info, text, sha256: sha256Hex(bytes) };
}

/** 按行切出 [offset, offset+limit) 并编号（cat -n 的样子），超长的行截断 */
export function numberLines(text: string, offset: number, limit: number): { body: string; total: number; from: number; to: number } {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = text === '' ? 0 : lines.length;
  const from = Math.min(Math.max(1, offset), Math.max(1, total));
  const to = Math.min(total, from + limit - 1);
  const width = String(to).length;
  const body = lines
    .slice(from - 1, to)
    .map((line, index) => {
      const shown = line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…[line is ${line.length} chars; rest omitted]` : line;
      return `${String(from + index).padStart(width)}\t${shown.replace(/\r$/, '')}`;
    })
    .join('\n');
  return { body, total, from, to };
}

export type WriteMode = 'overwrite' | 'append' | 'create';

export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

/**
 * 写文件：mode 为 overwrite（覆盖，默认）、append（追加）、create（已存在就不写）；目录不存在时建好。
 * expectSha256：写之前核对现有文件的 SHA-256（改文件时用，读过之后被别人改过就不写）。
 * mayOverwrite：已有文件要被覆盖或追加时问一下（返回 false 就不写）
 */
export async function writeText(
  server: ServerConfig,
  path: string,
  content: string | Uint8Array,
  mode: WriteMode,
  options: { expectSha256?: string; mayOverwrite?: (path: string) => boolean } = {}
): Promise<WriteResult> {
  const bytes = typeof content === 'string' ? encoder.encode(content) : content;
  if (bytes.length > WRITE_MAX_BYTES) throw new UsageError(`Content is ${bytes.length} bytes, over the ${WRITE_MAX_BYTES / 1048576} MB limit: use upload or copy for large files`);
  let where: string;
  try {
    where = await run(
      server,
      `p=${shellPath(path)}; case "$p" in /*) ;; *) p="$PWD/$p";; esac; if [ -d "$p" ]; then echo dir; exit 4; fi;` +
        ` mkdir -p -- "$(dirname -- "$p")" || exit 5; if [ -e "$p" ]; then echo exists; else echo new; fi;` +
        ` r=$(readlink -f -- "$p" 2>/dev/null) || r="$p"; printf '%s\\n' "$r"`
    );
  } catch (error) {
    if (/\bdir\b|exit 4\b/.test((error as Error).message)) throw new UsageError(`${path} is a directory`);
    throw error;
  }
  const lines = where.trim().split('\n').map((line) => line.trim());
  const exists = lines[0] === 'exists';
  const dest = lines[lines.length - 1];
  if (exists && mode === 'create') throw new UsageError(`${dest} already exists on ${server.name}; not written (mode: create only creates new files)`);
  if (exists && options.mayOverwrite && !options.mayOverwrite(dest)) throw new UsageError(`${dest} already exists on ${server.name}; not written`);

  const temp = `${dest}.cs-part-${randomBytes(4).toString('hex')}`;
  const sftp = await openSftp(server);
  try {
    await sftp.upload(temp, new Blob([bytes as BlobPart]));
  } finally {
    sftp.close();
  }
  const check = options.expectSha256
    ? `[ -f "$f" ] && [ "$(sha256sum < "$f" | cut -c1-64)" = ${quote(options.expectSha256)} ] || { rm -f "$t"; echo "modified since read; not written"; exit 9; };`
    : '';
  const guard = mode === 'create' ? `if [ -e "$f" ]; then rm -f "$t"; echo "already exists; not written"; exit 8; fi;` : '';
  const finish =
    mode === 'append'
      ? `cat "$t" >> "$f"; rc=$?; rm -f "$t"; exit $rc`
      : `if [ -e "$f" ]; then m=$(stat -c %a "$f" 2>/dev/null) && chmod "$m" "$t"; o=$(stat -c %u:%g "$f" 2>/dev/null) && chown "$o" "$t" 2>/dev/null; fi; mv -f "$t" "$f"`;
  try {
    await run(server, `t=${quote(temp)}; f=${quote(dest)}; ${check}${guard}${finish}`);
  } catch (error) {
    await run(server, `rm -f ${quote(temp)}`).catch(() => undefined);
    const message = (error as Error).message;
    if (/modified since read|exit 9\b/.test(message)) throw new UsageError(`${dest} changed after it was read; not written. Read it again, then edit.`);
    if (/already exists|exit 8\b/.test(message)) throw new UsageError(`${dest} already exists on ${server.name}; not written (mode: create only creates new files)`);
    throw error;
  } finally {
    forgetBytes(server, dest);
  }
  return { path: dest, bytes: bytes.length, created: !exists };
}

// ---------- 分段写入 ----------

/**
 * 内容太长、AI 一次调用放不下（客户端对单次工具调用的长度有上限）时按顺序分几段写：前面的段先攒在目标旁边的
 * <文件>.cs-upload 里，最后一段到了才一次性换成目标（覆盖时保留原来的权限和属主），中途断了原文件不受影响。
 * 每个进程按“服务器 + 路径”记着写到第几段；顺序不对、超时（30 分钟）或进程重启过就要从第 1 段重来
 */
interface PartState {
  dest: string;
  stage: string;
  mode: WriteMode;
  parts: number;
  next: number;
  bytes: number;
  created: boolean;
  at: number;
  encoding: 'utf8' | 'base64';
  /** base64 分段时上一段末尾凑不满 4 个字符的部分 */
  carry: string;
}

const PART_TTL_MS = 30 * 60_000;
const partStates = new Map<string, PartState>();

export interface PartResult extends WriteResult {
  /** 最后一段写完、目标已经换好 */
  done: boolean;
  /** 已经收到几段 */
  received: number;
}

export async function writeTextPart(
  server: ServerConfig,
  path: string,
  content: string,
  part: number,
  parts: number,
  mode: WriteMode,
  options: { mayOverwrite?: (path: string) => boolean; encoding?: 'utf8' | 'base64' } = {}
): Promise<PartResult> {
  const key = `${server.id}\u0000${path}`;
  const encoding = options.encoding ?? 'utf8';
  let state = partStates.get(key);
  if (state && Date.now() - state.at > PART_TTL_MS) {
    partStates.delete(key);
    await run(server, `rm -f ${quote(state.stage)}`).catch(() => undefined);
    state = undefined;
  }
  if (part === 1) {
    if (state) await run(server, `rm -f ${quote(state.stage)}`).catch(() => undefined);
    partStates.delete(key);
    const where = await run(
      server,
      `p=${shellPath(path)}; case "$p" in /*) ;; *) p="$PWD/$p";; esac; if [ -d "$p" ]; then echo dir; exit 4; fi;` +
        ` mkdir -p -- "$(dirname -- "$p")" || exit 5; if [ -e "$p" ]; then echo exists; else echo new; fi;` +
        ` r=$(readlink -f -- "$p" 2>/dev/null) || r="$p"; printf '%s\\n' "$r"`
    ).catch((error: Error) => {
      if (/\bdir\b|exit 4\b/.test(error.message)) throw new UsageError(`${path} is a directory`);
      throw error;
    });
    const lines = where.trim().split('\n').map((line) => line.trim());
    const exists = lines[0] === 'exists';
    const dest = lines[lines.length - 1];
    if (exists && mode === 'create') throw new UsageError(`${dest} already exists on ${server.name}; not written (mode: create only creates new files)`);
    if (exists && options.mayOverwrite && !options.mayOverwrite(dest)) throw new UsageError(`${dest} already exists on ${server.name}; not written`);
    state = { dest, stage: `${dest}.cs-upload`, mode, parts, next: 1, bytes: 0, created: !exists, at: Date.now(), encoding, carry: '' };
  } else if (!state) {
    throw new UsageError(`No multi-part write in progress for ${path} (part 1 was never sent, it expired after 30 minutes, or the connector restarted): start again from part 1`);
  } else if (part !== state.next || parts !== state.parts || mode !== state.mode || encoding !== state.encoding) {
    throw new UsageError(
      `${path} expects part ${state.next}/${state.parts} (mode ${state.mode}, encoding ${state.encoding}) but got part ${part}/${parts}: send the parts in order, or start again from part 1`
    );
  }
  // base64 的段可以在任意位置切开：凑不满 4 个字符的尾巴接到下一段前面再解
  let bytes: Uint8Array;
  if (encoding === 'base64') {
    const decoded = decodeBase64(state.carry + content, part < parts);
    bytes = decoded.bytes;
    state.carry = decoded.tail;
  } else {
    bytes = encoder.encode(content);
  }
  if (state.bytes + bytes.length > WRITE_MAX_BYTES) {
    partStates.delete(key);
    await run(server, `rm -f ${quote(state.stage)}`).catch(() => undefined);
    throw new UsageError(`The parts together exceed ${WRITE_MAX_BYTES / 1048576} MB: use upload or copy for large files`);
  }

  // 这一段先传到临时文件，再接到 .cs-upload 后面（第 1 段直接成为 .cs-upload）
  const temp = `${state.stage}.${randomBytes(4).toString('hex')}`;
  const sftp = await openSftp(server);
  try {
    await sftp.upload(temp, new Blob([bytes as BlobPart]));
  } finally {
    sftp.close();
  }
  const stage = quote(state.stage);
  try {
    await run(server, `t=${quote(temp)}; f=${stage}; ${part === 1 ? 'mv -f "$t" "$f"' : 'cat "$t" >> "$f"; rc=$?; rm -f "$t"; exit $rc'}`);
  } catch (error) {
    partStates.delete(key);
    await run(server, `rm -f ${quote(temp)} ${stage}`).catch(() => undefined);
    throw error;
  }
  state.bytes += bytes.length;
  state.next = part + 1;
  state.at = Date.now();

  if (part < parts) {
    partStates.set(key, state);
    return { path: state.dest, bytes: state.bytes, created: state.created, done: false, received: part };
  }
  partStates.delete(key);
  const guard = state.mode === 'create' ? `if [ -e "$f" ]; then rm -f "$t"; echo "already exists; not written"; exit 8; fi;` : '';
  const finish =
    state.mode === 'append'
      ? `cat "$t" >> "$f"; rc=$?; rm -f "$t"; exit $rc`
      : `if [ -e "$f" ]; then m=$(stat -c %a "$f" 2>/dev/null) && chmod "$m" "$t"; o=$(stat -c %u:%g "$f" 2>/dev/null) && chown "$o" "$t" 2>/dev/null; fi; mv -f "$t" "$f"`;
  try {
    await run(server, `t=${stage}; f=${quote(state.dest)}; ${guard}${finish}`);
  } catch (error) {
    await run(server, `rm -f ${stage}`).catch(() => undefined);
    if (/already exists|exit 8\b/.test((error as Error).message)) throw new UsageError(`${state.dest} already exists on ${server.name}; not written (mode: create only creates new files)`);
    throw error;
  } finally {
    forgetBytes(server, state.dest);
  }
  return { path: state.dest, bytes: state.bytes, created: state.created, done: true, received: part };
}

export interface EditResult {
  path: string;
  replaced: number;
  /** 第一处修改附近的几行（改后，带行号） */
  snippet: string;
}

/** 精确替换：old 要在文件里唯一（replaceAll 时替换全部）；写回前核对文件没被别人改过 */
export async function editText(
  server: ServerConfig,
  path: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  mayOverwrite?: (path: string) => boolean
): Promise<EditResult> {
  if (!oldText) throw new UsageError('old_string must not be empty');
  if (oldText === newText) throw new UsageError('old_string and new_string are identical; nothing to change');
  const file = await readText(server, path, WRITE_MAX_BYTES, true);
  const count = file.text.split(oldText).length - 1;
  if (!count) throw new UsageError(`old_string not found in ${file.info.path} (spaces, indentation and line breaks must match exactly; check the text with read_file)`);
  if (count > 1 && !replaceAll) throw new UsageError(`old_string occurs ${count} times in ${file.info.path}: include more surrounding lines to make it unique, or set replace_all: true`);
  const first = file.text.indexOf(oldText);
  // 不用 String.replace：new_string 里的 $& 之类会被当成替换模式
  const updated = replaceAll ? file.text.split(oldText).join(newText) : file.text.slice(0, first) + newText + file.text.slice(first + oldText.length);
  const result = await writeText(server, file.info.path, updated, 'overwrite', { expectSha256: file.sha256, mayOverwrite });
  const line = file.text.slice(0, first).split('\n').length;
  const span = newText.split('\n').length;
  const snippet = numberLines(updated, Math.max(1, line - 2), span + 4).body;
  return { path: result.path, replaced: replaceAll ? count : 1, snippet };
}

/** 列目录：ls -l（GNU 时用 ISO 时间、目录在前），最多 1000 项 */
export async function listDir(server: ServerConfig, path: string, all: boolean): Promise<string> {
  const flags = all ? '-lA' : '-l';
  try {
    return await run(
      server,
      `p=${shellPath(path)}; cd -- "$p" 2>/dev/null || { echo "no such directory: $p"; exit 3; }; pwd -P;` +
        ` { ls ${flags} --time-style=long-iso --group-directories-first 2>/dev/null || ls ${flags}; } | head -n 1001`
    );
  } catch (error) {
    if (/no such directory|exit 3\b/.test((error as Error).message)) throw new UsageError(`Directory ${path} does not exist on ${server.name}`);
    throw error;
  }
}

// ---------- 后台任务 ----------

const JOBS = '"$HOME/.cloudssh-jobs"';
const JOB_ID = /^j[a-z0-9]{6,24}$/;

export function newJobId(): string {
  return `j${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/** 起后台任务，返回任务号；cwd 为空时在登录用户的家目录 */
export async function startJob(server: ServerConfig, command: string, cwd?: string): Promise<string> {
  const id = newJobId();
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  const output = await run(
    server,
    `d=${JOBS}; mkdir -p "$d" && chmod 700 "$d" || exit 5; id=${quote(id)};` +
      ` printf '%s' ${quote(encoded)} | base64 -d > "$d/$id.cmd" || exit 5;` +
      (cwd ? ` cd -- ${shellPath(cwd)} || { echo "no such directory: ${cwd.replace(/["$`\\]/g, '')}"; exit 3; };` : ' cd;') +
      ` sh_=$(command -v bash || command -v sh); s=; command -v setsid >/dev/null 2>&1 && s=setsid;` +
      ` $s nohup "$sh_" -c 'echo $$ > "$1/$2.pid"; "$0" "$1/$2.cmd" > "$1/$2.log" 2>&1; echo $? > "$1/$2.exit"' "$sh_" "$d" "$id" > /dev/null 2>&1 < /dev/null &` +
      ` sleep 0.3; find "$d" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null; printf 'started %s\\n' "$id"`
  ).catch((error: Error) => {
    if (/no such directory|exit 3\b/.test(error.message)) throw new UsageError(`Directory ${cwd} does not exist on ${server.name}`);
    throw error;
  });
  if (!output.includes(`started ${id}`)) throw new Error(`${server.name}: the background job did not start`);
  return id;
}

/** 任务状态与输出末尾；stop 时先结束整个进程组。没有任务号时列出最近 20 个任务 */
export async function jobStatus(server: ServerConfig, id: string | undefined, tail: number, stop: boolean): Promise<string> {
  const state =
    `if [ -f "$d/$id.exit" ]; then e=$(cat "$d/$id.exit"); if [ "$e" = stopped ]; then echo "state: stopped by job_status"; else echo "state: finished, exit $e"; fi;` +
    ` elif kill -0 "$(cat "$d/$id.pid" 2>/dev/null)" 2>/dev/null; then echo "state: running (pid $(cat "$d/$id.pid"))";` +
    ` else echo "state: process gone without an exit code (killed, or the server rebooted)"; fi`;
  if (!id) {
    return run(
      server,
      `d=${JOBS}; n=0; for c in $(ls -t "$d"/*.cmd 2>/dev/null | head -n 20); do id=$(basename "$c" .cmd); n=$((n+1));` +
        ` s=$( ${state} ); printf '%s  %s  %s\\n' "$id" "\${s#state: }" "$(head -c 100 "$c" | tr '\\n' ' ')"; done; [ "$n" = 0 ] && echo "(no background jobs)"; true`
    );
  }
  if (!JOB_ID.test(id)) throw new UsageError(`Invalid job_id ${id}: use the ID start_job returned (starts with j)`);
  // 停止：先 TERM 整个进程组，1 秒后还在就 KILL；结束后记成 stopped（被结束的进程来不及写退出码）
  const stopping = stop
    ? ` if [ ! -f "$d/$id.exit" ]; then p=$(cat "$d/$id.pid" 2>/dev/null); if [ -n "$p" ]; then kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; sleep 1;` +
      ` kill -0 "$p" 2>/dev/null && { kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; sleep 0.5; }; fi; [ -f "$d/$id.exit" ] || echo stopped > "$d/$id.exit"; fi;`
    : '';
  try {
    return await run(
      server,
      `d=${JOBS}; id=${quote(id)}; [ -f "$d/$id.cmd" ] || { echo "no such job"; exit 3; };${stopping} ${state};` +
        ` echo "== command"; head -c 500 "$d/$id.cmd"; echo; echo "== output (last ${tail} lines)"; tail -n ${tail} "$d/$id.log" 2>/dev/null`
    );
  } catch (error) {
    if (/no such job|exit 3\b/.test((error as Error).message)) throw new UsageError(`No job ${id} on ${server.name} (job files are deleted after 7 days)`);
    throw error;
  }
}
