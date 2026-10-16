/**
 * 拖动排序（鼠标与触摸通用，基于 Pointer Events）。
 *
 * 约定：可排序项带 `data-sort-key`，它们的父元素带 `data-sort-scope`（同一父元素内排序）；
 * 拖动从项内的 `[data-drag-handle]` 开始（手柄设 touch-action:none，不和列表滚动、长按菜单抢手势）。
 * 拖动时直接移动真实 DOM，松手后按新顺序回调；按过手柄的那次 click 会被吞掉，避免误触发连接/折叠。
 */

export interface SortableOptions {
  /** 委托监听的根元素（列表会整体重绘，所以只在根上监听一次） */
  root: HTMLElement;
  /** 需要自动滚动的容器（拖动开始时取） */
  scroller: () => HTMLElement;
  /** 拖动分组等大块时加到 root 上的类名（可用来暂时收起分组内容，方便拖动） */
  compactClass?: (scope: string) => string | null;
  onSort: (scope: string, keys: string[]) => void;
}

const START_DISTANCE = 4;
const EDGE = 48;
const MAX_SCROLL_STEP = 14;

export function installSortable(options: SortableOptions): void {
  const { root } = options;

  root.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const handle = (event.target as Element | null)?.closest<HTMLElement>('[data-drag-handle]');
    if (!handle || !root.contains(handle)) return;
    const item = handle.closest<HTMLElement>('[data-sort-key]');
    const container = item?.parentElement;
    const scope = container?.dataset.sortScope;
    if (!item || !container || !scope) return;

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    suppressNextClick();

    const scroller = options.scroller();
    const startY = event.clientY;
    let lastY = startY;
    let active = false;
    let compact: string | null = null;
    let frame = 0;

    const siblings = () => [...container.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== item && 'sortKey' in node.dataset);

    const reorder = () => {
      const others = siblings();
      const before = others.find((node) => {
        const rect = node.getBoundingClientRect();
        return lastY < rect.top + rect.height / 2;
      });
      if (before) {
        if (item.nextElementSibling !== before) container.insertBefore(item, before);
      } else if (others.length) {
        const last = others[others.length - 1];
        if (last.nextElementSibling !== item) last.after(item);
      }
    };

    const autoScroll = () => {
      frame = 0;
      if (!active) return;
      const rect = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
      let step = 0;
      if (lastY < rect.top + EDGE) step = -Math.ceil(((rect.top + EDGE - lastY) / EDGE) * MAX_SCROLL_STEP);
      else if (lastY > rect.bottom - EDGE) step = Math.ceil(((lastY - (rect.bottom - EDGE)) / EDGE) * MAX_SCROLL_STEP);
      if (step) {
        scroller.scrollTop += step;
        reorder();
        frame = requestAnimationFrame(autoScroll);
      }
    };

    const activate = () => {
      active = true;
      compact = options.compactClass?.(scope) ?? null;
      if (compact) {
        // 收起内容后把被拖的项保持在手指下面
        const before = item.getBoundingClientRect().top;
        root.classList.add(compact);
        scroller.scrollTop += item.getBoundingClientRect().top - before;
      }
      item.classList.add('is-dragging');
      document.documentElement.classList.add('cs-sorting');
      navigator.vibrate?.(10);
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== event.pointerId) return;
      lastY = move.clientY;
      if (!active) {
        if (Math.abs(lastY - startY) < START_DISTANCE) return;
        activate();
      }
      move.preventDefault();
      reorder();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };

    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== event.pointerId) return;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      if (frame) cancelAnimationFrame(frame);
      if (!active) return;
      active = false;
      item.classList.remove('is-dragging');
      document.documentElement.classList.remove('cs-sorting');
      if (compact) root.classList.remove(compact);
      const keys = [...container.children]
        .filter((node): node is HTMLElement => node instanceof HTMLElement && 'sortKey' in node.dataset)
        .map((node) => node.dataset.sortKey as string);
      options.onSort(scope, keys);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  });

  // 手柄上的长按不弹系统菜单/列表的长按菜单
  root.addEventListener(
    'contextmenu',
    (event) => {
      if ((event.target as Element | null)?.closest('[data-drag-handle]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
}

/** 吞掉按手柄之后紧跟的那次 click（手柄在可点击的行里面） */
function suppressNextClick(): void {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    clear();
  };
  const clear = () => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerdown', later, true);
  };
  // 下一次按下时还没触发 click，说明这次没有 click，取消吞掉
  const later = () => setTimeout(clear, 0);
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.addEventListener('pointerdown', later, true), 0);
}

/** 拖动手柄元素 */
export function dragHandle(className: string, label: string): HTMLSpanElement {
  const handle = document.createElement('span');
  handle.className = `material-symbols-outlined ${className}`;
  handle.textContent = 'drag_indicator';
  handle.dataset.dragHandle = '';
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', label);
  handle.title = label;
  return handle;
}

/** 最近的可纵向滚动的祖先，找不到就用页面本身 */
export function scrollParent(node: HTMLElement): HTMLElement {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
