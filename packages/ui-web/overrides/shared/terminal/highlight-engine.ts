/**
 * 终端关键词高亮引擎。
 *
 * 不改写 SSH 输出流（往数据里插颜色转义会破坏 vim、htop 这类全屏程序和程序自己的着色），
 * 而是在 xterm 渲染层叠加“前景色装饰”：
 * - 只扫描屏幕上能看到的行（折行会先拼回整行再匹配），装饰随滚动重建，看不到的行不占内存
 * - 只给没有颜色的字符上色（ls、grep 等程序自己着色的部分保持原样）；反色的字符也不动
 * - 全屏程序（备用缓冲区，例如 vim、htop、less）里不高亮
 * - 同一字符只取最先匹配的规则；隐藏的标签页不扫描，切回来时再补
 *
 * 性能：每处高亮都是 xterm 叠在终端上的一个页面元素，终端每次重绘 xterm 都要把它们逐个重新摆放。刷屏（tail -f、
 * 编译输出）时这会变成每帧重排几百个元素，手机上、小字号（一屏格子多、高亮多）时明显卡顿。所以：
 * - 短时间内换行很多（刷屏）时先撤掉高亮，输出停下 300ms 后再补
 * - 一屏最多 300 处，再多只留靠下的（最新的输出）
 * - 只在终端从隐藏变为显示后的那次重绘时补扫，平时的重绘（光标闪烁等）不触发扫描
 */
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

export interface CompiledRule {
  regex: RegExp;
  color: string;
}

/** 单个逻辑行（含折行）最多扫描的字符数，防止超长行拖慢 */
const MAX_LINE_CHARS = 4000;
/** 连续输出时最多每 50ms 扫描一次 */
const SCAN_DELAY = 50;
/** 300ms 内换行达到 15 次算刷屏 */
const BURST_WINDOW = 300;
const BURST_LINES = 15;
/** 刷屏停下后等这么久再高亮 */
const QUIET_DELAY = 300;
/** 一屏最多这么多处高亮 */
const MAX_DECORATIONS = 300;

interface Entry {
  marker: IMarker;
  decoration: IDecoration;
  key: string;
}

interface Span {
  row: number;
  x: number;
  width: number;
  color: string;
}

export class TerminalHighlighter {
  private entries: Entry[] = [];
  private timer = 0;
  private disposed = false;
  private readonly listeners: { dispose(): void }[];
  /** 刷屏检测：当前窗口的起点与换行数；刷屏状态持续到这个时间 */
  private windowStart = 0;
  private windowLines = 0;
  private burstUntil = 0;
  /** 上次因为终端隐藏没扫描：下次重绘（切回来）时补上 */
  private hiddenSkipped = false;

  constructor(
    private readonly term: Terminal,
    private readonly rules: () => CompiledRule[],
    private readonly color: (hex: string) => string
  ) {
    const schedule = () => this.schedule();
    this.listeners = [
      term.onLineFeed(() => this.countLine()),
      term.onWriteParsed(() => this.onOutput()),
      term.onScroll(schedule),
      term.onResize(schedule),
      term.buffer.onBufferChange(schedule),
      // 切换标签后终端重新显示时会重绘一次：只有之前因为隐藏没扫描时才补扫
      term.onRender(() => {
        if (this.hiddenSkipped) this.schedule();
      }),
    ];
  }

  /** 每次换行调用（很频繁，只做计数） */
  private countLine(): void {
    const now = performance.now();
    if (now - this.windowStart > BURST_WINDOW) {
      this.windowStart = now;
      this.windowLines = 0;
    }
    if (++this.windowLines >= BURST_LINES) this.burstUntil = now + QUIET_DELAY;
  }

  private bursting(): boolean {
    return performance.now() < this.burstUntil;
  }

  private onOutput(): void {
    if (!this.bursting()) {
      this.schedule();
      return;
    }
    // 刷屏：先撤掉高亮，停下来再补
    if (this.entries.length) this.clear();
    this.later(QUIET_DELAY);
  }

