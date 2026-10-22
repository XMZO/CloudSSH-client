/**
 * 断线后秒级恢复（session_resumed）接上的是原来那个 Shell：它早把提示符打印过了、不会再打印，网页版又在后面写了
 * “连接已关闭 / 正在重新连接 / 已成功恢复会话”，光标停在新的空行上，要按一下回车才看得到提示符。
 *
 * 办法是让远端终端尺寸变一下：Shell 收到窗口变化信号（SIGWINCH）会在当前行重画提示符和没打完的命令，vim、top
 * 这类全屏程序整屏重画。原来窄一列、马上改回来，两次挨着到达服务器，bash（readline）把两个信号合成一次处理，
 * 读到的尺寸和原来一样就不重画——提示符还是不出来。现在分开：
 * 1. 等断线期间暂存、恢复后补发的输出停下来（最多等 1.5 秒）
 * 2. 发“窄一列”，等 Shell 按它重画（收到输出），最多等 1.2 秒
 * 3. 再改回实际尺寸（Shell 又重画一次，按正确的宽度）
 * 第二次在 Shell 处理完第一次之后才到，两次都是真的变化，都会重画。
 */
import type { Terminal } from '@xterm/xterm';

/** 补发的输出停这么久算发完了 */
const QUIET_MS = 150;
const QUIET_LIMIT_MS = 1500;
/** 发了“窄一列”之后，等 Shell 重画的最长时间 */
const REDRAW_LIMIT_MS = 1200;
/** 收到重画之后再等这么久（重画的输出可能分几段到） */
const SETTLE_MS = 80;
const POLL_MS = 30;

/** 网页版 SSHTerminal 里用到的成员（TypeScript 的 private，运行时照常可用） */
interface ResumedTerminal {
  terminal: Terminal;
  ws: WebSocket | null;
  sessionReady: boolean;
  getTerminalSize(): { cols: number; rows: number };
  sendResize(size: { cols: number; rows: number }): void;
}

function redrawAfterResume(target: unknown): boolean {
  const term = target as ResumedTerminal;
  if (typeof term?.sendResize !== 'function' || typeof term.getTerminalSize !== 'function' || !term.terminal) return false;
  const socket = term.ws;
  const started = performance.now();
  let lastOutput = started;
  let narrowedAt = 0;
  let redrawnAt = 0;
  const watch = term.terminal.onWriteParsed(() => {
    lastOutput = performance.now();
    if (narrowedAt && !redrawnAt) redrawnAt = lastOutput;
  });
  const alive = () => term.ws === socket && term.sessionReady;
  const finish = () => {
    window.clearInterval(timer);
    watch.dispose();
  };
  const timer = window.setInterval(() => {
    if (!alive()) return finish();
    const now = performance.now();
    if (!narrowedAt) {
      if (now - lastOutput < QUIET_MS && now - started < QUIET_LIMIT_MS) return;
      const size = term.getTerminalSize();
      if (size.cols <= 2) return finish();
      narrowedAt = now;
      term.sendResize({ ...size, cols: size.cols - 1 });
      return;
    }
    const redrawn = redrawnAt > 0 && now - lastOutput >= SETTLE_MS;
    if (!redrawn && now - narrowedAt < REDRAW_LIMIT_MS) return;
    term.sendResize(term.getTerminalSize());
    finish();
  }, POLL_MS);
  return true;
}

export function installResumeRedraw(): void {
  (globalThis as { __cloudsshRedrawAfterResume?: typeof redrawAfterResume }).__cloudsshRedrawAfterResume = redrawAfterResume;
}
