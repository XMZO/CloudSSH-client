/** 终端交互：问一行、问密码（不回显）、确认 */
import readline from 'node:readline';

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
