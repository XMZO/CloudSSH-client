/**
 * 点哪光标到哪（桌面端单击、手机端轻点共用）。不改网页版；宁可不动，也不乱动。
 *
 * 只在能确定“有行编辑器在等输入”时才动光标，判断靠程序自己打开的括号粘贴模式（DECSET 2004）：bash 5.1 起的 readline、
 * zsh、fish、nano、vim 等在等输入时打开，执行命令时关闭；正在跑的命令（apt、top……）、less、普通的 sh 都不会打开。
 *
 * - 命令行（普通屏幕、没开鼠标模式、括号粘贴打开）：点在光标所在的那一行命令里（含自动折行的续行），按字符数发
 *   左 / 右方向键把光标移过去——宽字符算一个字、点在宽字符右半边算这个字；不往提示符里退（这一行第一个
 *   “$ / # / % / > / ❯ … 加空格”之后是输入开头），不往行尾以外走，也不走进 zsh-autosuggestions、fish 那种光标后面
 *   灰色的自动建议（按“右”会接受建议）。点在别的行、往回翻着历史时不动
 * - 全屏编辑器（备用屏幕、括号粘贴打开）：开了鼠标模式时点击本来就会报给编辑器，它自己定位，最准，不用管。
 *   没开鼠标模式时什么都不做：不模拟（Tab、宽字符、折行、标题栏和帮助栏都可能算错），不替用户按键，也不弹提示
 * - 调用方（手机端 tap-cursor.ts、桌面端 installMouseClickCursor）只交来干脆的单击 / 轻点；这里再排除：有选区、
 *   快捷键栏按着 Ctrl / Alt、刚打的字还没回显、上一次移动还没到位
 * 方向键按光标键模式编码（ESC [ D 或 ESC O D），经 xterm 的 input() 走网页版的输入管线（Shell 就绪、trzsz 照旧）。
 */
import type { IBufferCell, Terminal } from '@xterm/xterm';

/** 打完字多久内还在等回显（光标位置不可信） */
const ECHO_WAIT_MS = 1500;
/** 移动后等光标到位的最长时间 */
const SETTLE_MS = 1200;
const MAX_STEPS = 500;
/** 提示符结尾的常见符号（后面跟一个空格） */
const PROMPT_MARKS = new Set(['$', '#', '%', '>', '❯', '➜', '»', 'λ', '→', ']']);

interface Activity {
  input: number;
  output: number;
  /** 上一次移动的目标（缓冲区绝对行、列），光标到位或超时前不接受新的点击 */
  pending: { row: number; col: number; until: number } | null;
}

const activity = new WeakMap<Terminal, Activity>();
function modifierArmed(): boolean {
  return !!document.querySelector('#mobile-terminal-toolbar [data-mobile-modifier][aria-pressed="true"]');
}

/** 每个终端的输入 / 输出时间与状态（第一次用到时挂上监听） */
export function trackTerminal(term: Terminal): Activity {
  let state = activity.get(term);
  if (!state) {
    const created: Activity = { input: 0, output: 0, pending: null };
    term.onData(() => (created.input = Date.now()));
    term.onWriteParsed(() => (created.output = Date.now()));
    activity.set(term, created);
    state = created;
  }
  return state;
}

/** 点到的格子（缓冲区绝对行、列）；点在屏幕外返回 null */
function cellAt(term: Terminal, screen: HTMLElement, clientX: number, clientY: number): { row: number; col: number } | null {
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) return null;
  const col = Math.floor(((clientX - rect.left) / rect.width) * term.cols);
  const row = Math.floor(((clientY - rect.top) / rect.height) * term.rows);
  if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return null;
  return { row: term.buffer.active.viewportY + row, col };
}

/** 光标所在逻辑行（自动折行的几行算一行）：起止的缓冲区行 */
function logicalLine(term: Terminal, row: number): { start: number; end: number } {
  const buffer = term.buffer.active;
  let start = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let end = row;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
  return { start, end };
}

/** zsh-autosuggestions、fish 的自动建议：暗淡或灰色（256 色里的 8、240～246）的字 */
function isSuggestion(cell: IBufferCell): boolean {
  if (cell.isDim()) return true;
  if (!cell.isFgPalette()) return false;
  const color = cell.getFgColor();
  return color === 8 || (color >= 240 && color <= 246);
}

