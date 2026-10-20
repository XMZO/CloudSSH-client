/**
 * 服务器上的文件与后台任务（MCP 的 read_file / list_dir / write_file / edit_file / start_job / job_status）。
 *
 * 文件内容走 SFTP（与 upload / download 同一条通道）：不受命令输出 64KB 的限制，写入不经过 Shell 转义。
 * - 读：先查类型、大小与真实路径（跟随符号链接），再整个下载到内存（上限 20MB），按行切出要看的部分；二进制文件不读
 * - 写：先传到同目录的临时文件，再改名过去；覆盖已有文件时沿用原来的权限与属主（stat -c），符号链接写到它指向的文件
 * - 改（精确替换）：读出来、在内存里替换、写回；写回前核对文件的 SHA-256 与读时一致，被别人改过就不写
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
}

/** 查类型、大小与真实路径；不存在返回 null */
export async function statRemote(server: ServerConfig, path: string): Promise<RemoteFileInfo | null> {
  let output: string;
  try {
    output = await run(
      server,
      `p=${shellPath(path)}; if [ -d "$p" ]; then echo dir; elif [ -f "$p" ]; then echo file; else echo missing; exit 3; fi;` +
        ` if [ -f "$p" ]; then wc -c < "$p"; else echo 0; fi;` +
        ` r=$(readlink -f -- "$p" 2>/dev/null) || r=$(cd "$(dirname -- "$p")" && printf '%s/%s' "$(pwd -P)" "$(basename -- "$p")"); printf '%s\\n' "$r"`
    );
  } catch (error) {
    if (/missing|退出码 3/.test((error as Error).message)) return null;
    throw error;
  }
  const lines = output.trim().split('\n').map((line) => line.trim());
  return { kind: lines[0] === 'dir' ? 'dir' : 'file', size: Number(lines[1]) || 0, path: lines[lines.length - 1] };
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

export interface TextFile {
  info: RemoteFileInfo;
  text: string;
  sha256: string;
}

/** 读文本文件（UTF-8）；strict 时内容不是合法 UTF-8 就拒绝（改文件时用，免得写回时把字节改坏） */
export async function readText(server: ServerConfig, path: string, maxBytes = READ_MAX_BYTES, strict = false): Promise<TextFile> {
  const info = await statRemote(server, path);
  if (!info) throw new UsageError(`${server.name} 上没有 ${path}`);
  if (info.kind === 'dir') throw new UsageError(`${info.path} 是目录：用 list_dir 查看`);
  if (info.size > maxBytes) {
    throw new UsageError(`${info.path} 有 ${info.size} 字节，超过 ${Math.round(maxBytes / 1048576)}MB：用 exec 配合 grep / tail / head / sed -n 看需要的部分`);
  }
  const bytes = info.size ? await downloadBytes(server, info.path, maxBytes) : new Uint8Array();
  if (bytes.subarray(0, 8192).includes(0)) throw new UsageError(`${info.path} 是二进制文件（${bytes.length} 字节）：用 exec 配合 file、strings、xxd 查看`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: strict }).decode(bytes);
  } catch {
    throw new UsageError(`${info.path} 不是 UTF-8 文本，不能按文字修改：用 exec 处理`);
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
      const shown = line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…（这一行有 ${line.length} 个字符，后面省略）` : line;
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
  content: string,
  mode: WriteMode,
  options: { expectSha256?: string; mayOverwrite?: (path: string) => boolean } = {}
): Promise<WriteResult> {
  const bytes = encoder.encode(content);
  if (bytes.length > WRITE_MAX_BYTES) throw new UsageError(`内容有 ${bytes.length} 字节，超过 ${WRITE_MAX_BYTES / 1048576}MB：大文件用 upload 或 copy`);
  let where: string;
  try {
    where = await run(
      server,
      `p=${shellPath(path)}; case "$p" in /*) ;; *) p="$PWD/$p";; esac; if [ -d "$p" ]; then echo dir; exit 4; fi;` +
        ` mkdir -p -- "$(dirname -- "$p")" || exit 5; if [ -e "$p" ]; then echo exists; else echo new; fi;` +
        ` r=$(readlink -f -- "$p" 2>/dev/null) || r="$p"; printf '%s\\n' "$r"`
    );
  } catch (error) {
    if (/\bdir\b|退出码 4/.test((error as Error).message)) throw new UsageError(`${path} 是目录`);
    throw error;
  }
  const lines = where.trim().split('\n').map((line) => line.trim());
  const exists = lines[0] === 'exists';
  const dest = lines[lines.length - 1];
  if (exists && mode === 'create') throw new UsageError(`${server.name} 上已有 ${dest}，没有写入（mode: create 只建新文件）`);
  if (exists && options.mayOverwrite && !options.mayOverwrite(dest)) throw new UsageError(`${server.name} 上已有 ${dest}，没有写入`);

  const temp = `${dest}.cs-part-${randomBytes(4).toString('hex')}`;
  const sftp = await openSftp(server);
  try {
    await sftp.upload(temp, new Blob([bytes as BlobPart]));
  } finally {
    sftp.close();
  }
  const check = options.expectSha256
    ? `[ -f "$f" ] && [ "$(sha256sum < "$f" | cut -c1-64)" = ${quote(options.expectSha256)} ] || { rm -f "$t"; echo "文件在读取之后被改过，没有写入"; exit 9; };`
    : '';
  const guard = mode === 'create' ? `if [ -e "$f" ]; then rm -f "$t"; echo "已存在，没有写入"; exit 8; fi;` : '';
  const finish =
    mode === 'append'
      ? `cat "$t" >> "$f"; rc=$?; rm -f "$t"; exit $rc`
      : `if [ -e "$f" ]; then m=$(stat -c %a "$f" 2>/dev/null) && chmod "$m" "$t"; o=$(stat -c %u:%g "$f" 2>/dev/null) && chown "$o" "$t" 2>/dev/null; fi; mv -f "$t" "$f"`;
  try {
    await run(server, `t=${quote(temp)}; f=${quote(dest)}; ${check}${guard}${finish}`);
  } catch (error) {
    await run(server, `rm -f ${quote(temp)}`).catch(() => undefined);
    const message = (error as Error).message;
    if (/被改过|退出码 9/.test(message)) throw new UsageError(`${dest} 在读取之后被改过，没有写入：重新读一遍再改`);
    if (/已存在|退出码 8/.test(message)) throw new UsageError(`${server.name} 上已有 ${dest}，没有写入（mode: create 只建新文件）`);
    throw error;
  }
  return { path: dest, bytes: bytes.length, created: !exists };
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
  if (!oldText) throw new UsageError('old_string 不能是空的');
  if (oldText === newText) throw new UsageError('old_string 与 new_string 一样，不用改');
  const file = await readText(server, path, WRITE_MAX_BYTES, true);
  const count = file.text.split(oldText).length - 1;
  if (!count) throw new UsageError(`${file.info.path} 里没有找到 old_string（空格、缩进、换行都要完全一致；先用 read_file 看原文）`);
  if (count > 1 && !replaceAll) throw new UsageError(`${file.info.path} 里有 ${count} 处 old_string：多带几行上下文让它唯一，或者 replace_all: true 全部替换`);
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
      `p=${shellPath(path)}; cd -- "$p" 2>/dev/null || { echo "没有这个目录：$p"; exit 3; }; pwd -P;` +
        ` { ls ${flags} --time-style=long-iso --group-directories-first 2>/dev/null || ls ${flags}; } | head -n 1001`
    );
  } catch (error) {
    if (/没有这个目录|退出码 3/.test((error as Error).message)) throw new UsageError(`${server.name} 上没有目录 ${path}`);
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
      (cwd ? ` cd -- ${shellPath(cwd)} || { echo "没有这个目录：${cwd.replace(/["$`\\]/g, '')}"; exit 3; };` : ' cd;') +
      ` sh_=$(command -v bash || command -v sh); s=; command -v setsid >/dev/null 2>&1 && s=setsid;` +
      ` $s nohup "$sh_" -c 'echo $$ > "$1/$2.pid"; "$0" "$1/$2.cmd" > "$1/$2.log" 2>&1; echo $? > "$1/$2.exit"' "$sh_" "$d" "$id" > /dev/null 2>&1 < /dev/null &` +
      ` sleep 0.3; find "$d" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null; printf 'started %s\\n' "$id"`
  ).catch((error: Error) => {
    if (/没有这个目录|退出码 3/.test(error.message)) throw new UsageError(`${server.name} 上没有目录 ${cwd}`);
    throw error;
  });
  if (!output.includes(`started ${id}`)) throw new Error(`${server.name}: 没能启动后台任务`);
  return id;
}

/** 任务状态与输出末尾；stop 时先结束整个进程组。没有任务号时列出最近 20 个任务 */
export async function jobStatus(server: ServerConfig, id: string | undefined, tail: number, stop: boolean): Promise<string> {
  const state =
    `if [ -f "$d/$id.exit" ]; then e=$(cat "$d/$id.exit"); if [ "$e" = stopped ]; then echo "状态：已被 job_status 停止"; else echo "状态：已结束，退出码 $e"; fi;` +
    ` elif kill -0 "$(cat "$d/$id.pid" 2>/dev/null)" 2>/dev/null; then echo "状态：运行中（进程 $(cat "$d/$id.pid")）";` +
    ` else echo "状态：进程已不在，没有退出码（可能被结束或服务器重启过）"; fi`;
  if (!id) {
    return run(
      server,
      `d=${JOBS}; n=0; for c in $(ls -t "$d"/*.cmd 2>/dev/null | head -n 20); do id=$(basename "$c" .cmd); n=$((n+1));` +
        ` s=$( ${state} ); printf '%s  %s  %s\\n' "$id" "\${s#状态：}" "$(head -c 100 "$c" | tr '\\n' ' ')"; done; [ "$n" = 0 ] && echo "（没有后台任务）"; true`
    );
  }
  if (!JOB_ID.test(id)) throw new UsageError(`任务号不对：${id}（start_job 返回的 j 开头的编号）`);
  // 停止：先 TERM 整个进程组，1 秒后还在就 KILL；结束后记成 stopped（被结束的进程来不及写退出码）
  const stopping = stop
    ? ` if [ ! -f "$d/$id.exit" ]; then p=$(cat "$d/$id.pid" 2>/dev/null); if [ -n "$p" ]; then kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; sleep 1;` +
      ` kill -0 "$p" 2>/dev/null && { kill -KILL -- "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; sleep 0.5; }; fi; [ -f "$d/$id.exit" ] || echo stopped > "$d/$id.exit"; fi;`
    : '';
  try {
    return await run(
      server,
      `d=${JOBS}; id=${quote(id)}; [ -f "$d/$id.cmd" ] || { echo "没有这个任务"; exit 3; };${stopping} ${state};` +
        ` echo "== 命令"; head -c 500 "$d/$id.cmd"; echo; echo "== 输出（最后 ${tail} 行）"; tail -n ${tail} "$d/$id.log" 2>/dev/null`
    );
  } catch (error) {
    if (/没有这个任务|退出码 3/.test((error as Error).message)) throw new UsageError(`${server.name} 上没有任务 ${id}（任务文件 7 天后清理）`);
    throw error;
  }
}
