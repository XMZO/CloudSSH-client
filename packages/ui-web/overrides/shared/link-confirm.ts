/**
 * 终端里点链接先确认（电脑与手机共用），确认条尽量不挡终端里的内容（一屏里常常是一串链接）：
 * - 点到的那个链接在终端里高亮，知道确认的是哪一个
 * - 手机：一条细长的确认条停在屏幕顶部（盖在标题栏上，和提示条同一个位置），不盖住任何一行终端内容
 * - 电脑：一行小条贴在链接那一行的下面（下面放不下就放上面），最多挡住一行
 * - 地址只占一行：开头和结尾都留着，中间省略；点地址展开完整地址，再点收起
 * - 复制、打开、关闭；点别处或 Esc 关闭，电脑上回车打开。电脑上按住 Ctrl（mac 上 ⌘）单击直接打开，不弹确认条
 *
 * 接管方式：xterm 的链接插件点了链接就先 window.open() 一个空白页、再设 location.href。这里接管不带地址的
 * window.open()，设地址时走确认；OSC 8 超链接（ls --hyperlink 等）的处理函数也换成这里（xterm 默认弹浏览器自带的
 * confirm()）。只处理 http(s)。
 */
import type { IDecoration, ILinkHandler, IMarker, Terminal } from '@xterm/xterm';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { getLocale } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import './link-confirm.css';

const zhCN = {
  title: '打开链接？',
  open: '打开',
  copy: '复制链接',
  close: '关闭',
  copied: '已复制链接',
  failed: '打不开这个链接',
  expand: '点一下看完整地址',
  openHint: '回车打开；{key}+单击链接直接打开',
};
type Key = keyof typeof zhCN;
const dictionaries: Record<string, Record<Key, string>> = {
  'zh-CN': zhCN,
  'zh-TW': {
    title: '開啟連結？',
    open: '開啟',
    copy: '複製連結',
    close: '關閉',
    copied: '已複製連結',
    failed: '無法開啟這個連結',
    expand: '按一下看完整網址',
    openHint: 'Enter 開啟；{key}+按一下連結直接開啟',
  },
  'en-US': {
    title: 'Open link?',
    open: 'Open',
    copy: 'Copy link',
    close: 'Close',
    copied: 'Link copied',
    failed: 'Could not open this link',
    expand: 'Tap to see the full address',
    openHint: 'Enter to open; {key}+click a link to open it directly',
  },
};
const lt = (key: Key, params: Record<string, string> = {}) =>
  (dictionaries[getLocale()]?.[key] ?? zhCN[key]).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '');

export interface LinkConfirmOptions {
  /** 交给系统浏览器打开 */
  open: (url: string) => void | Promise<void>;
  /** 电脑：确认条贴在链接旁边，按住 Ctrl / ⌘ 单击直接打开，打开按钮获得焦点（回车即打开）。手机：见 place */
  desktop: boolean;
  /**
   * 手机：把确认条摆到页面上借用的位置（底部操作行），摆好了返回 true；没有合适位置时停在屏幕顶部。
   * 键盘弹出 / 收起后会再调用一次
   */
  place?: (bar: HTMLElement) => boolean;
}

/** 最近一次鼠标抬起（xterm 在 mouseup 里打开链接）：位置、有没有按着 Ctrl */
let lastUp: { x: number; y: number; modifier: boolean; at: number } | null = null;
/** 鼠标现在的位置（电脑：确认条关掉后让 xterm 重新认出鼠标下的链接） */
let pointer: { x: number; y: number } | null = null;
let options: LinkConfirmOptions | null = null;
let closeBar: (() => void) | null = null;
let resolveTerminal: (node: Element | null) => Terminal | null = () => null;

