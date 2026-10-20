/**
 * 手机端：点哪光标就到哪。不改网页版；宁可不动，也不乱动。
 *
 * 只在能确定“有行编辑器在等输入”时才动光标，判断靠程序自己打开的括号粘贴模式（DECSET 2004）：bash 5.1 起的 readline、
 * zsh、fish、nano、vim 等在等输入时打开，执行命令时关闭；正在跑的命令（apt、top……）、less、普通的 sh 都不会打开。
 *
 * - 命令行（普通屏幕、没开鼠标模式、括号粘贴打开）：点在光标所在的那一行命令里（含自动折行的续行），按字符数发
 *   左 / 右方向键把光标移过去——宽字符算一个字、点在宽字符右半边算这个字；不往提示符里退（找光标前最近的
 *   “$ / # / % / > / ❯ … 加空格”当输入的开头），不往行尾以外走，也不走进 zsh-autosuggestions、fish 那种灰色的
 *   自动建议（按“右”会接受建议）。点在别的行、往回翻着历史时不动
 * - 全屏编辑器（备用屏幕、括号粘贴打开）：开了鼠标模式时点按本来就是一次点击，编辑器自己定位，最准，不用管；
 *   没开鼠标模式时不模拟（Tab、宽字符、折行、标题栏和帮助栏都可能算错），只提示一次怎么打开鼠标支持
 * - 只认干脆的单指轻点（350ms 内、移动不超过 10px）；有选区时（点一下是取消选区）、快捷键栏按着 Ctrl / Alt 时、
 *   刚打的字还没回显时、上一次移动还没完成时都不动
 * 方向键按光标键模式编码（ESC [ D 或 ESC O D），经 xterm 的 input() 走网页版的输入管线（Shell 就绪、trzsz 照旧）。
 */
import type { IBufferCell, Terminal } from '@xterm/xterm';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { terminalFor } from '../shared/terminal';
import { mt } from './i18n';

const TAP_MS = 350;
const TAP_MOVE_PX = 10;
/** 打完字多久内还在等回显（光标位置不可信） */
const ECHO_WAIT_MS = 1500;
/** 移动后等光标到位的最长时间 */
const SETTLE_MS = 1200;
const MAX_STEPS = 500;
/** 提示符结尾的常见符号（后面跟一个空格） */
const PROMPT_MARKS = new Set(['$', '#', '%', '>', '❯', '➜', '»', 'λ', '→', ']']);

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

interface Activity {
  input: number;
  output: number;
  /** 上一次移动的目标（缓冲区绝对行、列），光标到位或超时前不接受新的点按 */
  pending: { row: number; col: number; until: number } | null;
}

const activity = new WeakMap<Terminal, Activity>();
let hinted = false;

function modifierArmed(): boolean {
  return !!document.querySelector('#mobile-terminal-toolbar [data-mobile-modifier][aria-pressed="true"]');
}

function track(term: Terminal): Activity {
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

/**
 * 把逻辑行摊平成格子序列（下标 = (行 - 起始行) * 列数 + 列），算出：光标下标、可以去的最左（输入开头）与最右（输入末尾）
 */
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
  // 输入开头：这一行第一个“提示符号 + 空格”之后（提示符在行首，取第一个，命令里的 > 之类不会被当成开头）；
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
  const end = Math.max(last + 1, cursorIndex);
  return { cells, first: Math.min(first, cursorIndex), end };
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

function handleTap(tap: Tap): void {
  const term = tap.term;
  const state = track(term);
  if (tap.hadSelection || term.hasSelection() || modifierArmed()) return;
  // 括号粘贴没开：没有行编辑器在等输入（命令在跑、less、sh……），不动
  if (!term.modes.bracketedPasteMode) return;
  const mouse = term.modes.mouseTrackingMode !== 'none';
  if (term.buffer.active.type === 'alternate') {
    // 编辑器开了鼠标模式：点按本来就是点击，交给编辑器；没开：提示一次怎么打开
    if (!mouse && !hinted) {
      hinted = true;
      notify(mt('editorMouseHint'), { duration: 9000 });
    }
    return;
  }
  if (mouse) return;
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
  const target = cellAt(term, tap.screen, tap.x, tap.y);
  if (target) moveCursor(term, state, target);
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
      track(term);
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
      if (!current || event.pointerId !== current.pointerId) return;
      if (Date.now() - current.at > TAP_MS || Math.hypot(event.clientX - current.x, event.clientY - current.y) > TAP_MOVE_PX) return;
      handleTap(current);
    },
    true
  );
  document.addEventListener('pointercancel', () => (tap = null), true);
}
