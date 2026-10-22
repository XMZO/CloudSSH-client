/**
 * 终端里点链接先确认（电脑与手机共用）。
 *
 * xterm 的链接插件点了链接就打开：先 window.open() 一个空白页、再把它的 location.href 设成链接地址，
 * 客户端再交给系统浏览器。这里接管不带地址的 window.open()：设地址时先在点的位置弹一张小卡片，
 * 显示完整地址，可以打开、复制或取消（点卡片外面、Esc 也是取消；电脑上回车打开）。
 * 电脑上按住 Ctrl（mac 上 ⌘）单击直接打开，不弹卡片。OSC 8 超链接（ls --hyperlink 等）走同一张卡片。
 * 只处理 http(s)：其他地址（xterm 本来也不认）原样交回。
 */
import type { ILinkHandler } from '@xterm/xterm';
import { copyTextToClipboard } from '../../upstream/frontend/src/clipboard';
import { getLocale } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import './link-confirm.css';

const zhCN = {
  title: '打开链接？',
  open: '打开',
  copy: '复制',
  cancel: '取消',
  copied: '已复制链接',
  failed: '打不开这个链接',
  hint: '{key}+单击链接直接打开',
};
type Key = keyof typeof zhCN;
const dictionaries: Record<string, Record<Key, string>> = {
  'zh-CN': zhCN,
  'zh-TW': { title: '開啟連結？', open: '開啟', copy: '複製', cancel: '取消', copied: '已複製連結', failed: '無法開啟這個連結', hint: '{key}+按一下連結直接開啟' },
  'en-US': { title: 'Open link?', open: 'Open', copy: 'Copy', cancel: 'Cancel', copied: 'Link copied', failed: 'Could not open this link', hint: '{key}+click a link to open it directly' },
};
const lt = (key: Key, params: Record<string, string> = {}) =>
  (dictionaries[getLocale()]?.[key] ?? zhCN[key]).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '');

export interface LinkConfirmOptions {
  /** 交给系统浏览器打开 */
  open: (url: string) => void | Promise<void>;
  /** 电脑：按住 Ctrl / ⌘ 单击直接打开，卡片上提示这个用法，打开按钮获得焦点（回车即打开） */
  desktop: boolean;
}

/** 最近一次鼠标抬起（xterm 在 mouseup 里打开链接）：卡片位置、有没有按着 Ctrl */
let lastUp: { x: number; y: number; modifier: boolean; at: number } | null = null;
let options: LinkConfirmOptions | null = null;
let closeCard: (() => void) | null = null;

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

function showCard(url: string, at: { x: number; y: number } | null): void {
  closeCard?.();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const card = document.createElement('div');
  card.className = 'cs-link-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', lt('title'));

  const address = document.createElement('div');
  address.className = 'cs-link-url';
  address.textContent = url;

  const button = (label: string, icon: string, className: string) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `cs-link-btn ${className}`.trim();
    const glyph = document.createElement('span');
    glyph.className = 'material-symbols-outlined';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = icon;
    element.append(glyph, document.createTextNode(label));
    return element;
  };
  const copy = button(lt('copy'), 'content_copy', '');
  const cancel = button(lt('cancel'), 'close', '');
  const open = button(lt('open'), 'open_in_new', 'is-primary');
  const actions = document.createElement('div');
  actions.className = 'cs-link-actions';
  const spacer = document.createElement('span');
  spacer.className = 'cs-link-spacer';
  actions.append(copy, spacer, cancel, open);
  card.append(address);
  if (options?.desktop) {
    const hint = document.createElement('div');
    hint.className = 'cs-link-hint';
    hint.textContent = lt('hint', { key: isMac() ? '⌘' : 'Ctrl' });
    card.append(hint);
  }
  card.append(actions);
  card.style.visibility = 'hidden';
  document.body.append(card);

  // 摆在点的位置下面（放不下就放上面），左右不出屏幕
  const margin = 10;
  const rect = card.getBoundingClientRect();
  const viewHeight = window.visualViewport?.height ?? innerHeight;
  const x = at?.x ?? innerWidth / 2;
  const y = at?.y ?? viewHeight / 3;
  const left = Math.min(Math.max(margin, x - rect.width / 2), innerWidth - rect.width - margin);
  const below = y + 14;
  const top = below + rect.height + margin <= viewHeight ? below : Math.max(margin, y - 14 - rect.height);
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
  card.style.visibility = '';
  requestAnimationFrame(() => card.classList.add('is-visible'));

  const close = (restoreFocus = true) => {
    if (closeCard !== close) return;
    closeCard = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    card.remove();
    if (restoreFocus && options?.desktop && previousFocus?.isConnected) previousFocus.focus();
  };
  const onOutside = (event: Event) => {
    if (!card.contains(event.target as Node)) close(false);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  closeCard = close;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);

  open.addEventListener('click', () => {
    close();
    void openNow(url);
  });
  cancel.addEventListener('click', () => close());
  copy.addEventListener('click', () => {
    close();
    void copyTextToClipboard(url).then((ok) => ok && notify(lt('copied'), { variant: 'success', duration: 1500 }));
  });
  // 电脑上回车即打开；手机上不抢焦点（抢走终端的焦点会收起键盘）
  if (options?.desktop) open.focus({ preventScroll: true });
}

/** 点了一个链接：按着 Ctrl 的直接打开，否则弹确认卡片 */
function requestOpen(url: string, event?: MouseEvent): void {
  if (!isWebLink(url)) return;
  // 没装上（不该发生）：照网页版原样打开
  if (!options) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const recent = lastUp && performance.now() - lastUp.at < 300 ? lastUp : null;
  const modifier = event ? event.ctrlKey || event.metaKey : (recent?.modifier ?? false);
  if (options?.desktop && modifier) {
    closeCard?.();
    void openNow(url);
    return;
  }
  const point = event ? { x: event.clientX, y: event.clientY } : recent;
  showCard(url, point ? { x: point.x, y: point.y } : null);
}

/** OSC 8 超链接：xterm 默认弹浏览器自带的 confirm()，换成同一张卡片 */
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
