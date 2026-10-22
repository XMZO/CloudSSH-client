/**
 * 键盘弹出 / 收起时，终端内容只做一次简单的上下移动。
 *
 * 网页版的做法：键盘一弹出，终端区域立刻变矮（最下面几行连同光标被键盘挡住），约 120ms 后按新高度重算行数，
 * 内容再跳一下，同时把新尺寸发给服务器。远端程序收到窗口变化（SIGWINCH）会整屏重画，Claude Code 这类
 * 直接输出在终端里的 CLI 会把整段内容重新输出一遍，看起来就是“边闪边移动”。收起键盘时再来一遍。
 *
 * 这里改成：普通屏幕（shell，以及 Claude Code 这类不用全屏模式的 CLI）键盘开着时终端保持原来的大小，
 * 不重算行数、不通知服务器，只把终端整体往上移，让光标和最下面有内容的几行露在键盘上方；收起键盘时移回原位。
 * 移到上面看不见的几行，收起键盘就回来了；内容只到屏幕上半部分时（比如刚 clear 过）不用移。
 * 全屏程序（vim、nano、top、less 这类用备用屏幕的）照旧按键盘上方的高度重算行数，让它们按新尺寸重画。
 *
 * 判断键盘：可视区域比完整高度矮，并且焦点在输入框里（或网页版已判定键盘弹出）。键盘收起、可视区域
 * 恢复完整高度时还原；横竖屏切换（宽度变化）时重新记完整高度。
 */
import type { Terminal } from '@xterm/xterm';

interface TabLike {
  id: string;
  terminal?: { terminal?: Terminal; fit?: () => boolean };
}

interface TabManagerLike {
  tabs?: Map<string, TabLike>;
  getActiveTab?: () => TabLike | null;
}

const manager = () => (globalThis as { __cloudsshTabManager?: TabManagerLike }).__cloudsshTabManager ?? null;

/** 可视区域比完整高度矮这么多以内不算被挡（地址栏、取整误差） */
const SHRINK_EPSILON = 2;

export function installKeyboardShift(): void {
  const area = document.getElementById('terminal-area');
  const viewport = window.visualViewport;
  if (!area || !viewport) return;
  const root = document.documentElement;

  let fullViewport = viewport.height;
  let viewportWidth = viewport.width;
  /** 键盘收起时终端区域的高度（键盘开着时终端保持这个高度） */
  let closedHeight = 0;
  let active = false;
  /** 已按“保持原高度”摆放的容器 */
  const held = new Set<HTMLElement>();
  const watched = new WeakSet<Terminal>();

  const editableFocused = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
  };

  const containerOf = (tab: TabLike) => document.getElementById(`terminal-container-${tab.id}`);

  function release(container: HTMLElement): void {
    if (!held.delete(container)) return;
    container.style.removeProperty('bottom');
    container.style.removeProperty('height');
    container.style.removeProperty('transform');
  }

  /** 键盘上方要露出的最后一行（相对屏幕顶部的行号）：光标与它下面最后一行有内容的行 */
  function focusRow(term: Terminal): number {
    const buffer = term.buffer.active;
    // 往回翻看历史时，保持露出底部（和键盘弹出前看到的底部对齐）
    if (buffer.viewportY < buffer.baseY) return term.rows - 1;
    for (let row = term.rows - 1; row > buffer.cursorY; row--) {
      if (buffer.getLine(buffer.baseY + row)?.translateToString(true).trim()) return row;
    }
    return buffer.cursorY;
  }

  /** 把活动终端往上移到露出光标附近 */
  function place(container: HTMLElement, term: Terminal): void {
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !term.rows) return;
    const visible = area!.clientHeight;
    const containerRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cell = screenRect.height / term.rows;
    const bottom = screenRect.top - containerRect.top + (focusRow(term) + 1) * cell;
    const shift = Math.round(Math.min(Math.max(0, bottom - visible), Math.max(0, closedHeight - visible)));
    const value = shift ? `translateY(${-shift}px)` : '';
    if (container.style.transform !== value) container.style.transform = value;
  }

  function watch(tab: TabLike): void {
    const term = tab.terminal?.terminal;
    if (!term || watched.has(term)) return;
    watched.add(term);
    // 输出、光标移动、翻看历史时跟着调整位置；进出全屏程序时切换做法
    term.onRender(() => active && schedule());
    term.onScroll(() => active && schedule());
    term.buffer.onBufferChange(() => {
      if (!active) return;
      update();
      // 换了做法（保持原高度 ↔ 按键盘上方的高度）后按容器的新高度重算行数
      requestAnimationFrame(() => tab.terminal?.fit?.());
    });
  }

  function update(): void {
    frame = 0;
    if (Math.abs(viewport!.width - viewportWidth) > 1) {
      // 横竖屏切换、分屏改宽度：重新记完整高度
      viewportWidth = viewport!.width;
      fullViewport = viewport!.height;
      for (const container of [...held]) release(container);
      active = false;
    }
    fullViewport = Math.max(fullViewport, viewport!.height);
    const shrunk = fullViewport - viewport!.height > SHRINK_EPSILON;
    if (!shrunk) {
      // 键盘收起：还原，记下完整高度
      for (const container of [...held]) release(container);
      active = false;
      // 终端页没显示时（节点页）量不到高度，沿用上次的
      if (area!.clientHeight > 0) closedHeight = area!.clientHeight;
      return;
    }
    // 可视区域变矮：键盘开着才保持原高度（开始时要有输入焦点；已经开始后直到恢复完整高度）
    if (!active && !(editableFocused() || root.classList.contains('mobile-keyboard-open'))) return;
    if (!closedHeight || closedHeight <= area!.clientHeight) return;
    active = true;
    const tabs = manager()?.tabs;
    const current = manager()?.getActiveTab?.() ?? null;
    if (!(tabs instanceof Map)) return;
    for (const tab of tabs.values()) {
      const container = containerOf(tab);
      const term = tab.terminal?.terminal;
      if (!container || !term) continue;
      watch(tab);
      if (term.buffer.active.type === 'alternate') {
        // 全屏程序：照旧按键盘上方的高度
        release(container);
        continue;
      }
      if (!held.has(container)) {
        held.add(container);
        container.style.bottom = 'auto';
      }
      const height = `${closedHeight}px`;
      if (container.style.height !== height) container.style.height = height;
      if (tab === current) place(container, term);
      else container.style.removeProperty('transform');
    }
  }

  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  // 终端区域尺寸变化在布局之后、绘制之前回调：键盘弹出的同一帧就摆好，不会先露出被挡住的样子
  new ResizeObserver(() => update()).observe(area);
  viewport.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('focusin', schedule);
  document.addEventListener('cloudssh:active-terminal-change', schedule);
  update();
}