/** 由终端增强模块登记：页面上某个节点所在的终端（用来高亮点到的链接） */
export function setLinkTerminalResolver(resolver: (node: Element | null) => Terminal | null): void {
  resolveTerminal = resolver;
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

function isWebLink(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function openNow(url: string): Promise<void> {
  try {
    await options?.open(url);
  } catch {
    notify(lt('failed'), { variant: 'warning' });
  }
}

interface Spot {
  term: Terminal;
  /** 这一行在屏幕上的上下边 */
  lineTop: number;
  lineBottom: number;
  /** 链接（这一行里的那一段）在屏幕上的左边；没认出是哪一段时为 null */
  linkLeft: number | null;
  mark: { marker: IMarker; decoration: IDecoration } | null;
}

/** 在点的位置找到链接所在的那一段（一行里连续的非空白字符，且是这个地址的一部分），高亮它 */
function locate(url: string, x: number, y: number): Spot | null {
  const element = document.elementFromPoint(x, y);
  const term = resolveTerminal(element);
  const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!term || !screen || !term.rows || !term.cols) return null;
  const rect = screen.getBoundingClientRect();
  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;
  const column = Math.floor((x - rect.left) / cellWidth);
  const viewRow = Math.floor((y - rect.top) / cellHeight);
  if (column < 0 || column >= term.cols || viewRow < 0 || viewRow >= term.rows) return null;
  const buffer = term.buffer.active;
  const row = buffer.viewportY + viewRow;
  const spot: Spot = { term, lineTop: rect.top + viewRow * cellHeight, lineBottom: rect.top + (viewRow + 1) * cellHeight, linkLeft: null, mark: null };
  const line = buffer.getLine(row);
  if (!line) return spot;
  const chars = (column_: number) => line.getCell(column_)?.getChars() ?? '';
  const blank = (column_: number) => !chars(column_).trim();
  if (blank(column)) return spot;
  let start = column;
  let end = column;
  while (start > 0 && !blank(start - 1)) start--;
  while (end < term.cols - 1 && !blank(end + 1)) end++;
  let word = '';
  for (let c = start; c <= end; c++) word += chars(c);
  // 词比地址长（如带着括号、逗号）：只高亮地址那一段；词是地址的一部分（地址折行了）：整词高亮
  const inside = word.indexOf(url);
  if (inside >= 0) {
    start += inside;
    end = start + url.length - 1;
  } else if (!url.includes(word)) {
    return spot;
  }
  spot.linkLeft = rect.left + start * cellWidth;
  const marker = term.registerMarker(row - (buffer.baseY + buffer.cursorY));
  if (!marker) return spot;
  const decoration = term.registerDecoration({ marker, x: start, width: end - start + 1, layer: 'top' });
  if (!decoration) {
    marker.dispose();
    return spot;
  }
  decoration.onRender((el) => el.classList.add('cs-link-mark'));
  spot.mark = { marker, decoration };
  return spot;
}

/**
 * 电脑上确认条盖在链接那一行、正好在鼠标下面：xterm 以为鼠标离开了链接，确认条关掉后它只在鼠标换到另一格时
 * 才重新找链接，不动鼠标接着 Ctrl+单击就点不开。关掉后在鼠标所在处补两次移动（旁边一格、再回来），让它重新认出来
 */
function refreshHover(): void {
  if (!pointer) return;
  const { x, y } = pointer;
  const target = document.elementFromPoint(x, y);
  if (!target?.closest('.xterm-screen')) return;
  for (const dx of [12, 0]) target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + dx, clientY: y }));
}

function iconButton(icon: string, label: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `cs-link-icon-btn ${className}`.trim();
  button.setAttribute('aria-label', label);
  button.title = label;
  const glyph = document.createElement('span');
  glyph.className = 'material-symbols-outlined';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = icon;
  button.append(glyph);
  return button;
}

/** 一行显示的地址：开头省略在中间，结尾一段留着（看得到是哪个文件、哪个参数） */
function addressView(url: string): HTMLElement {
  const text = document.createElement('div');
  text.className = 'cs-link-text';
  text.title = lt('expand');
  const tailLength = url.length > 36 ? 16 : 0;
  const head = document.createElement('span');
  head.className = 'cs-link-head';
  head.textContent = tailLength ? url.slice(0, -tailLength) : url;
  text.append(head);
  if (tailLength) {
    const tail = document.createElement('span');
    tail.className = 'cs-link-tail';
    tail.textContent = url.slice(-tailLength);
    text.append(tail);
  }
  const full = document.createElement('span');
  full.className = 'cs-link-full';
  full.textContent = url;
  text.append(full);
  return text;
}

