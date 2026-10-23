/**
 * 连续改尺寸时（拖动窗口边缘）只把最后的尺寸告诉服务器（电脑端安装）。
 *
 * 网页版终端每变一次尺寸就通知服务器一次。拖动窗口时一路变十几次，服务器上的程序（tmux、vim、Claude Code 这类）
 * 按每个中间尺寸各整屏重画一遍，输出陆续到达，终端就一直在闪。现在本地终端照常每一步都跟着窗口重排，
 * 通知服务器等尺寸停下来 SETTLE_MS 再发一次（发的是那时的尺寸），远端只重画一次；只改一次尺寸（开关侧栏、面板）
 * 也只是晚这么一点。发出时让 ./resize-settle.ts 重新开始攒输出，这次重画还是一帧整屏换好。
 * 构建钩子（vite.config.ts）在网页版 onResize → sendResize 处先问 __cloudsshDeferResize；直接调 sendResize 的
 * （连上时报尺寸、恢复会话后的“窄一列再改回”）不经过这里。
 */
import type { Terminal } from '@xterm/xterm';
import { holdOutputAfterResize } from './resize-settle';

const SETTLE_MS = 100;

/** 网页版 SSHTerminal 里用到的成员（TypeScript 的 private，运行时照常可用） */
interface ResizeTarget {
  terminal: Terminal;
  sendResize(size: { cols: number; rows: number }): void;
}

const timers = new WeakMap<object, number>();

function deferResize(target: ResizeTarget): boolean {
  if (typeof target?.sendResize !== 'function' || !target.terminal) return false;
  window.clearTimeout(timers.get(target));
  timers.set(
    target,
    window.setTimeout(() => {
      timers.delete(target);
      target.sendResize({ cols: target.terminal.cols, rows: target.terminal.rows });
      holdOutputAfterResize(target.terminal);
    }, SETTLE_MS)
  );
  return true;
}

export function installResizeDefer(): void {
  (globalThis as { __cloudsshDeferResize?: typeof deferResize }).__cloudsshDeferResize = deferResize;
}
