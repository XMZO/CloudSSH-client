import fs from 'node:fs';

export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const LOG_BACKUPS = 4;
const MAX_LINE_BYTES = 16 * 1024;
/** 已经查过旧版超大归档的日志文件：归档只在轮转时产生、不会超限，每个进程查一次就够 */
const checkedArchives = new Set<string>();

function size(name: string): number {
  try { return fs.statSync(name).size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** 只保留末尾 MAX_LOG_BYTES（从下一个整行开始），避免把超大文件搬进归档 */
function keepTail(name: string, bytes: number): void {
  const fd = fs.openSync(name, 'r+');
  try {
    const tail = Buffer.alloc(MAX_LOG_BYTES);
    const read = fs.readSync(fd, tail, 0, tail.length, bytes - tail.length);
    const newline = tail.indexOf(10);
    const retained = tail.subarray(newline >= 0 ? newline + 1 : 0, read);
    fs.writeSync(fd, retained, 0, retained.length, 0);
    fs.ftruncateSync(fd, retained.length);
  } finally { fs.closeSync(fd); }
}

/** 单主进程写入；每次追加前检查，长时间不退出也不会无限增长。 */
export function appendRotatingLog(file: string, line: string): void {
  const raw = Buffer.from(line.replace(/[\r\n]+/g, ' ') + '\n');
  const data = raw.length <= MAX_LINE_BYTES
    ? raw
    : Buffer.concat([raw.subarray(0, MAX_LINE_BYTES - 16), Buffer.from(' [truncated]\n')]);
  // 旧版本可能已经留下超大日志，只保留末尾。归档每个进程查一次；当前文件每次本来就要看大小，超了（旧版遗留、被外部追加）当场截尾
  if (!checkedArchives.has(file)) {
    for (let i = 1; i <= LOG_BACKUPS; i++) {
      const bytes = size(`${file}.${i}`);
      if (bytes > MAX_LOG_BYTES) keepTail(`${file}.${i}`, bytes);
    }
    checkedArchives.add(file);
  }
  let current = size(file);
  if (current > MAX_LOG_BYTES) {
    keepTail(file, current);
    current = size(file);
  }
  if (current + data.length > MAX_LOG_BYTES) {
    fs.rmSync(`${file}.${LOG_BACKUPS}`, { force: true });
    for (let i = LOG_BACKUPS - 1; i >= 0; i--) {
      const from = i ? `${file}.${i}` : file;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
  }
  // 轮转失败则由调用方放弃本条，不能继续向超限文件追加。
  fs.appendFileSync(file, data);
}
