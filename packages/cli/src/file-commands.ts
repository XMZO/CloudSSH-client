/**
 * 命令行的 cloudssh read / write / edit：与 MCP 的 read_file / write_file / edit_file 用同一套 SFTP 读写（remote-files.ts），
 * 不经过远端 shell 的引号与 heredoc。同一份逻辑在本进程或后台会话进程（agent.ts）里执行。
 * 改已有文件（write 覆盖或追加、edit）与危险命令一样要 --yes（confirm 为 never 时不用）：没有时抛 ConfirmNeeded，
 * 终端里直接问，其他情况报错，让 AI 先问用户再带 --yes 重来
 */
import fs from 'node:fs';
import type { ServerConfig } from '@cloudssh/core';
import { UsageError } from './config';
import { editText, readBytes, WRITE_MAX_BYTES, writeText, type WriteMode } from './remote-files';
import { hostId } from './targets';

/** read 默认一次给多少行（与 MCP 的 read_file 一样） */
export const READ_LINES = 2000;

export type FileRequest =
  | { action: 'read'; spec: string; path: string; offset: number; limit: number }
  | { action: 'write'; spec: string; path: string; content: string; mode: WriteMode; allowed: boolean }
  | { action: 'edit'; spec: string; path: string; old: string; new: string; all: boolean; allowed: boolean };

interface Base {
  /** 主机 ID */
  server: string;
  name: string;
  /** 绝对路径（符号链接已解析） */
  path: string;
}

export interface ReadResult extends Base {
  action: 'read';
  size: number;
  sha256: string;
  /** 文件一共几行；from–to 是这次给出的行（一行都没有时都是 0） */
  lines: number;
  from: number;
  to: number;
  content: string;
}

export interface WriteFileResult extends Base {
  action: 'write';
  bytes: number;
  created: boolean;
  mode: WriteMode;
}

export interface EditFileResult extends Base {
  action: 'edit';
  replaced: number;
  /** 第一处修改附近的几行（改后，带行号） */
  snippet: string;
}

export type FileResult = ReadResult | WriteFileResult | EditFileResult;

/** 要改已有文件，但没有 --yes */
export class ConfirmNeeded extends Error {
  constructor(
    readonly server: string,
    readonly dest: string,
    readonly action: 'write' | 'edit'
  ) {
    super(
      action === 'edit'
        ? `Not changed: editing ${dest} on ${server} needs --yes. Ask the user, then rerun with --yes`
        : `Not changed: ${dest} already exists on ${server}, so overwriting or appending needs --yes. Ask the user, then rerun with --yes`
    );
  }
}

/** [offset, offset+limit) 这几行的原文（行尾照旧），以及文件一共几行 */
export function sliceLines(text: string, offset: number, limit: number): { lines: number; from: number; to: number; content: string } {
  let lines = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lines++;
  if (text && !text.endsWith('\n')) lines++;
  let start = 0;
  for (let line = 1; line < offset && start < text.length; line++) {
    const newline = text.indexOf('\n', start);
    start = newline < 0 ? text.length : newline + 1;
  }
  let end = start;
  let count = 0;
  while (count < limit && end < text.length) {
    const newline = text.indexOf('\n', end);
    end = newline < 0 ? text.length : newline + 1;
    count++;
  }
  return { lines, from: count ? offset : 0, to: count ? offset + count - 1 : 0, content: text.slice(start, end) };
}

export async function runFileOp(server: ServerConfig, request: FileRequest): Promise<FileResult> {
  const base = { server: hostId(server), name: server.name };
  const label = `${hostId(server)} ${server.name}`;
  if (request.action === 'read') {
    const file = await readBytes(server, request.path);
    if (file.bytes.subarray(0, 8192).includes(0)) {
      throw new UsageError(`${file.info.path} is binary (${file.bytes.length} bytes): use cloudssh download, then open it locally (your own file tools can show images)`);
    }
    const part = sliceLines(new TextDecoder().decode(file.bytes), request.offset, request.limit);
    return { action: 'read', ...base, path: file.info.path, size: file.bytes.length, sha256: file.sha256, ...part };
  }
  const action = request.action;
  const mayChange = (dest: string): boolean => {
    if (request.allowed) return true;
    throw new ConfirmNeeded(label, dest, action);
  };
  if (request.action === 'write') {
    const result = await writeText(server, request.path, request.content, request.mode, { mayOverwrite: mayChange });
    return { action: 'write', ...base, path: result.path, bytes: result.bytes, created: result.created, mode: request.mode };
  }
  const result = await editText(server, request.path, request.old, request.new, request.all, mayChange);
  return { action: 'edit', ...base, path: result.path, replaced: result.replaced, snippet: result.snippet };
}

/** 本机的文本文件（write --file、edit --old-file / --new-file）：UTF-8，去掉开头的 BOM */
export function readLocalText(file: string): string {
  let bytes: Buffer;
  try {
    if (fs.statSync(file).size > WRITE_MAX_BYTES) throw new UsageError(`${file} is over ${WRITE_MAX_BYTES / 1048576} MB: use cloudssh upload`);
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${file}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    throw new UsageError(`${file} is not UTF-8 text: use cloudssh upload for other files`);
  }
}

/** 命令行给的文字：Windows 的工具常带 CRLF，服务器上的文本一律用 LF */
export const unixText = (text: string): string => text.replace(/\r\n/g, '\n');
