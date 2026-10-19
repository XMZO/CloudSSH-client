/**
 * cloudssh exec：在一台或多台服务器上执行命令。
 * 复用客户端 AI 跨服务器操作的后台会话（ai-remote/session.ts）：Worker 用保存的凭据登录（跳板、CF 隧道照常），
 * 命令在非交互 Shell 里跑（没有 TTY、stdin 为空），只保留最后 64KB 输出，超时由服务器上的 timeout 结束。
 * 安全：拦截级命令（rm -rf / 之类）一律拒绝；危险命令（删除、关机、改权限……）要 --yes，在终端里会直接问；
 * config.json 的 confirm 设为 never 后不再确认。
 */
import type { ServerConfig } from '@cloudssh/core';
import { isBlockedCommand, needsConfirmation } from '../../ui-web/overrides/shared/ai-remote/safety';
import { remoteExec, RemoteError, type ExecResult } from '../../ui-web/overrides/shared/ai-remote/session';
import { UsageError, type ConfirmMode } from './config';
import { confirm, interactive } from './prompt';
import { eachLimited, hostId } from './targets';

export interface ExecOutcome {
  server: { id: string; name: string };
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

/** 危险命令的确认：返回 null 表示可以执行，否则是拒绝的原因 */
export async function checkCommand(command: string, yes: boolean, mode: ConfirmMode, what: string): Promise<void> {
  const blocked = isBlockedCommand(command);
  if (blocked.blocked) throw new UsageError(`拒绝执行（${blocked.reason ?? '拦截级命令'}）：${command}`);
  const risky = needsConfirmation(command);
  if (!risky.required || yes || mode === 'never') return;
  if (interactive() && (await confirm(`危险命令（${risky.reason ?? ''}）将在 ${what} 上执行：\n  ${command}\n确定执行？`))) return;
  throw new UsageError(`危险命令（${risky.reason ?? '需要确认'}）：确认后加 --yes 再执行`);
}

async function runOne(server: ServerConfig, command: string, timeout: number): Promise<ExecOutcome> {
  const base = { server: { id: hostId(server), name: server.name } };
  try {
    const result: ExecResult = await remoteExec(server.id, command, timeout);
    return { ...base, exitCode: result.exitCode, output: result.output, timedOut: result.timedOut, truncated: result.truncated, durationMs: result.durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = error instanceof RemoteError && error.code === 'closed';
    return { ...base, exitCode: null, output: '', timedOut: false, truncated: false, durationMs: 0, error: unknown ? `连接中断，执行状态未知：${message}` : message };
  }
}

export function runExec(servers: ServerConfig[], command: string, timeout: number, concurrency: number): Promise<ExecOutcome[]> {
  return eachLimited(servers, concurrency, (server) => runOne(server, command, timeout));
}

/** 单台：输出原样写到 stdout，退出码跟远端一致（超时 124、出错 255）；多台：每台一段，有失败时退出码 1 */
export function printOutcomes(results: ExecOutcome[], json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
  } else if (results.length === 1) {
    const [only] = results;
    if (only.output) process.stdout.write(only.output.endsWith('\n') ? only.output : `${only.output}\n`);
    if (only.error) process.stderr.write(`cloudssh: ${only.server.id} ${only.server.name}：${only.error}\n`);
    else if (only.timedOut) process.stderr.write(`cloudssh: 超时，命令已被结束\n`);
    if (only.truncated) process.stderr.write('cloudssh: 输出超过 64KB，只保留了最后一段\n');
  } else {
    for (const item of results) {
      const status = item.error ? `错误：${item.error}` : item.timedOut ? '超时' : `退出码 ${item.exitCode ?? '?'}`;
      process.stdout.write(`===== ${item.server.id} ${item.server.name} · ${status}${item.truncated ? ' · 输出已截断' : ''} =====\n`);
      if (item.output) process.stdout.write(item.output.endsWith('\n') ? item.output : `${item.output}\n`);
    }
  }
  if (results.length === 1) {
    const [only] = results;
    if (only.error) return 255;
    if (only.timedOut) return 124;
    return only.exitCode ?? 255;
  }
  return results.every((item) => !item.error && !item.timedOut && item.exitCode === 0) ? 0 : 1;
}