  /** 重新计时（刷屏时每次输出都往后推） */
  private later(delay: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.scan();
    }, delay);
  }

  schedule(): void {
    if (this.disposed) return;
    if (this.bursting()) {
      this.later(QUIET_DELAY);
      return;
    }
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.scan();
    }, SCAN_DELAY);
  }

  /** 规则或配色变了：清掉重来 */
  refresh(): void {
    this.clear();
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    for (const listener of this.listeners) listener.dispose();
    this.clear();
  }

  private clear(): void {
    for (const entry of this.entries) {
      entry.decoration.dispose();
      entry.marker.dispose();
    }
    this.entries = [];
  }

  private scan(): void {
    const term = this.term;
    const element = term.element;
    if (this.disposed || !element) return;
    // 还在刷屏：等停下来
    if (this.bursting()) {
      this.later(QUIET_DELAY);
      return;
    }
    // 隐藏的标签页（display:none）不扫描，保留现有装饰，切回来重绘时补上
    if (!element.isConnected || element.offsetParent === null) {
      this.hiddenSkipped = true;
      return;
    }
    this.hiddenSkipped = false;
    const buffer = term.buffer.active;
    const rules = this.rules();
    if (!rules.length || buffer.type === 'alternate') {
      this.clear();
      return;
    }

    let spans = this.collect(rules);
    // 太多时只留靠下的（最新的输出），免得一屏几百个装饰元素拖慢重绘
    if (spans.length > MAX_DECORATIONS) spans = spans.sort((a, b) => b.row - a.row).slice(0, MAX_DECORATIONS);
    const wanted = new Map<string, Span>();
    for (const span of spans) wanted.set(`${span.row}:${span.x}:${span.width}:${span.color}`, span);

    // 已有装饰：标记跟着内容移动（滚动回收旧行时行号会变），按当前行号重新算 key 再比对
    const kept: Entry[] = [];
    for (const entry of this.entries) {
      const line = entry.marker.isDisposed ? -1 : entry.marker.line;
      const key = `${line}:${entry.key}`;
      if (line >= 0 && wanted.has(key)) {
        wanted.delete(key);
        kept.push(entry);
      } else {
        entry.decoration.dispose();
        entry.marker.dispose();
      }
    }
    this.entries = kept;

    const cursorLine = buffer.baseY + buffer.cursorY;
    for (const span of wanted.values()) {
      const marker = term.registerMarker(span.row - cursorLine);
      if (!marker) continue;
      const decoration = term.registerDecoration({
        marker,
        x: span.x,
        width: span.width,
        foregroundColor: this.color(span.color),
        layer: 'bottom',
      });
      if (!decoration) {
        marker.dispose();
        continue;
      }
      this.entries.push({ marker, decoration, key: `${span.x}:${span.width}:${span.color}` });
    }
  }

  /** 扫描可见区域，得到需要上色的片段（按行拆分） */
  private collect(rules: CompiledRule[]): Span[] {
    const term = this.term;
    const buffer = term.buffer.active;
    const top = buffer.viewportY;
    const bottom = Math.min(buffer.length - 1, top + term.rows - 1);
    const cell = buffer.getNullCell();
    const spans: Span[] = [];

    // 第一行如果是上一行的折行，从逻辑行开头算起
    let row = top;
    for (let guard = 0; row > 0 && guard < 200 && buffer.getLine(row)?.isWrapped; guard++) row--;

    while (row <= bottom) {
      const rows = [row];
      let next = row + 1;
      while (next < buffer.length && buffer.getLine(next)?.isWrapped && rows.length < 200) rows.push(next++);

      // 拼出逻辑行文本，并记下每个字符所在的单元格（宽字符占两格、只出现一次）
      let text = '';
      const owner: number[] = [];
      const cellRow: number[] = [];
      const cellCol: number[] = [];
      const cellWidth: number[] = [];
      const plain: boolean[] = [];
      for (const r of rows) {
        const line = buffer.getLine(r);
        if (!line) continue;
        for (let x = 0; x < term.cols && text.length < MAX_LINE_CHARS; x++) {
          line.getCell(x, cell);
          const width = cell.getWidth();
          if (width === 0) continue;
          const chars = cell.getChars() || ' ';
          const index = cellRow.length;
          cellRow.push(r);
          cellCol.push(x);
          cellWidth.push(width);
          plain.push(cell.isFgDefault() && !cell.isInverse());
          for (let k = 0; k < chars.length; k++) owner.push(index);
          text += chars;
        }
      }

      const taken = new Uint8Array(cellRow.length);
      for (const rule of rules) {
        const regex = rule.regex;
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text))) {
          const length = match[0].length;
          if (length === 0) {
            regex.lastIndex += 1;
            continue;
          }
          const first = owner[match.index];
          const last = owner[match.index + length - 1];
          if (first === undefined || last === undefined) continue;
          let free = true;
          for (let i = first; i <= last; i++) {
            if (taken[i]) {
              free = false;
              break;
            }
          }
          if (!free) continue;
          taken.fill(1, first, last + 1);
          // 按行切成连续的“无色”片段，只给可见行生成装饰
          let start = -1;
          for (let i = first; i <= last + 1; i++) {
            const breaks = i > last || !plain[i] || (start >= 0 && cellRow[i] !== cellRow[start]);
            if (breaks && start >= 0) {
              const end = i - 1;
              const r = cellRow[start];
              if (r >= top && r <= bottom) {
                spans.push({ row: r, x: cellCol[start], width: cellCol[end] + cellWidth[end] - cellCol[start], color: rule.color });
              }
              start = -1;
            }
            if (i <= last && plain[i] && start < 0) start = i;
          }
        }
      }
      row = next;
    }
    return spans;
  }
}

/** 浅色背景上把规则颜色压暗，保证看得清 */
export function colorAdjuster(background: string | undefined): (hex: string) => string {
  const match = /^#?([0-9a-f]{6})$/i.exec(background ?? '');
  if (!match) return (hex) => hex;
  const value = Number.parseInt(match[1], 16);
  const luminance = (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) / 255;
  if (luminance < 0.55) return (hex) => hex;
  return (hex) => {
    const rgb = Number.parseInt(hex.slice(1), 16);
    const scale = (channel: number) => Math.round(channel * 0.62);
    const out = (scale((rgb >> 16) & 255) << 16) | (scale((rgb >> 8) & 255) << 8) | scale(rgb & 255);
    return `#${out.toString(16).padStart(6, '0')}`;
  };
}
