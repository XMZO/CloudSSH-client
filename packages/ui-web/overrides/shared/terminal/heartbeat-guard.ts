/**
 * 心跳判断更稳（电脑与手机共用）。网页版每 5 秒 ping 一次，10 秒没收到 pong 就判定连接卡死，主动关闭再恢复。
 * 两种情况会误判：
 * - 大量终端输出排在 pong 前面：慢链路（代理、TUN、弱网）上 cat 大文件，pong 要等前面的输出送完
 * - 代理 / TUN 短暂拥塞几秒
 * 误判的代价很大：网页版以 1000 关闭，这个关闭帧如果还送得到 Worker，Worker 当成正常结束、直接销毁会话，
 * 之后只能开新 Shell（目录、正在跑的命令都没了）。
 *
 * 网页版判定卡死之前先问这里（构建钩子 __cloudsshHeartbeatStall，返回 true 表示这次先不判定）：
 * 最近一次收到任何消息（输出、状态、pong……）距今不到 20 秒，就当连接还活着，下一次 ping 再看；
 * 完全静默满 20 秒才交给网页版关闭并恢复（真断了最多晚十来秒发现，恢复照常）。
 * 收到消息的时间由构建钩子记在终端的 __cloudsshLastInboundAt 上（网页版处理每条消息的第一行）。
 */
import { connectionDiagnostic } from './connection-diagnostics';

/** 完全静默多久才算卡死（网页版是 pong 超时 10 秒） */
const MAX_SILENCE_MS = 20_000;

interface HeartbeatTerminal {
  ws?: WebSocket | null;
  /** 构建钩子：最后一次收到消息的时间（performance.now()） */
  __cloudsshLastInboundAt?: number;
}

function heartbeatStall(term: HeartbeatTerminal, socket: WebSocket): boolean {
  if (term.ws !== socket || socket.readyState !== WebSocket.OPEN) return false;
  const last = term.__cloudsshLastInboundAt;
  const silentMs = typeof last === 'number' ? performance.now() - last : Number.POSITIVE_INFINITY;
  if (silentMs >= MAX_SILENCE_MS) return false;
  connectionDiagnostic(term, 'heartbeat-postponed', { silentMs: Math.round(silentMs) });
  return true;
}

let installed = false;

export function installHeartbeatGuard(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __cloudsshHeartbeatStall?: typeof heartbeatStall }).__cloudsshHeartbeatStall = heartbeatStall;
}
