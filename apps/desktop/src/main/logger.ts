import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const DEBUG = process.env.CLOUDSSH_DEBUG === '1' || !app.isPackaged;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

let logFile: string | null = null;

export function logFilePath(): string {
  if (!logFile) {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    try {
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // 首次运行没有日志文件
    }
  }
  return logFile;
}

function write(level: Level, scope: string, args: unknown[]): void {
  if (level === 'debug' && !DEBUG) return;
  const text = args
    .map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  try {
    fs.appendFileSync(logFilePath(), `${line}\n`);
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
