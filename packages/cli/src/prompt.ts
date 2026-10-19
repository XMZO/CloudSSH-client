/** 终端交互：问一行、问密码（不回显）、确认；exec 的命令来源（标准输入、文件） */
import fs from 'node:fs';
import readline from 'node:readline';
import tty from 'node:tty';
import { UsageError } from './config';

let keyboard: tty.ReadStream | null | undefined;

/**
 * 读键盘的流。标准输入是终端就用它；用 CloudSSH 客户端当运行时（Electron 是图形界面程序）时，标准输入接不上
 * 控制台，但进程挂在调用它的控制台上（标准输出、错误是终端），这时直接打开控制台输入 CONIN$。
 * 标准错误不是终端（AI 工具、脚本在收集输出）时一律不算交互，免得等一个没人回答的提问
 */
function keyboardInput(): tty.ReadStream | null {
  if (keyboard !== undefined) return keyboard;
  keyboard = null;
  if (!process.stderr.isTTY) return keyboard;
  if (process.stdin.isTTY) return (keyboard = process.stdin as tty.ReadStream);
  if (process.platform === 'win32') {
    try {
      const fd = fs.openSync(String.raw`\\.\CONIN$`, 'r+');
      if (tty.isatty(fd)) keyboard = new tty.ReadStream(fd);
      else fs.closeSync(fd);
    } catch {
      // 没有控制台
    }
  }
  return keyboard;
}

export const interactive = (): boolean => !!keyboardInput();

function requireKeyboard(): tty.ReadStream {
  const input = keyboardInput();
  if (!input) throw new UsageError('这一步要在终端里输入');
  return input;
}

export function ask(question: string): Promise<string> {
  const input = requireKeyboard();
  const rl = readline.createInterface({ input, output: process.stderr, terminal: true });
  return new Promise((resolve, reject) => {
    // Ctrl+C：readline 收到后关掉自己，这里当作取消
    rl.on('SIGINT', () => {
      rl.close();
      process.stderr.write('\n');
      reject(new Error('已取消'));
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function askSecret(question: string): Promise<string> {
  const stdin = requireKeyboard();
  return new Promise((resolve, reject) => {
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
