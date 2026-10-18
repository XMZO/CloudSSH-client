/**
 * 手机端终端的触摸操作（只用 xterm 的公开 API，加一层自己的手势与浮层，不改网页版）：
 *
 * - 长按选中：长按一个词即选中，不松手继续拖动可以扩大选区（靠近上下边缘时自动滚动）；松手后两端出现拖动柄，
 *   上方浮出“复制 / 全选 / 粘贴”。点终端其他地方取消。网页版工具栏的“复制”按钮（选择模式）照常可用，
 *   它选出的内容同样会出现拖动柄和浮动栏。
 * - 双指缩放：捏合调整终端字号（黑曜主题），松手后保存——与“更多”面板里的 A− / A+ 是同一个设置。
 *   一键脚本的菜单常常是固定 60～80 列宽，竖屏放不下就会折行错乱，缩小字号即可放下。
 * - 屏蔽长按的系统行为：安卓长按会触发 contextmenu，xterm 把它当成右键——把隐藏输入框挪到手指下并聚焦，
 *   于是弹出“粘贴”气泡和键盘、什么也选不中；还会把单词塞进输入框并选中，出现系统的“分享”菜单。
 */
import type { IDisposable, Terminal } from '@xterm/xterm';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { currentTerminalFontSize } from '../../upstream/frontend/src/terminal-layout';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { terminalFor } from '../shared/terminal';
import { mt, onLocaleChange } from './i18n';
import { el } from './sheet';
import { skinState, updateSkin } from './skin/engine';
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from './skin/state';
import './terminal-touch.css';

const LONG_PRESS_MS = 420;
const MOVE_TOLERANCE = 10;
/** 手势结束后这段时间里的兼容鼠标事件（mousedown / click）一律吞掉：不让 xterm 聚焦弹出键盘、不当作点击 */
const SWALLOW_MS = 450;
const AUTOSCROLL_MS = 70;

