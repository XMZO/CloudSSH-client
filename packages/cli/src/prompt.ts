/** 终端交互：问一行、问密码（不回显）、确认；exec 的命令来源（标准输入、文件） */
import fs from 'node:fs';
import readline from 'node:readline';
import { UsageError } from './config';

export const interactive = (): boolean => !!process.stdin.isTTY && !!process.stderr.isTTY;

export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function askSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = '';
    const done = (error?: Error) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('已取消'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function confirm(question: string): Promise<boolean> {
  return /^(y|yes|是|好)$/i.test(await ask(`${question} [y/N] `));
}

/**
 * 读完标准输入（exec --stdin）。去掉开头的 BOM：Windows PowerShell 5.1 经管道传给程序时会在前面加一个，
 * 留着会变成远程命令第一个词的一部分（“command not found”）
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

const MAX_COMMAND_FILE = 1024 * 1024;

/**
 * 从文件读命令（exec --file）：按 UTF-8 读，去掉开头的 BOM。不经过 shell 的引号与管道编码，
 * 只有 Windows PowerShell 5.1 或 cmd 的 AI 先用写文件工具把命令写进文件再执行，引号与中文都不会坏
 */
export function readCommandFile(file: string): string {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new UsageError(`读不到命令文件 ${file}`);
  }
  if (size > MAX_COMMAND_FILE) throw new UsageError(`命令文件太大（${size} 字节，最多 1MB）：大文件请用 upload 传上去再执行`);
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}