function showBar(url: string, at: { x: number; y: number } | null): void {
  closeBar?.();
  const desktop = options?.desktop === true;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const spot = at ? locate(url, at.x, at.y) : null;

  const bar = document.createElement('div');
  bar.className = `cs-link-bar ${desktop ? 'is-desktop' : 'is-mobile'}`;
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', lt('title'));
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined cs-link-glyph';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'link';
  const text = addressView(url);
  const copy = iconButton('content_copy', lt('copy'));
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'cs-link-open';
  open.textContent = lt('open');
  if (desktop) open.title = lt('openHint', { key: isMac() ? '⌘' : 'Ctrl' });
  const dismiss = iconButton('close', lt('close'), 'cs-link-dismiss');
  bar.append(icon, text, copy, open, dismiss);
  bar.style.visibility = 'hidden';
  document.body.append(bar);

  // 电脑：盖在链接自己那一行上（确认条里就是这个地址，不丢信息），地址与链接左边对齐，上下只压到相邻两行的一点边；
  // 认不出链接在哪一段时贴在那一行下面（放不下就放上面）。左右不出窗口。
  // 手机：盖在底部操作行上（快捷命令条 / 快捷键栏，在键盘上方），不挡终端内容和顶栏按钮；没有时停在顶部（样式里定好）
  const margin = 8;
  const place = (keepTop: boolean) => {
    if (!desktop) {
      bar.classList.toggle('in-slot', options?.place?.(bar) === true);
      return;
    }
    const rect = bar.getBoundingClientRect();
    const textOffset = text.getBoundingClientRect().left - rect.left + 6;
    const x = spot?.linkLeft != null ? spot.linkLeft - textOffset : (at?.x ?? innerWidth / 2) - 28;
    // 不伸到终端区域外面（左边是侧栏）
    const area = spot?.term.element?.getBoundingClientRect();
    const minLeft = area ? Math.max(margin, area.left + 2) : margin;
    const maxLeft = (area ? Math.min(innerWidth - margin, area.right - 2) : innerWidth - margin) - rect.width;
    const left = Math.max(minLeft, Math.min(x, maxLeft));
    bar.style.left = `${Math.round(left)}px`;
    if (keepTop) return;
    const lineTop = spot?.lineTop ?? (at?.y ?? innerHeight / 3) - 8;
    const lineBottom = spot?.lineBottom ?? (at?.y ?? innerHeight / 3) + 8;
    let top: number;
    if (spot?.linkLeft != null) top = (lineTop + lineBottom) / 2 - rect.height / 2;
    else top = lineBottom + 2 + rect.height + margin <= innerHeight ? lineBottom + 2 : lineTop - 2 - rect.height;
    bar.style.top = `${Math.round(Math.min(Math.max(margin, top), innerHeight - rect.height - margin))}px`;
  };
  place(false);
  bar.style.visibility = '';
  requestAnimationFrame(() => bar.classList.add('is-visible'));

  // 手机上键盘弹出 / 收起后操作行挪了位置：跟着挪
  const onViewport = () => place(false);
  if (!desktop) window.visualViewport?.addEventListener('resize', onViewport, { passive: true });

  const close = (restoreFocus = true) => {
    if (closeBar !== close) return;
    closeBar = null;
    window.visualViewport?.removeEventListener('resize', onViewport);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    spot?.mark?.decoration.dispose();
    spot?.mark?.marker.dispose();
    bar.remove();
    if (restoreFocus && desktop && previousFocus?.isConnected) previousFocus.focus();
    if (desktop) requestAnimationFrame(refreshHover);
  };
  const onOutside = (event: Event) => {
    if (!bar.contains(event.target as Node)) close(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  closeBar = close;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  text.addEventListener('click', () => {
    bar.classList.toggle('is-expanded');
    // 展开 / 收起时上边不动，往下长
    place(true);
  });
  open.addEventListener('click', () => {
    close();
    void openNow(url);
  });
  dismiss.addEventListener('click', () => close());
  copy.addEventListener('click', () => {
    close();
    void copyTextToClipboard(url).then((ok) => ok && notify(lt('copied'), { variant: 'success', duration: 1500 }));
  });
  // 电脑上回车即打开；手机上不抢焦点（抢走终端的焦点会收起键盘）
  if (desktop) open.focus({ preventScroll: true });
}

/** 点了一个链接：按着 Ctrl 的直接打开，否则弹确认条 */
function requestOpen(url: string, event?: MouseEvent): void {
  if (!isWebLink(url)) return;
  // 没装上（不该发生）：照网页版原样打开
  if (!options) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const recent = lastUp && performance.now() - lastUp.at < 300 ? lastUp : null;
  const modifier = event ? event.ctrlKey || event.metaKey : (recent?.modifier ?? false);
  if (options.desktop && modifier) {
    closeBar?.();
    void openNow(url);
    return;
  }
  const point = event ? { x: event.clientX, y: event.clientY } : recent;
  showBar(url, point ? { x: point.x, y: point.y } : null);
}

/** OSC 8 超链接：xterm 默认弹浏览器自带的 confirm()，换成同一个确认条 */
export const confirmLinkHandler: ILinkHandler = {
  activate: (event, text) => requestOpen(text, event),
  allowNonHttpProtocols: false,
};

export function installLinkConfirm(config: LinkConfirmOptions): void {
  if (options) return;
  options = config;
  document.addEventListener(
    'mouseup',
    (event) => {
      lastUp = { x: event.clientX, y: event.clientY, modifier: event.ctrlKey || event.metaKey, at: performance.now() };
    },
    true
  );
  if (config.desktop) {
    document.addEventListener(
      'mousemove',
      (event) => {
        if (event.isTrusted) pointer = { x: event.clientX, y: event.clientY };
      },
      { capture: true, passive: true }
    );
  }
  const nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (url !== undefined && url !== '' && String(url) !== 'about:blank') return nativeOpen(url, target, features);
    // 链接插件：先开空白页、再设地址。给它一个替身，设地址时走确认
    const location = {
      set href(value: string) {
        requestOpen(value);
      },
      get href() {
        return 'about:blank';
      },
    };
    return { opener: null, location, close() {}, focus() {} } as unknown as Window;
  }) as typeof window.open;
}
