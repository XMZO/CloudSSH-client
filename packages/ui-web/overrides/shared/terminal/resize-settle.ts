/**
 * 终端尺寸变化后，远端程序的整屏重画一次显示出来，不一截一截地闪。
 *
 * 尺寸一变，服务器上的程序收到 SIGWINCH 就整屏重画：先清屏再分好几段输出，Claude Code 这类 CLI 还会把内容整个
 * 重新输出一遍。这些输出分几次到达，每到一次终端就画一帧，看到的是“先空一下、再一截截冒出来”的闪烁。
 * 这里在尺寸变化后的一小段时间里先把收到的输出攒着，输出停下来（或攒到上限）再一起写进终端，
 * 重画就只是同一帧里整屏换成新的样子。只改显示的时机，不改内容与顺序；平时的输出不受影响。
 */
import type { Terminal } from '@xterm/xterm';

/** 尺寸变化后这么久之内到达的输出先攒着（这段时间没有输出就不再等） */
const WAIT_MS = 400;
/** 输出停这么久，算重画完了 */
const QUIET_MS = 60;
/** 最多攒这么久（从攒下第一段算起）：一直有输出时也按时显示 */
const MAX_HOLD_MS = 400;

type Data = string | Uint8Array;

export function installResizeSettle(term: Terminal): void {
  const write = term.write.bind(term);
  let holdUntil = 0;
  let pending: [Data, (() => void) | undefined][] = [];
  let quietTimer = 0;
  let maxTimer = 0;

  const flush = () => {
    window.clearTimeout(quietTimer);
    window.clearTimeout(maxTimer);
    quietTimer = maxTimer = 0;
    holdUntil = 0;
    const items = pending;
    pending = [];
    // 同一个任务里依次写入：终端解析完再画，重画只占一帧
    for (const [data, callback] of items) write(data, callback);
  };

  term.onResize(() => {
    holdUntil = performance.now() + WAIT_MS;
  });

  term.write = (data: Data, callback?: () => void) => {
    if (!pending.length && performance.now() > holdUntil) {
      write(data, callback);
      return;
    }
    pending.push([data, callback]);
    window.clearTimeout(quietTimer);
    quietTimer = window.setTimeout(flush, QUIET_MS);
    if (!maxTimer) maxTimer = window.setTimeout(flush, MAX_HOLD_MS);
  };
  // writeln 不经过 write，攒着输出时会插到前面去：改成走同一条路
  term.writeln = (data: Data, callback?: () => void) => {
    term.write(data);
    term.write('\r\n', callback);
  };
}
