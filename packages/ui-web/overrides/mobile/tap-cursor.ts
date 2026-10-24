/**
 * 手机端：点哪光标就到哪。这里只认手势——干脆的单指轻点（350ms 内、移动不超过 10px，按下时没有选区，
 * 不在网页版的选择模式里）；判断与移动光标在 ../shared/terminal/click-cursor.ts（与桌面端单击共用）：
 * 命令行里按字符数发左 / 右键，全屏编辑器没开鼠标时提示一次怎么打开。
 */
import type { Terminal } from '@xterm/xterm';
import { terminalFor } from '../shared/terminal';
import { cursorClick, trackTerminal } from '../shared/terminal/click-cursor';

const TAP_MS = 350;
const TAP_MOVE_PX = 10;

interface Tap {
  term: Terminal;
  screen: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  at: number;
  /** 按下时有没有选区（点一下是取消选区） */
  hadSelection: boolean;
}

export function installTapCursor(): void {
  let tap: Tap | null = null;

  document.addEventListener(
    'pointerdown',
    (event) => {
      tap = null;
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      const target = event.target instanceof Element ? event.target : null;
      const screen = target?.closest<HTMLElement>('.xterm-screen');
      const term = screen ? terminalFor(screen) : null;
      if (!screen || !term || term.element?.closest('.mobile-selection-mode')) return;
      trackTerminal(term);
      tap = { term, screen, pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), hadSelection: term.hasSelection() };
    },
    true
  );
  document.addEventListener(
    'pointermove',
    (event) => {
      if (tap && event.pointerId === tap.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_MOVE_PX) tap = null;
      // 第二根手指（缩放）：不是轻点
      if (tap && !event.isPrimary) tap = null;
    },
    true
  );
  document.addEventListener(
    'pointerup',
    (event) => {
      const current = tap;
      tap = null;
      if (!current || event.pointerId !== current.pointerId || current.hadSelection) return;
      if (Date.now() - current.at > TAP_MS || Math.hypot(event.clientX - current.x, event.clientY - current.y) > TAP_MOVE_PX) return;
      cursorClick(current.term, current.screen, current.x, current.y);
    },
    true
  );
  document.addEventListener('pointercancel', () => (tap = null), true);
}
