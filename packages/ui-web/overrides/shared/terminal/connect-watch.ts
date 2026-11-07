/**
 * 连上了却迟迟不开始 SSH 握手时换一条连接（电脑与手机共用）。
 *
 * 新会话的 WebSocket 连上后，Worker 先去连 SSH 服务器的 TCP 端口，连上才开始 SSH 握手、发第一条状态（version_exchange；
 * 有跳板机时是 jump_hop_connecting）。正常时第一条状态在连上后 0.01–2 秒内到。Cloudflare 出站 TCP 偶尔连不上：握手包没有回应，
 * Worker 那边不设超时，要等平台约 20 秒才报“连接失败”，这期间终端只有一行“正在认证”，看着像卡死，只能关掉标签重开
 * （重开一般就连上了）。客户端主动关闭这条连接也没用：Worker 卡在连接上，关闭要等那 20 秒过完才有回应。
 *
 * 现在连上后 8 秒还没收到任何状态，就当这条连接以 4000 关闭了：照网页版自己的关闭处理走一遍（写“连接已关闭”、
 * 安排自动重连开新会话、显示倒计时，按任意键立即重连），旧连接的处理函数全部摘掉，它迟到的错误和关闭不再影响新连接。
 * 重连次数用完照旧交给 ./reboot-wait.ts。秒级恢复（resume）不经过这里。
 */
import { connectionDiagnostic } from './connection-diagnostics';
import { ht } from './i18n';

/** 连上后这么久还没有任何状态就换一条连接 */
const STALL_MS = 8_000;

interface WatchedTerminal {
  ws?: WebSocket | null;
  sessionReady?: boolean;
  terminal?: { writeln(text: string): void };
  /** 构建钩子：这条连接最后一个带 event 的 status / error 消息（连接关闭时清空） */
  __cloudsshLastEvent?: string;
}

function watchConnect(term: WatchedTerminal, socket: WebSocket): void {
  // 上一条连接被新连接直接替换时，它的关闭处理不会清空这个，这里按新连接重新算
  term.__cloudsshLastEvent = undefined;
  window.setTimeout(() => {
    if (term.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    if (term.sessionReady || term.__cloudsshLastEvent !== undefined) return;
    connectionDiagnostic(term as never, 'connect-stalled', { waitedMs: STALL_MS });
    term.terminal?.writeln(`\x1b[33m[!] ${ht('connectStalled', { seconds: STALL_MS / 1000 })}\x1b[0m`);
    const close = socket.onclose;
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
    close?.call(socket, new CloseEvent('close', { code: 4000, reason: 'connect stalled', wasClean: false }));
    try {
      socket.close(4000, 'connect stalled');
    } catch {
      // 已经在关闭
    }
  }, STALL_MS);
}

let installed = false;

export function installConnectWatch(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __cloudsshConnectWatch?: typeof watchConnect }).__cloudsshConnectWatch = watchConnect;
}
