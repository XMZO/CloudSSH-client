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

export type CommandVerdict = { action: 'run' } | { action: 'refuse'; reason: string } | { action: 'confirm'; reason: string };

/** 危险命令规则（命令行与 MCP 共用）：拦截级一律拒绝；危险命令在 yes 或完全权限（confirm never）时放行，否则要确认 */
export function commandVerdict(command: string, yes: boolean, mode: ConfirmMode): CommandVerdict {
  const blocked = isBlockedCommand(command);
  if (blocked.blocked) return { action: 'refuse', reason: blocked.reason ?? '拦截级命令' };
  const risky = needsConfirmation(command);
  if (!risky.required || yes || mode === 'never') return { action: 'run' };
  return { action: 'confirm', reason: risky.reason ?? '需要确认' };
}

/** 危险命令的确认：可以执行就返回，否则抛出拒绝的原因（终端里会直接问） */
export async function checkCommand(command: string, yes: boolean, mode: ConfirmMode, what: string): Promise<void> {
  const verdict = commandVerdict(command, yes, mode);
  if (verdict.action === 'run') return;
  if (verdict.action === 'refuse') throw new UsageError(`拒绝执行（${verdict.reason}）：${command}`);
  if (interactive() && (await confirm(`危险命令（${verdict.reason}）将在 ${what} 上执行：\n  ${command}\n确定执行？`))) return;
  throw new UsageError(`危险命令（${verdict.reason}）：确认后加 --yes 再执行`);
}

/** 在一台服务器上执行（用哪条会话由调用方决定） */
export type Executor = (server: ServerConfig, command: string, timeout: number) => Promise<ExecResult>;

/** 默认：进程内的会话池（ai-remote），会话留着给后面的命令复用（MCP 服务器常驻时用） */
const pooled: Executor = (server, command, timeout) => remoteExec(server.id, command, timeout);

/** 每台只跑这一条就结束（命令行不经后台进程时）：远端执行完直接退出、服务器主动断开，省掉关闭时的一次来回 */
export const oneShot: Executor = (server, command, timeout) => remoteExec(server.id, command, timeout, { last: true });

async function runOne(server: ServerConfig, command: string, timeout: number, execute: Executor): Promise<ExecOutcome> {
  const base = { server: { id: hostId(server), name: server.name } };
  try {
    const result: ExecResult = await execute(server, command, timeout);
    return { ...base, exitCode: result.exitCode, output: result.output, timedOut: result.timedOut, truncated: result.truncated, durationMs: result.durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = error instanceof RemoteError && error.code === 'closed';
    return { ...base, exitCode: null, output: '', timedOut: false, truncated: false, durationMs: 0, error: unknown ? `连接中断，执行状态未知：${message}` : message };
  }
}

/** 在这些服务器上执行（同时最多 concurrency 台） */
export function runExec(servers: ServerConfig[], command: string, timeout: number, concurrency: number, execute: Executor = pooled): Promise<ExecOutcome[]> {
  return eachLimited(servers, concurrency, (server) => runOne(server, command, timeout, execute));
}

/** 一台的结果：错误 / 超时 / 退出码 */
export function outcomeStatus(item: ExecOutcome): string {
  return item.error ? `错误：${item.error}` : item.timedOut ? '超时' : `退出码 ${item.exitCode ?? '?'}`;
}

/** 远端正常跑完且退出码为 0 */
export const outcomeOk = (item: ExecOutcome): boolean => !item.error && !item.timedOut && item.exitCode === 0;

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
      process.stdout.write(`===== ${item.server.id} ${item.server.name} · ${outcomeStatus(item)}${item.truncated ? ' · 输出已截断' : ''} =====\n`);
      if (item.output) process.stdout.write(item.output.endsWith('\n') ? item.output : `${item.output}\n`);
    }
  }
  if (results.length === 1) {
    const [only] = results;
    if (only.error) return 255;
    if (only.timedOut) return 124;
    return only.exitCode ?? 255;
  }
  return results.every(outcomeOk) ? 0 : 1;
}
