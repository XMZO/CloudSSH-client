/**
 * 等待自动重连时的实时倒计时（精确到毫秒）与“按任意键立即重连”提示。
 *
 * 网页版写出“x 秒后重连（第 n/5 次）…”之后，构建钩子（vite.config.ts）调用这里：把那一行原地换成
 * “3.456 秒后重连（第 2/5 次）… （按任意键立即重连）”并持续刷新；重连开始时定格在当时的剩余时间、去掉提示。
 *
 * 只改写倒计时那一行，光标始终停在下一行行首，网页版之后照常 writeln。
 * - 每次改写都在 xterm 的写入回调里读缓冲区、算光标该上移几行，并立刻排在下一个解析：
 *   窗口缩放是同步重排的，提前算好的位置到解析时可能已经不对了。
 * - 改写前确认光标没动过（没有别的输出写进来）、那一行没有折行，否则停止或跳过，绝不覆盖别的内容。
 * - 认不出网页版刚写的那一行、或处在全屏程序的备用屏幕时，退回只在下面加一行静态提示。
 */
import type { IMarker, Terminal } from '@xterm/xterm';
import { terminalTextWidth } from '../../../upstream/frontend/src/terminal-text';
import { ht } from './i18n';

export interface ReconnectCountdownOptions {
  /** 距离重连的毫秒数（与网页版排定的计时一致） */
  ms: number;
  /** 网页版这一行的文案（不含“[*] ”），seconds 已格式化为三位小数 */
  format: (seconds: string) => string;
  /** 这次排定的重连仍然有效（被取消、被新连接替换时为 false） */
  isActive: () => boolean;
}

export interface ReconnectCountdown {
  /**
   * 重连开始（到点或按键）：定格剩余时间并去掉按键提示，写好之后再调用 next 真正开始重连，
   * 保证网页版接下来写的“正在重新连接…”排在定格的那一行后面
   */
  finish(next: () => void): void;
}

const TICK_MS = 33;
const WAIT_STYLE = '\x1b[33m';
const HINT_STYLE = '\x1b[2m';
const RESET = '\x1b[0m';
/** 宽度判断留两列余量：省略号等歧义宽度字符各终端算法可能不同 */
const MARGIN = 2;

export function startReconnectCountdown(term: Terminal, options: ReconnectCountdownOptions): ReconnectCountdown {
  const deadline = Date.now() + options.ms;
  const hint = ht('reconnectNow');
  /** waiting：等网页版那一行解析完；running：倒计时中；ended：已定格、已停止或退回了静态提示 */
  let state: 'waiting' | 'running' | 'ended' = 'waiting';
  let timer = 0;
  let ticking = false;
  let sameLine = false;
  /** 倒计时那一行 */
  let line: IMarker | undefined;
  /** 我们输出之后的空行，光标应停在这一行行首 */
  let tail: IMarker | undefined;

  const remaining = () => Math.max(0, deadline - Date.now());
  const waitText = (ms: number) => `[*] ${options.format((ms / 1000).toFixed(3))}`;
  const render = (ms: number, withHint: boolean) =>
    `${WAIT_STYLE}${waitText(ms)}${RESET}${withHint ? ` ${HINT_STYLE}${hint}${RESET}` : ''}`;
  const fits = (ms: number, withHint: boolean) =>
    terminalTextWidth(waitText(ms) + (withHint ? ` ${hint}` : '')) <= term.cols - MARGIN;

  /** 光标这一行及以下都是空的（\x1b[J 清掉也不会丢内容） */
  const blankFromCursor = () => {
    const buffer = term.buffer.active;
    for (let row = buffer.baseY + buffer.cursorY; row < buffer.baseY + term.rows; row++) {
      if (buffer.getLine(row)?.translateToString(true)) return false;
    }
    return true;
  };

  /** 光标仍停在我们输出之后的空行行首时，返回倒计时那一行在光标上方几行；有别的输出写进来过则为 null */
  const offset = (): number | null => {
    if (!line || !tail || line.isDisposed || tail.isDisposed) return null;
    const buffer = term.buffer.active;
    if (buffer.type !== 'normal') return null;
    const cursor = buffer.baseY + buffer.cursorY;
    if (cursor !== tail.line || buffer.cursorX !== 0) return null;
    const up = cursor - line.line;
    return up >= 1 && up <= buffer.cursorY ? up : null;
  };

  const release = () => {
    window.clearInterval(timer);
    timer = 0;
    line?.dispose();
    tail?.dispose();
    line = tail = undefined;
  };

  const end = () => {
    state = 'ended';
    release();
  };

  const update = () => {
    ticking = false;
    if (state !== 'running') return;
    try {
      if (!options.isActive()) return end();
      const up = offset();
      if (up === null) return end();
      const ms = remaining();
      // 窗口变窄后这一行放不下（或已被折行）时先不刷新，避免只改写半截；变回来后继续
      if (!fits(ms, sameLine) || term.buffer.active.getLine(line!.line + 1)?.isWrapped) return;
      term.write(`\x1b[${up}A\r\x1b[2K${render(ms, sameLine)}\r\x1b[${up}B`);
    } catch {
      end();
    }
  };

  const tick = () => {
    if (state !== 'running' || ticking) return;
    ticking = true;
    term.write('', update);
  };

  const setup = () => {
    if (state !== 'waiting') return;
    const buffer = term.buffer.active;
    const cursor = buffer.baseY + buffer.cursorY;
    let start = cursor - 1;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    const up = cursor - start;
    const head = buffer.getLine(start)?.translateToString(true) ?? '';
    if (buffer.type !== 'normal' || buffer.cursorX !== 0 || !head.startsWith('[*]') || up > buffer.cursorY || !blankFromCursor()) {
      state = 'ended';
      term.writeln(`${HINT_STYLE}${hint}${RESET}`);
      return;
    }
    state = 'running';
    const ms = remaining();
    sameLine = fits(ms, true);
    line = term.registerMarker(start - cursor);
    const block = sameLine ? render(ms, true) : `${render(ms, false)}\r\n${HINT_STYLE}${hint}${RESET}`;
    term.write(`\x1b[${up}A\r\x1b[J${block}\r\n`, () => {
      // 已经停止（标记已释放）就不再登记；正在定格时照常登记，定格的回调排在这之后要用到
      if (!line) return;
      tail = term.registerMarker(0);
      if (state === 'running') timer = window.setInterval(tick, TICK_MS);
    });
  };

  // 等网页版刚写的那一行解析完再读缓冲区
  term.write('', setup);

  return {
    finish(next) {
      if (state !== 'running') {
        state = 'ended';
        next();
        return;
      }
      state = 'ended';
      window.clearInterval(timer);
      timer = 0;
      const ms = remaining();
      term.write('', () => {
        try {
          const up = offset();
          if (up !== null && fits(ms, false) && blankFromCursor()) term.write(`\x1b[${up}A\r\x1b[J${render(ms, false)}\r\n`);
        } catch {
          // 定格失败不影响重连
        }
        release();
        next();
      });
    },
  };
}
