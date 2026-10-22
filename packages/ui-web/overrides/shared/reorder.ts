/**
 * 列表拖动排序（手机与电脑共用的拖动引擎）。
 *
 * - 被拖的项浮起并跟着指针平移，其余项用 translate 动画让位；松手后落到目标位置，再一次性调整 DOM 顺序
 * - 全程只用 transform，拖动中不改 DOM、不用 position:fixed（父级带 transform 的面板里也能正确定位）
 * - 指针靠近滚动容器两端时自动滚动；可以取消（动画回到原位，顺序不变）
 * - 默认上下排列的列表；axis: 'x' 用于左右排列的一行（电脑标签栏），各项宽度可以不同
 *
 * beginReorder() 是一次拖动；makeReorderable() 是手机“调整排序”面板用的整套手势（手柄/长按），
 * 电脑侧栏的整行拖动在 sortable.ts 里，同样基于 beginReorder()。
 *
 * 触摸用 Touch Events：长按开始后对 touchmove 调 preventDefault，列表不会跟着滚走（Pointer Events 在
 * 浏览器开始滚动时会直接 pointercancel，长按拖动做不稳）。鼠标用 Pointer Events，只从手柄开始。
 */

const EDGE = 56;
const MAX_SCROLL_SPEED = 16;
const SETTLE_MS = 160;

export interface ReorderSession {
  /** 指针移动到 clientY（axis 为 'x' 时是 clientX） */
  move(at: number): void;
  /** 在当前位置落下 */
  drop(): void;
  /** 取消：回到原位，顺序不变 */
  cancel(): void;
}

export interface BeginReorderOptions {
  /** 可排序项的父元素（拖动中加 is-reordering） */
  container: HTMLElement;
  /** 被拖的项 */
  item: HTMLElement;
  /** 同一父元素里的全部可排序项，按当前顺序（含 item） */
  items: HTMLElement[];
  scroller: HTMLElement;
  /** 拖动起点的 clientY（axis 为 'x' 时是 clientX；被拖项此后随指针相对这里平移） */
  at: number;
  /** 排列方向：'y' 上下（默认），'x' 左右 */
  axis?: 'x' | 'y';
  /** 落位动画结束、DOM 顺序已更新后调用；changed 表示顺序是否改变（取消时为 false） */
  onEnd: (changed: boolean) => void;
}

