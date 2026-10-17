/**
 * 列表拖动排序（手机优先，鼠标也能用）。
 *
 * - 列表的直接子元素带 `data-key` 即为可排序项
 * - 按住项内的 `[data-reorder-handle]` 立即开始拖；在项上长按（默认 280ms 不动）也能开始拖
 * - 被拖的项浮起并跟着手指平移，其余项用 translateY 动画让位；松手后落位并回调新顺序
 * - 全程只用 transform，不改 DOM、不用 position:fixed（父级带 transform 的底部面板里也能正确定位）
 * - 手指靠近滚动容器上下边缘时自动滚动
 *
 * 触摸用 Touch Events：长按开始后对 touchmove 调 preventDefault，列表不会跟着滚走（Pointer Events 在
 * 浏览器开始滚动时会直接 pointercancel，长按拖动做不稳）。鼠标用 Pointer Events，只从手柄开始。
 */

export interface ReorderOptions {
  list: HTMLElement;
  scroller: HTMLElement;
  onReorder: (keys: string[]) => void;
  longPressMs?: number;
}

const MOVE_TOLERANCE = 8;
const EDGE = 56;
const MAX_SCROLL_SPEED = 16;
const SETTLE_MS = 160;

interface Drag {
  item: HTMLElement;
  items: HTMLElement[];
  index: number;
  tops: number[];
  heights: number[];
  slot: number;
  startY: number;
  startScroll: number;
  y: number;
  target: number;
  frame: number;
}