/** 缓冲区坐标：y 是整个缓冲区（含回滚）里的行号 */
interface Cell {
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// ---------- 坐标与选区 ----------

function screenRect(term: Terminal): DOMRect | null {
  const rect = term.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function cellHeight(term: Terminal): number {
  const rect = screenRect(term);
  return rect ? rect.height / term.rows : 16;
}

function charAt(term: Terminal, x: number, y: number): { ch: string; width: number } {
  const cell = term.buffer.active.getLine(y)?.getCell(x);
  return { ch: cell?.getChars() ?? '', width: cell?.getWidth() ?? 1 };
}

/** 屏幕坐标所在的格子（超出终端时夹到边上）；落在宽字符的后半格时取前半格 */
function cellAt(term: Terminal, clientX: number, clientY: number): Cell | null {
  const rect = screenRect(term);
  if (!rect) return null;
  const col = clamp(Math.floor(((clientX - rect.left) / rect.width) * term.cols), 0, term.cols - 1);
  const row = clamp(Math.floor(((clientY - rect.top) / rect.height) * term.rows), 0, term.rows - 1);
  const y = row + term.buffer.active.viewportY;
  const x = col > 0 && charAt(term, col, y).width === 0 ? col - 1 : col;
  return { x, y };
}

/** 词里的字符：字母、数字（含中日韩文字）以及路径、网址、参数里常见的符号；空格、框线、引号、括号是分隔 */
const WORD_CHAR = /[\p{L}\p{N}_\-./~:@%+=?&#$*]/u;
const isWord = (ch: string) => ch !== '' && WORD_CHAR.test(ch);

/** 宽字符的前半格要连同后半格一起选 */
const lastCellOf = (term: Terminal, x: number, y: number) => x + (charAt(term, x, y).width === 2 ? 1 : 0);

/** 手指下的词：[起点, 终点]（都包含） */
function wordAt(term: Terminal, cell: Cell): [Cell, Cell] {
  const { y } = cell;
  if (!isWord(charAt(term, cell.x, y).ch)) return [cell, { x: lastCellOf(term, cell.x, y), y }];
  let start = cell.x;
  while (start > 0) {
    let prev = start - 1;
    if (prev > 0 && charAt(term, prev, y).width === 0) prev--;
    if (!isWord(charAt(term, prev, y).ch)) break;
    start = prev;
  }
  let end = cell.x;
  for (;;) {
    const next = end + (charAt(term, end, y).width === 2 ? 2 : 1);
    if (next >= term.cols || !isWord(charAt(term, next, y).ch)) break;
    end = next;
  }
  return [{ x: start, y }, { x: lastCellOf(term, end, y), y }];
}

const before = (a: Cell, b: Cell) => a.y < b.y || (a.y === b.y && a.x < b.x);

/** 选中 a 到 b（顺序不限，两端都包含） */
function selectBetween(term: Terminal, a: Cell, b: Cell): void {
  const [start, end] = before(b, a) ? [b, a] : [a, b];
  const endX = lastCellOf(term, end.x, end.y);
  term.select(start.x, start.y, Math.max(1, (end.y - start.y) * term.cols + (endX - start.x) + 1));
}

/** 当前选区，终点改成包含的格子（xterm 给的终点是“最后一格之后”） */
function selectionRange(term: Terminal): [Cell, Cell] | null {
  const position = term.getSelectionPosition();
  if (!position) return null;
  const start = { x: position.start.x, y: position.start.y };
  let end = { x: position.end.x - 1, y: position.end.y };
  if (end.x < 0) end = { x: term.cols - 1, y: end.y - 1 };
  return before(end, start) ? null : [start, end];
}

// ---------- 浮层：拖动柄、操作栏、字号提示 ----------

const layer = el('div', 'cs-sel-layer');
const startHandle = el('div', 'cs-sel-handle is-start');
const endHandle = el('div', 'cs-sel-handle is-end');
const bar = el('div', 'cs-sel-bar');
const copyButton = el('button', '');
const allButton = el('button', '');
const pasteButton = el('button', '');
/** 网页版选中文字后会浮出“询问 AI 助手”（登录且 AI 可用时）；浮动栏显示时把它收进这里，免得盖住拖动柄 */
const askButton = el('button', '');
for (const button of [copyButton, allButton, pasteButton, askButton]) button.type = 'button';
bar.append(copyButton, allButton, pasteButton, askButton);
layer.append(startHandle, endHandle, bar);
const hud = el('div', 'cs-pinch-hud');

let current: Terminal | null = null;
let uiShown = false;
let watching: IDisposable[] = [];
const watched = new WeakSet<Terminal>();

function applyTexts(): void {
  copyButton.textContent = mt('selCopy');
  allButton.textContent = mt('selAll');
  pasteButton.textContent = mt('selPaste');
  askButton.textContent = mt('selAsk');
}

const upstreamAskButton = () => document.getElementById('ask-ai-selection-btn');

function hideUi(): void {
  uiShown = false;
  layer.classList.remove('is-on');
  document.documentElement.classList.remove('cs-sel-on');
}

function clearSelection(): void {
  current?.clearSelection();
  hideUi();
}

function place(node: HTMLElement, x: number, y: number, visible: boolean): void {
  node.hidden = !visible;
  if (visible) node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** 按当前选区摆放拖动柄与操作栏；终端被收起、选区消失时隐藏 */
function positionUi(): void {
  const term = current;
  const range = term && uiShown ? selectionRange(term) : null;
  const rect = term ? screenRect(term) : null;
  if (!term || !range || !rect) {
    hideUi();
    return;
  }
  layer.classList.add('is-on');
  document.documentElement.classList.add('cs-sel-on');
  const ask = upstreamAskButton();
  askButton.hidden = !ask || ask.classList.contains('hidden');
  const width = rect.width / term.cols;
  const height = rect.height / term.rows;
  const top = term.buffer.active.viewportY;
  const startRow = range[0].y - top;
  const endRow = range[1].y - top;
  const onScreen = (row: number) => row >= 0 && row < term.rows;
  place(startHandle, rect.left + range[0].x * width, rect.top + (startRow + 1) * height, onScreen(startRow));
  place(endHandle, rect.left + (range[1].x + 1) * width, rect.top + (endRow + 1) * height, onScreen(endRow));

  // 操作栏放在选区上方；上方放不下就放到选区下面（拖动柄的下方），都不行就贴着终端顶部
  const barHeight = bar.offsetHeight || 44;
  const barWidth = bar.offsetWidth || 220;
  const firstRow = clamp(startRow, 0, term.rows - 1);
  const lastRow = clamp(endRow, 0, term.rows - 1);
  let y = rect.top + firstRow * height - barHeight - 10;
  if (y < rect.top + 4) y = rect.top + (lastRow + 1) * height + 30;
  if (y + barHeight > rect.bottom - 4) y = rect.top + 8;
  const x = clamp(rect.left + ((range[0].x + range[1].x + 1) / 2) * width - barWidth / 2, 8, window.innerWidth - barWidth - 8);
  place(bar, x, y, true);
}

let positionFrame = 0;
function schedulePosition(): void {
  if (positionFrame || !uiShown) return;
  positionFrame = requestAnimationFrame(() => {
    positionFrame = 0;
    positionUi();
  });
}

/** 有选区就显示浮层：长按选出的、网页版选择模式选出的、双击选出的都一样 */
function watch(term: Terminal): void {
  if (watched.has(term)) return;
  watched.add(term);
  term.onSelectionChange(() => {
    // 长按后手指还在拖：松手再显示拖动柄和操作栏
    if (dragging?.term === term) return;
    if (term.hasSelection()) {
      if (current !== term) attach(term);
      uiShown = true;
      schedulePosition();
    } else if (current === term) {
      hideUi();
    }
  });
}

function attach(term: Terminal): void {
  for (const disposable of watching) disposable.dispose();
  current = term;
  watching = [
    term.onRender(schedulePosition),
    term.onScroll(schedulePosition),
    term.onResize(schedulePosition),
    // 开始打字就收起，与系统输入框一致
    term.onData(() => {
      if (uiShown) clearSelection();
    }),
  ];
}

// ---------- 操作栏 ----------

/** 网页版的选择模式（工具栏“复制”按钮）开着时一并退出 */
function leaveUpstreamSelectionMode(term: Terminal): void {
  if (term.element?.closest('.mobile-selection-mode')) document.getElementById('mobile-copy-btn')?.click();
}

copyButton.addEventListener('click', async () => {
  const term = current;
  if (!term) return;
  const text = term.getSelection();
  if (!text) {
    notify(mt('selNothing'), { variant: 'info', duration: 1500 });
    return;
  }
  clearSelection();
  leaveUpstreamSelectionMode(term);
  if (await copyTextToClipboard(text)) notify(mt('selCopied', { n: text.length }), { variant: 'success', duration: 1500 });
});

allButton.addEventListener('click', () => {
  current?.selectAll();
});

askButton.addEventListener('click', () => {
  // 网页版按当前选区打开 AI 助手并附上选中的内容
  upstreamAskButton()?.click();
  hideUi();
});

pasteButton.addEventListener('click', async () => {
  const term = current;
  if (!term) return;
  clearSelection();
  leaveUpstreamSelectionMode(term);
  // 走网页版自己的粘贴（会检查 Shell 是否就绪）；没有这个按钮时直接交给 xterm
  const upstream = document.getElementById('mobile-paste-btn');
  if (upstream) {
    upstream.click();
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch {
    // 没有剪贴板权限：什么也不做
  }
});

// 操作栏上的点击不要传到终端（否则会被当成“点其他地方”而取消选区）
bar.addEventListener('pointerdown', (event) => event.stopPropagation());

// ---------- 拖动柄 ----------

let autoScrollTimer = 0;
function stopAutoScroll(): void {
  window.clearInterval(autoScrollTimer);
  autoScrollTimer = 0;
}

/** 手指靠近终端上下边缘时自动滚动，每滚一行重新计算选区 */
function autoScroll(term: Terminal, clientY: number, update: () => void): void {
  const rect = screenRect(term);
  const edge = cellHeight(term);
  const direction = rect ? (clientY < rect.top + edge ? -1 : clientY > rect.bottom - edge ? 1 : 0) : 0;
  if (!direction) {
    stopAutoScroll();
    return;
  }
  if (autoScrollTimer) return;
  autoScrollTimer = window.setInterval(() => {
    term.scrollLines(direction);
    update();
  }, AUTOSCROLL_MS);
}

function bindHandle(handle: HTMLElement, which: 'start' | 'end'): void {
  handle.addEventListener('pointerdown', (event) => {
    const term = current;
    const range = term ? selectionRange(term) : null;
    if (!term || !range) return;
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    const fixed = which === 'start' ? range[1] : range[0];
    let lastX = event.clientX;
    let lastY = event.clientY;
    // 手指按在文字下方的拖动柄上：取手指上方大约一行处的格子
    const update = () => {
      const cell = cellAt(term, lastX, lastY - cellHeight(term) * 0.9);
      if (cell) selectBetween(term, fixed, cell);
    };
    const move = (moveEvent: PointerEvent) => {
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      update();
      autoScroll(term, lastY - cellHeight(term) * 0.9, update);
    };
    const end = () => {
      stopAutoScroll();
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

bindHandle(startHandle, 'start');
bindHandle(endHandle, 'end');

// ---------- 终端上的手势 ----------

interface Press {
  term: Terminal;
  pointerId: number;
  x: number;
  y: number;
  timer: number;
  /** 按下时浮层开着：没有长按、没有移动就是“点其他地方” → 取消选区 */
  dismiss: boolean;
}

let press: Press | null = null;
/** 长按后正在拖动扩大选区 */
let dragging: { term: Terminal; pointerId: number; word: [Cell, Cell]; x: number; y: number } | null = null;
/**
 * 双指缩放。手指数用 TouchEvent.touches（系统维护的、此刻真正按在屏幕上的手指）判断，不自己记指针：
 * 部分机型偶尔漏发一次抬起事件，自己记的列表里就会残留一根“手指”，之后单指上下拖动会被当成捏合、改了字号。
 * 另外两根手指要几乎同时按下（防止握持时贴在曲面屏边缘的手掌算成第二根手指），
 * 间距变化超过阈值才开始调字号（防止双指轻触时字号跳动）。
 */
let pinch: { term: Terminal; startDistance: number; startSize: number; size: number; active: boolean } | null = null;
const PINCH_START_WINDOW_MS = 400;
const PINCH_THRESHOLD = 24;
/** 每根手指按下的时间（Touch.identifier → 时间） */
const touchStarts = new Map<number, number>();
let swallowUntil = 0;
let lastTouchOnTerminal = 0;
/** 上一次轻点（判断双击）：双击选中一个词。xterm 自己的双击选词会走“Linux 主选区”逻辑——安卓的 platform 是 Linux——
 *  把词塞进隐藏输入框选中并聚焦，于是出现系统的复制/分享菜单，所以双击由这里处理、xterm 收不到 */
let lastTap: { term: Terminal; x: number; y: number; time: number } | null = null;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DISTANCE = 28;

const touchDistance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

function beginLongPress(pending: Press): void {
  press = null;
  lastTap = null;
  const term = pending.term;
  const cell = cellAt(term, pending.x, pending.y);
  if (!cell) return;
  watch(term);
  const word = wordAt(term, cell);
  selectBetween(term, word[0], word[1]);
  dragging = { term, pointerId: pending.pointerId, word, x: pending.x, y: pending.y };
  try {
    navigator.vibrate?.(10);
  } catch {
    // 不支持振动
  }
}

function extendDrag(): void {
  if (!dragging) return;
  const { term, word, x, y } = dragging;
  const cell = cellAt(term, x, y);
  if (!cell) return;
  if (before(cell, word[0])) selectBetween(term, cell, word[1]);
  else selectBetween(term, word[0], before(word[1], cell) ? cell : word[1]);
}

let fontFrame = 0;
function applyFontLive(size: number): void {
  (globalThis as { __cloudsshTerminalFontSize?: number }).__cloudsshTerminalFontSize = size;
  if (fontFrame) return;
  fontFrame = requestAnimationFrame(() => {
    fontFrame = 0;
    window.dispatchEvent(new Event('resize'));
  });
}

let hudTimer = 0;
function showHud(size: number): void {
  hud.textContent = mt('fontSizeHud', { n: size });
  hud.classList.add('is-on');
  window.clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => hud.classList.remove('is-on'), 700);
}

function startPinch(term: Terminal, startDistance: number): void {
  if (press) window.clearTimeout(press.timer);
  press = null;
  dragging = null;
  stopAutoScroll();
  // 字号设置只在黑曜主题生效（经典主题保持网页版的自动字号）
  if (skinState().skin !== 'obsidian') return;
  const size = skinState().fontSize || currentTerminalFontSize();
  pinch = { term, startDistance: Math.max(1, startDistance), startSize: size, size, active: false };
}

function endPinch(): void {
  if (!pinch) return;
  const { size, active } = pinch;
  pinch = null;
  swallowUntil = Date.now() + SWALLOW_MS;
  if (active && size !== skinState().fontSize) {
    updateSkin((draft) => {
      draft.fontSize = size;
    });
  }
}

const onTerminalScreen = (touch: Touch) => !!(touch.target as Element | null)?.closest?.('.xterm-screen');

function onTouchStart(event: TouchEvent): void {
  const now = Date.now();
  const live = new Set([...event.touches].map((touch) => touch.identifier));
  for (const id of touchStarts.keys()) if (!live.has(id)) touchStarts.delete(id);
  for (const touch of event.changedTouches) touchStarts.set(touch.identifier, now);
  if (pinch || event.touches.length !== 2) return;
  const [a, b] = [...event.touches];
  const term = terminalFor(a.target as Element);
  if (!term || terminalFor(b.target as Element) !== term || !onTerminalScreen(a) || !onTerminalScreen(b)) return;
  const startedApart = Math.abs((touchStarts.get(a.identifier) ?? 0) - (touchStarts.get(b.identifier) ?? 0));
  if (startedApart > PINCH_START_WINDOW_MS) return;
  startPinch(term, touchDistance(a, b));
}

function onTouchMove(event: TouchEvent): void {
  if (!pinch || event.touches.length < 2) return;
  const distance = touchDistance(event.touches[0], event.touches[1]);
  if (!pinch.active) {
    if (Math.abs(distance - pinch.startDistance) < PINCH_THRESHOLD) return;
    pinch.active = true;
    if (uiShown) clearSelection();
  }
  const size = clamp(Math.round(pinch.startSize * (distance / pinch.startDistance)), FONT_SIZE_MIN, FONT_SIZE_MAX);
  if (size !== pinch.size) {
    pinch.size = size;
    applyFontLive(size);
  }
  showHud(size);
}

function onTouchEnd(event: TouchEvent): void {
  for (const touch of event.changedTouches) touchStarts.delete(touch.identifier);
  // 抬起一根手指时停止缩放，但等全部抬起再交还给网页版（否则剩下那根手指会接着滚动，画面跳一下）
  if (pinch && event.touches.length === 0) endPinch();
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType !== 'touch') return;
  const term = terminalFor(event.target as Element);
  if (!term || !(event.target as Element).closest('.xterm-screen')) return;
  lastTouchOnTerminal = Date.now();
  watch(term);
  // 第二根及以后的手指：不是长按（可能是双指缩放，由 touch 事件判断）
  if (!event.isPrimary) {
    if (press) window.clearTimeout(press.timer);
    press = null;
    return;
  }
  // 新的第一根手指按下：上一次缩放必定已经结束（兜底，正常由 touchend 结束）
  if (pinch) endPinch();
  // 网页版的选择模式开着时由它自己处理拖动选择
  if (term.element?.closest('.mobile-selection-mode')) return;
  const pending: Press = {
    term,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    timer: 0,
    dismiss: uiShown,
  };
  pending.timer = window.setTimeout(() => beginLongPress(pending), LONG_PRESS_MS);
  press = pending;
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerType !== 'touch') return;
  if (pinch) {
    // 缩放中两根手指的移动都不交给网页版（不滚动）
    event.stopImmediatePropagation();
    return;
  }
  if (dragging && dragging.pointerId === event.pointerId) {
    event.stopImmediatePropagation();
    dragging.x = event.clientX;
    dragging.y = event.clientY;
    extendDrag();
    autoScroll(dragging.term, event.clientY, extendDrag);
    return;
  }
  if (press && press.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE) {
    // 动了：是滚动，不是长按，也不算“点其他地方”
    window.clearTimeout(press.timer);
    press = null;
  }
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerType !== 'touch' || pinch) return;
  if (dragging && dragging.pointerId === event.pointerId) {
    const term = dragging.term;
    dragging = null;
    stopAutoScroll();
    swallowUntil = Date.now() + SWALLOW_MS;
    if (current !== term) attach(term);
    uiShown = term.hasSelection();
    schedulePosition();
    return;
  }
  if (press && press.pointerId === event.pointerId) {
    window.clearTimeout(press.timer);
    const tap = press;
    press = null;
    const now = Date.now();
    const previous = lastTap;
    if (previous && previous.term === tap.term && now - previous.time < DOUBLE_TAP_MS && Math.hypot(tap.x - previous.x, tap.y - previous.y) < DOUBLE_TAP_DISTANCE) {
      lastTap = null;
      const cell = cellAt(tap.term, tap.x, tap.y);
      // 双击空白处什么也不选（长按空白处仍可以从这里开始拖选）
      if (cell && isWord(charAt(tap.term, cell.x, cell.y).ch)) {
        const word = wordAt(tap.term, cell);
        selectBetween(tap.term, word[0], word[1]);
      }
      swallowUntil = now + SWALLOW_MS;
      return;
    }
    lastTap = { term: tap.term, x: tap.x, y: tap.y, time: now };
    if (tap.dismiss) {
      clearSelection();
      swallowUntil = now + SWALLOW_MS;
    }
  }
}

/** 手势之后浏览器补发的兼容鼠标事件：xterm 会据此聚焦（弹键盘）或当作点击 */
function swallow(event: Event): void {
  if (Date.now() >= swallowUntil || !(event.target as Element | null)?.closest?.('.xterm')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function installTerminalTouch(): void {
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  applyTexts();
  onLocaleChange(applyTexts);
  document.body.append(layer, hud);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) document.addEventListener(type, swallow, true);
  document.addEventListener(
    'touchend',
    (event) => {
      if (Date.now() < swallowUntil && (event.target as Element | null)?.closest?.('.xterm')) event.preventDefault();
    },
    { capture: true, passive: false }
  );
  // 长按的系统菜单：在终端上一律拦掉（xterm 收到会把隐藏输入框挪过来并聚焦）
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!terminalFor(event.target as Element) || Date.now() - lastTouchOnTerminal > 2000) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
  window.addEventListener('resize', schedulePosition);
  // 切换会话、回到节点页时终端被收起：浮层跟着隐藏
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hideUi();
  });
}

