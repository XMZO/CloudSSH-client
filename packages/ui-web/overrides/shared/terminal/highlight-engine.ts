/**
 * 终端关键词高亮引擎。
 *
 * 不改写 SSH 输出流（往数据里插颜色转义会破坏 vim、htop 这类全屏程序和程序自己的着色），
 * 而是在 xterm 渲染层叠加“前景色装饰”：
 * - 只扫描屏幕上能看到的行（折行会先拼回整行再匹配），装饰随滚动重建，看不到的行不占内存
 * - 只给没有颜色的字符上色（ls、grep 等程序自己着色的部分保持原样）；反色的字符也不动
 * - 全屏程序（备用缓冲区，例如 vim、htop、less）里不高亮
 * - 同一字符只取最先匹配的规则；隐藏的标签页不扫描，切回来时再补
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

  constructor(
    private readonly term: Terminal,
    private readonly rules: () => CompiledRule[],
    private readonly color: (hex: string) => string
  ) {
    const schedule = () => this.schedule();
    this.listeners = [
      term.onWriteParsed(schedule),
      term.onScroll(schedule),
      term.onResize(schedule),
      term.buffer.onBufferChange(schedule),
      // 切换标签后终端重新显示时会重绘一次；装饰没变时扫描结果相同，不会再触发重绘
      term.onRender(schedule),
    ];
  }

  schedule(): void {
    if (this.disposed || this.timer) return;
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
    // 隐藏的标签页（display:none）不扫描，保留现有装饰
    if (!element.isConnected || element.offsetParent === null) return;
    const buffer = term.buffer.active;
    const rules = this.rules();
    if (!rules.length || buffer.type === 'alternate') {
      this.clear();
      return;
    }

    const spans = this.collect(rules);
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
