import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { appendRotatingLog } from './rotating-log';

type Level = 'debug' | 'info' | 'warn' | 'error';

const DEBUG = process.env.CLOUDSSH_DEBUG === '1' || !app.isPackaged;

let logFile: string | null = null;

export function logFilePath(): string {
  if (!logFile) {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
  }
  return logFile;
}

function write(level: Level, scope: string, args: unknown[]): void {
  if (level === 'debug' && !DEBUG) return;
  const text = args.map((arg) => {
    try { return arg instanceof Error ? arg.stack ?? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg); }
    catch { return '[unserializable]'; }
  }).join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  try {
    appendRotatingLog(logFilePath(), line);
  } catch {
    // 日志失败不影响主流程
  }
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => write('debug', scope, args),
    info: (...args: unknown[]) => write('info', scope, args),
    warn: (...args: unknown[]) => write('warn', scope, args),
    error: (...args: unknown[]) => write('error', scope, args),
  };
}

export const isDebug = DEBUG;
