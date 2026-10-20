/**
 * 手机端：nano、less、man、vim 这类全屏程序里上下滑动（xterm 的 alternate scroll）。不改网页版。
 *
 * 全屏程序用的是终端的备用屏幕，没有回滚区：网页版只在开了鼠标模式时（tmux 等）把滑动换成滚轮事件，
 * 普通屏幕滚本地回滚区，备用屏幕又没开鼠标模式时滑动什么也不做。这里补上这一种：竖向滑动换成滚轮事件派给
 * .xterm-screen，xterm 6 在备用屏幕、没有鼠标模式时会把每一格滚轮换成一个上 / 下方向键（按光标键模式选
 * ESC [ A 或 ESC O A），走它自己的输入事件 → 网页版的输入管线（Shell 就绪判定、trzsz 照旧）。
 * - 手指往上滑看下面的内容（发“下”），往下滑看上面的；滑过一行高发一个键，每次移动最多 16 个
 * - 松手时还在快速滑动的，按惯性再滚一会儿（逐帧衰减，一次最多 60 行），手指再按下就停
 * - 只在：触摸、单指、备用屏幕、鼠标模式关闭、快捷键栏没有按着 Ctrl / Alt 时（网页版的输入管线会把按着的
 *   一次性修饰键用到下一个键上，滑动不能把它吃掉）。横向为主的滑动、双指缩放、长按拖选（terminal-touch.ts
 *   先拦下）都不处理
 */
import type { Terminal } from '@xterm/xterm';
import { terminalFor } from '../shared/terminal';

const START_PX = 10;
const MAX_PER_MOVE = 16;
/** 松手前这段时间内的移动用来算速度 */
const VELOCITY_WINDOW_MS = 100;
/** 每帧速度（行）低于它就停 */
const MIN_FLING_LINES_PER_FRAME = 0.35;
const FLING_START_PX_PER_MS = 0.5;
const FLING_DECAY = 0.93;
const MAX_FLING_LINES = 60;

interface Swipe {
  term: Terminal;
  screen: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  remainder: number;
  active: boolean;
  /** 最近的移动（时间、位置），算松手时的速度 */
  samples: { t: number; y: number }[];
}

function modifierArmed(): boolean {
  return !!document.querySelector('#mobile-terminal-toolbar [data-mobile-modifier][aria-pressed="true"]');
}

/** 能不能把滑动换成方向键：备用屏幕、没开鼠标模式、没有按着修饰键 */
function altScrollable(term: Terminal): boolean {
  return term.buffer.active.type === 'alternate' && term.modes.mouseTrackingMode === 'none' && !modifierArmed();
}

function lineHeight(term: Terminal, screen: HTMLElement): number {
  const height = screen.getBoundingClientRect().height;
  return term.rows > 0 && height > 0 ? height / term.rows : 0;
}

/** 派 lines 格滚轮（正数往下看）；xterm 把每格换成一个方向键 */
function wheel(screen: HTMLElement, lines: number, x: number, y: number): void {
  const count = Math.min(Math.abs(lines), MAX_PER_MOVE);
  for (let index = 0; index < count; index++) {
    screen.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: Math.sign(lines) })
    );
  }
}

export function installAltScroll(): void {
  let swipe: Swipe | null = null;
  let fling = 0;

  const stopFling = () => {
    if (fling) cancelAnimationFrame(fling);
    fling = 0;
  };

  const startFling = (done: Swipe) => {
    const now = performance.now();
    const recent = done.samples.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS);
    if (recent.length < 2) return;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const elapsed = last.t - first.t;
    if (elapsed <= 0) return;
    // 正数：手指往上滑（往下看）
    const pxPerMs = (first.y - last.y) / elapsed;
    if (Math.abs(pxPerMs) < FLING_START_PX_PER_MS) return;
    const height = lineHeight(done.term, done.screen);
    if (height <= 0) return;
    let perFrame = (pxPerMs * 16) / height;
    let carried = done.remainder / height;
    let sent = 0;
    const rect = done.screen.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const step = () => {
      if (!done.screen.isConnected || !altScrollable(done.term) || Math.abs(perFrame) < MIN_FLING_LINES_PER_FRAME || sent >= MAX_FLING_LINES) {
        fling = 0;
        return;
      }
      carried += perFrame;
      const lines = Math.trunc(carried);
      if (lines) {
        const allowed = Math.sign(lines) * Math.min(Math.abs(lines), MAX_FLING_LINES - sent);
        wheel(done.screen, allowed, x, y);
        sent += Math.abs(allowed);
        carried -= lines;
      }
      perFrame *= FLING_DECAY;
      fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  };

  document.addEventListener(
    'pointerdown',
    (event) => {
      stopFling();
      if (event.pointerType !== 'touch' || !event.isPrimary) {
        swipe = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const screen = target?.closest<HTMLElement>('.xterm-screen');
      const term = screen ? terminalFor(screen) : null;
      if (!screen || !term || term.element?.closest('.mobile-selection-mode') || !altScrollable(term)) {
        swipe = null;
        return;
      }
      swipe = {
        term,
        screen,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        remainder: 0,
        active: false,
        samples: [{ t: performance.now(), y: event.clientY }],
      };
    },
    true
  );

  document.addEventListener(
    'pointermove',
    (event) => {
      const current = swipe;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!event.isPrimary || !altScrollable(current.term)) {
        swipe = null;
        return;
      }
      if (!current.active) {
        const dx = Math.abs(event.clientX - current.startX);
        const dy = Math.abs(event.clientY - current.startY);
        if (dy < START_PX) return;
        if (dx > dy) {
          swipe = null;
          return;
        }
        current.active = true;
        current.lastY = event.clientY;
      }
      event.preventDefault();
      const now = performance.now();
      current.samples.push({ t: now, y: event.clientY });
      while (current.samples.length > 2 && now - current.samples[0].t > VELOCITY_WINDOW_MS) current.samples.shift();
      const height = lineHeight(current.term, current.screen);
      if (height <= 0) return;
      current.remainder += current.lastY - event.clientY;
      current.lastY = event.clientY;
      const lines = Math.trunc(current.remainder / height);
      if (lines) {
        wheel(current.screen, lines, current.startX, current.startY);
        current.remainder -= lines * height;
      }
    },
    { capture: true, passive: false }
  );

  const finish = (event: PointerEvent) => {
    const current = swipe;
    if (!current || event.pointerId !== current.pointerId) return;
    swipe = null;
    if (event.type === 'pointerup' && current.active) startFling(current);
  };
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      swipe = null;
      stopFling();
    }
  });
}