export function makeReorderable(options: ReorderOptions): () => void {
  const { list, scroller } = options;
  const longPressMs = options.longPressMs ?? 280;
  let drag: Drag | null = null;
  let settling = false;
  let swallowClick = false;
  let pending: { item: HTMLElement; x: number; y: number; timer: number; id: number } | null = null;

  const itemsOf = () => [...list.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.key !== undefined);

  const viewport = () =>
    scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();

  function begin(item: HTMLElement, y: number): void {
    const items = itemsOf();
    const index = items.indexOf(item);
    if (index < 0) return;
    const base = list.getBoundingClientRect().top;
    const rects = items.map((node) => node.getBoundingClientRect());
    const tops = rects.map((rect) => rect.top - base);
    const heights = rects.map((rect) => rect.height);
    const gap = items.length > 1 ? Math.max(0, tops[1] - (tops[0] + heights[0])) : 0;
    drag = { item, items, index, tops, heights, slot: heights[index] + gap, startY: y, startScroll: scroller.scrollTop, y, target: index, frame: 0 };
    list.classList.add('is-reordering');
    item.classList.add('is-lifted');
    for (const node of items) if (node !== item) node.classList.add('is-shifting');
    navigator.vibrate?.(12);
    update();
  }

  function update(): void {
    if (!drag) return;
    const { index, tops, heights, items, item, slot } = drag;
    const dy = drag.y - drag.startY + (scroller.scrollTop - drag.startScroll);
    const center = tops[index] + heights[index] / 2 + dy;
    let target = index;
    for (let j = index + 1; j < items.length; j++) if (center > tops[j] + heights[j] / 2) target = j;
    for (let j = index - 1; j >= 0; j--) if (center < tops[j] + heights[j] / 2) target = j;
    drag.target = target;
    items.forEach((node, j) => {
      if (j === index) return;
      const shift = j > index && j <= target ? -slot : j < index && j >= target ? slot : 0;
      node.style.transform = shift ? `translateY(${shift}px)` : '';
    });
    item.style.transform = `translateY(${dy}px)`;
  }

  function autoScroll(): void {
    if (!drag) return;
    drag.frame = 0;
    const view = viewport();
    let speed = 0;
    if (drag.y < view.top + EDGE) speed = -Math.ceil(((view.top + EDGE - drag.y) / EDGE) * MAX_SCROLL_SPEED);
    else if (drag.y > view.bottom - EDGE) speed = Math.ceil(((drag.y - (view.bottom - EDGE)) / EDGE) * MAX_SCROLL_SPEED);
    if (!speed) return;
    const before = scroller.scrollTop;
    scroller.scrollTop += speed;
    if (scroller.scrollTop !== before) update();
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function move(y: number): void {
    if (!drag) return;
    drag.y = y;
    update();
    if (!drag.frame) drag.frame = requestAnimationFrame(autoScroll);
  }

  function finish(): void {
    if (!drag) return;
    const { item, items, index, tops, heights, target } = drag;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    drag = null;
    settling = true;
    swallowClick = true;
    // 落到目标位置：往下移时与目标项底部对齐，往上移时与目标项顶部对齐
    const landing = target > index ? tops[target] + heights[target] - heights[index] : tops[target];
    item.classList.add('is-settling');
    item.style.transform = `translateY(${landing - tops[index]}px)`;
    window.setTimeout(() => {
      for (const node of items) {
        node.classList.remove('is-shifting', 'is-lifted', 'is-settling');
        node.style.transform = '';
      }
      list.classList.remove('is-reordering');
      if (target !== index) {
        const reference = target > index ? items[target].nextSibling : items[target];
        list.insertBefore(item, reference);
        options.onReorder(itemsOf().map((node) => node.dataset.key as string));
      }
      settling = false;
    }, SETTLE_MS);
  }

  function cancelPending(): void {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  // ---------- 触摸 ----------

  const onTouchStart = (event: TouchEvent) => {
    if (drag || settling || event.touches.length > 1) {
      cancelPending();
      return;
    }
    const target = event.target as Element | null;
    const item = target?.closest<HTMLElement>('[data-key]');
    if (!item || item.parentElement !== list) return;
    const touch = event.touches[0];
    if (target?.closest('[data-reorder-handle]')) {
      begin(item, touch.clientY);
      return;
    }
    cancelPending();
    const timer = window.setTimeout(() => {
      if (pending) begin(pending.item, pending.y);
      pending = null;
    }, longPressMs);
    pending = { item, x: touch.clientX, y: touch.clientY, timer, id: touch.identifier };
  };

  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    if (pending) {
      // 长按还没到就移动了：这是在滚动列表，放弃拖动
      if (Math.hypot(touch.clientX - pending.x, touch.clientY - pending.y) > MOVE_TOLERANCE) cancelPending();
      else pending.y = touch.clientY;
      return;
    }
    if (!drag) return;
    event.preventDefault();
    move(touch.clientY);
  };

  const onTouchEnd = () => {
    cancelPending();
    if (drag) finish();
  };

  // ---------- 鼠标（只从手柄开始） ----------

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || drag || settling) return;
    const target = event.target as Element | null;
    const handle = target?.closest<HTMLElement>('[data-reorder-handle]');
    const item = handle?.closest<HTMLElement>('[data-key]');
    if (!handle || !item || item.parentElement !== list) return;
    event.preventDefault();
    begin(item, event.clientY);
    const onMove = (e: PointerEvent) => move(e.clientY);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      finish();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 拖动结束后紧跟的那次 click 不算点击；长按也不弹系统菜单
  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onContextMenu = (event: Event) => event.preventDefault();
  const resetSwallow = () => (swallowClick = false);

  list.addEventListener('touchstart', onTouchStart, { passive: true });
  // 必须是非 passive，拖动时才能阻止滚动（长按开始前不调用 preventDefault，正常滚动不受影响）
  list.addEventListener('touchmove', onTouchMove, { passive: false });
  list.addEventListener('touchend', onTouchEnd);
  list.addEventListener('touchcancel', onTouchEnd);
  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('click', onClick, true);
  list.addEventListener('contextmenu', onContextMenu);
  // 新的一次按下开始时清掉标记（拖动后没有产生 click 的情况）
  list.addEventListener('pointerdown', resetSwallow, true);

  return () => {
    cancelPending();
    list.removeEventListener('touchstart', onTouchStart);
    list.removeEventListener('touchmove', onTouchMove);
    list.removeEventListener('touchend', onTouchEnd);
    list.removeEventListener('touchcancel', onTouchEnd);
    list.removeEventListener('pointerdown', onPointerDown);
    list.removeEventListener('click', onClick, true);
    list.removeEventListener('contextmenu', onContextMenu);
    list.removeEventListener('pointerdown', resetSwallow, true);
  };
}