export function beginReorder(options: BeginReorderOptions): ReorderSession {
  const { container, item, items, scroller } = options;
  const horizontal = options.axis === 'x';
  const translate = horizontal ? 'translateX' : 'translateY';
  const scrolled = () => (horizontal ? scroller.scrollLeft : scroller.scrollTop);
  const scrollBy = (delta: number) => {
    if (horizontal) scroller.scrollLeft += delta;
    else scroller.scrollTop += delta;
  };
  const index = items.indexOf(item);
  const containerRect = container.getBoundingClientRect();
  const base = horizontal ? containerRect.left : containerRect.top;
  const rects = items.map((node) => node.getBoundingClientRect());
  /** 各项在排列方向上的起点（相对容器）与长度 */
  const starts = rects.map((rect) => (horizontal ? rect.left : rect.top) - base);
  const sizes = rects.map((rect) => (horizontal ? rect.width : rect.height));
  const gap = items.length > 1 ? Math.max(0, starts[1] - (starts[0] + sizes[0])) : 0;
  const slot = sizes[index] + gap;
  const startAt = options.at;
  const startScroll = scrolled();
  let at = startAt;
  let target = index;
  let frame = 0;
  let ended = false;

  /** 滚动容器在排列方向上的可见范围 */
  const viewport = () => {
    if (scroller === document.scrollingElement) return { from: 0, to: horizontal ? innerWidth : innerHeight };
    const rect = scroller.getBoundingClientRect();
    return horizontal ? { from: rect.left, to: rect.right } : { from: rect.top, to: rect.bottom };
  };

  container.classList.add('is-reordering');
  item.classList.add('is-lifted');
  for (const node of items) if (node !== item) node.classList.add('is-shifting');

  /**
   * 左右排列时（标签栏）像浏览器那样把被拖项显示在第一项与最后一项之间，不拖出栏外、不盖住后面的按钮。
   * 只限制显示位置，落到哪一格仍按指针算：各项一样宽时，被限制住的中心正好停在最后一项的中线上、越不过去
   */
  const last = items.length - 1;
  const clamp = (delta: number) =>
    horizontal
      ? Math.min(Math.max(delta, starts[0] - starts[index]), starts[last] + sizes[last] - sizes[index] - starts[index])
      : delta;

  function update(): void {
    const delta = at - startAt + (scrolled() - startScroll);
    const center = starts[index] + sizes[index] / 2 + delta;
    let next = index;
    for (let j = index + 1; j < items.length; j++) if (center > starts[j] + sizes[j] / 2) next = j;
    for (let j = index - 1; j >= 0; j--) if (center < starts[j] + sizes[j] / 2) next = j;
    target = next;
    items.forEach((node, j) => {
      if (j === index) return;
      const shift = j > index && j <= target ? -slot : j < index && j >= target ? slot : 0;
      node.style.transform = shift ? `${translate}(${shift}px)` : '';
    });
    item.style.transform = `${translate}(${clamp(delta)}px)`;
  }

  function autoScroll(): void {
    frame = 0;
    if (ended) return;
    const view = viewport();
    let speed = 0;
    if (at < view.from + EDGE) speed = -Math.ceil(((view.from + EDGE - at) / EDGE) * MAX_SCROLL_SPEED);
    else if (at > view.to - EDGE) speed = Math.ceil(((at - (view.to - EDGE)) / EDGE) * MAX_SCROLL_SPEED);
    if (!speed) return;
    const before = scrolled();
    scrollBy(speed);
    if (scrolled() !== before) update();
    frame = requestAnimationFrame(autoScroll);
  }

  function end(commit: boolean): void {
    if (ended) return;
    ended = true;
    if (frame) cancelAnimationFrame(frame);
    const final = commit ? target : index;
    // 往后移时与目标项的末端对齐，往前移时与目标项的起点对齐；取消时回到原位。
    // transform 是相对容器内原位置的（容器随滚动一起移动），所以这里不需要再加滚动距离
    const landing = final > index ? starts[final] + sizes[final] - sizes[index] : starts[final];
    item.classList.add('is-settling');
    item.style.transform = `${translate}(${landing - starts[index]}px)`;
    if (!commit) for (const node of items) if (node !== item) node.style.transform = '';
    window.setTimeout(() => {
      for (const node of items) {
        node.classList.remove('is-shifting', 'is-lifted', 'is-settling');
        node.style.transform = '';
      }
      container.classList.remove('is-reordering');
      const changed = final !== index;
      if (changed) container.insertBefore(item, final > index ? items[final].nextSibling : items[final]);
      options.onEnd(changed);
    }, SETTLE_MS);
  }

  update();
  return {
    move(next: number) {
      if (ended) return;
      at = next;
      update();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    },
    drop: () => end(true),
    cancel: () => end(false),
  };
}

// ---------- 手机“调整排序”面板：按住手柄立即拖，长按条目也能拖 ----------

export interface ReorderOptions {
  list: HTMLElement;
  scroller: HTMLElement;
  onReorder: (keys: string[]) => void;
  longPressMs?: number;
}

const MOVE_TOLERANCE = 8;

export function makeReorderable(options: ReorderOptions): () => void {
  const { list, scroller } = options;
  const longPressMs = options.longPressMs ?? 280;
  let session: ReorderSession | null = null;
  let settling = false;
  let swallowClick = false;
  let pending: { item: HTMLElement; x: number; y: number; timer: number } | null = null;

  const itemsOf = () => [...list.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.key !== undefined);

  function begin(item: HTMLElement, y: number): void {
    const items = itemsOf();
    if (!items.includes(item)) return;
    navigator.vibrate?.(12);
    session = beginReorder({
      container: list,
      item,
      items,
      scroller,
      at: y,
      onEnd: (changed) => {
        settling = false;
        if (changed) options.onReorder(itemsOf().map((node) => node.dataset.key as string));
      },
    });
  }

  function finish(): void {
    if (!session) return;
    settling = true;
    swallowClick = true;
    session.drop();
    session = null;
  }

  function cancelPending(): void {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  // ---------- 触摸 ----------

  const onTouchStart = (event: TouchEvent) => {
    if (session || settling || event.touches.length > 1) {
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
    pending = { item, x: touch.clientX, y: touch.clientY, timer };
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
    if (!session) return;
    event.preventDefault();
    session.move(touch.clientY);
  };

  const onTouchEnd = () => {
    cancelPending();
    finish();
  };

  // ---------- 鼠标（只从手柄开始） ----------

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || session || settling) return;
    const target = event.target as Element | null;
    const handle = target?.closest<HTMLElement>('[data-reorder-handle]');
    const item = handle?.closest<HTMLElement>('[data-key]');
    if (!handle || !item || item.parentElement !== list) return;
    event.preventDefault();
    begin(item, event.clientY);
    const onMove = (e: PointerEvent) => session?.move(e.clientY);
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
    session?.cancel();
    session = null;
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