/** 把逻辑行摊平成格子序列（下标 = (行 - 起始行) * 列数 + 列），算出可以去的最左（输入开头）与最右（输入末尾） */
function layout(term: Terminal, line: { start: number; end: number }, cursorIndex: number) {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const cells: { ch: string; width: number; suggestion: boolean }[] = [];
  const scratch = buffer.getNullCell();
  for (let row = line.start; row <= line.end; row++) {
    const bufferLine = buffer.getLine(row);
    for (let col = 0; col < cols; col++) {
      const cell = bufferLine?.getCell(col, scratch);
      cells.push(cell ? { ch: cell.getChars(), width: cell.getWidth(), suggestion: cell.getChars() !== '' && isSuggestion(cell) } : { ch: '', width: 1, suggestion: false });
    }
  }
  // 输入开头：这一行第一个“提示符号 + 空格”之后（提示符在行首，命令里的 > 之类不会被当成开头）；
  // 光标前没有就不限制（行编辑器在开头按“左”只是不动）
  let first = 0;
  for (let index = 0; index + 1 < Math.min(cursorIndex, cells.length); index++) {
    if (PROMPT_MARKS.has(cells[index].ch) && (cells[index + 1].ch === '' || cells[index + 1].ch === ' ')) {
      first = index + 2;
      break;
    }
  }
  // 输入末尾：最后一个有字、不是自动建议的格子之后（自动建议只出现在光标后面，提示符里的灰字不算）；
  // 光标本身在更右边（行尾有空格）时以光标为准
  let last = -1;
  for (let index = 0; index < cells.length; index++) {
    if (index >= cursorIndex && cells[index].suggestion) break;
    if (cells[index].ch !== '' && cells[index].ch !== ' ') last = index;
  }
  return { cells, first: Math.min(first, cursorIndex), end: Math.max(last + 1, cursorIndex) };
}

/** 从 from 到 to（格子下标）要按几下方向键：宽字符算一下，它的右半边（宽度 0）不算 */
function steps(cells: { width: number }[], from: number, to: number): number {
  const [low, high] = from < to ? [from, to] : [to, from];
  let count = 0;
  for (let index = low; index < high; index++) if (cells[index]?.width !== 0) count++;
  return count;
}

function moveCursor(term: Terminal, state: Activity, target: { row: number; col: number }): void {
  const buffer = term.buffer.active;
  // 往回翻着历史时光标不在眼前，不动
  if (buffer.viewportY !== buffer.baseY) return;
  const cursorRow = buffer.baseY + buffer.cursorY;
  const line = logicalLine(term, cursorRow);
  if (target.row < line.start || target.row > line.end) return;
  const cols = term.cols;
  const cursorIndex = (cursorRow - line.start) * cols + buffer.cursorX;
  const { cells, first, end } = layout(term, line, cursorIndex);
  let index = (target.row - line.start) * cols + target.col;
  // 点在宽字符右半边：算这个字
  while (index > 0 && cells[index]?.width === 0) index--;
  index = Math.max(first, Math.min(end, index));
  if (index === cursorIndex) return;
  const count = Math.min(steps(cells, cursorIndex, index), MAX_STEPS);
  if (!count) return;
  const app = term.modes.applicationCursorKeysMode;
  const key = `\x1b${app ? 'O' : '['}${index > cursorIndex ? 'C' : 'D'}`;
  state.pending = { row: line.start + Math.floor(index / cols), col: index % cols, until: Date.now() + SETTLE_MS };
  term.input(key.repeat(count), true);
}

/**
 * 一次干脆的单击 / 轻点落在终端上（调用方已经排除了拖动、长按、双击、按下时就有选区的情况）：
 * 命令行里把光标移过去；全屏编辑器里不管（开了鼠标模式时点击由编辑器自己处理）
 */
export function cursorClick(term: Terminal, screen: HTMLElement, clientX: number, clientY: number): void {
  const state = trackTerminal(term);
  if (term.hasSelection() || modifierArmed()) return;
  // 括号粘贴没开：没有行编辑器在等输入（命令在跑、less、sh……），不动
  if (!term.modes.bracketedPasteMode) return;
  // 全屏编辑器（备用屏幕）、开了鼠标模式：不动
  if (term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none') return;
  const now = Date.now();
  // 刚打的字还没回显：光标位置还不对
  if (state.input > state.output && now - state.input < ECHO_WAIT_MS) return;
  // 上一次移动还没到位
  if (state.pending) {
    const buffer = term.buffer.active;
    const arrived = buffer.baseY + buffer.cursorY === state.pending.row && buffer.cursorX === state.pending.col;
    if (!arrived && now < state.pending.until) return;
    state.pending = null;
  }
  const target = cellAt(term, screen, clientX, clientY);
  if (target) moveCursor(term, state, target);
}

/**
 * 桌面端：不带修饰键的左键单击（按下到松开没动、不是双击、按下时没有选区）交给 cursorClick。
 * 拖动选择、双击选词、Alt+单击（xterm 自带的移动光标）、Shift+单击照旧
 */
export function installMouseClickCursor(terminalFor: (node: Element | null) => Terminal | null): void {
  let press: { term: Terminal; screen: HTMLElement; x: number; y: number; at: number; hadSelection: boolean } | null = null;
  document.addEventListener(
    'mousedown',
    (event) => {
      press = null;
      if (event.button !== 0 || event.detail > 1 || event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const screen = target?.closest<HTMLElement>('.xterm-screen');
      const term = screen ? terminalFor(screen) : null;
      if (!screen || !term) return;
      trackTerminal(term);
      press = { term, screen, x: event.clientX, y: event.clientY, at: Date.now(), hadSelection: term.hasSelection() };
    },
    true
  );
  document.addEventListener(
    'mouseup',
    (event) => {
      const current = press;
      press = null;
      if (!current || event.button !== 0) return;
      if (current.hadSelection || Date.now() - current.at > 500 || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 4) return;
      // 等 xterm 处理完这次松开（拖动时它会生成选区）再判断
      setTimeout(() => cursorClick(current.term, current.screen, current.x, current.y), 0);
    },
    true
  );
}
