/**
 * 电脑侧栏的拖动排序（基于 reorder.ts 的拖动引擎：被拖项浮起跟手、其余项动画让位、松手落位）。
 *
 * 约定：可排序项带 `data-sort-key`，它们的父元素带 `data-sort-scope`（只在同一父元素内排序）。
 * - 鼠标：在整行上按住并移动超过几像素就开始拖（不必对准手柄）；只是点击、双击、右键时行为不变
 * - 触摸/触控笔：只从 `[data-drag-handle]` 手柄开始，行上的滑动仍是滚动列表
 * - 拖动中按 Esc、切走窗口或指针丢失都会取消，动画回到原位，顺序不变
 * - 行里的按钮（连接、会话圆点等）与带 `data-no-drag` 的区域（例如可选择的文字）上按下不会开始拖动
 * 列表会整体重绘，所以只在根元素上委托监听一次；拖动期间调用方应暂停重绘（onDragState）。
 */
import { beginReorder, type ReorderSession } from './reorder';

export interface SortableOptions {
  /** 委托监听的根元素 */
  root: HTMLElement;
  /** 需要自动滚动的容器（拖动开始时取） */
  scroller: () => HTMLElement;
  /** 拖动分组等大块时加到 root 上的类名（用来暂时收起分组内容，方便拖动） */
  compactClass?: (scope: string) => string | null;
  onSort: (scope: string, keys: string[]) => void;
  /** 拖动开始（true）与彻底结束（false，含落位动画与取消） */
  onDragState?: (dragging: boolean) => void;
}

const MOUSE_START_DISTANCE = 5;
const HANDLE_START_DISTANCE = 2;

export function installSortable(options: SortableOptions): void {
  const { root } = options;
  let busy = false;
  let swallowClick = false;

  root.addEventListener('pointerdown', (event) => {
    if (busy || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as Element | null;
    const handle = target?.closest<HTMLElement>('[data-drag-handle]') ?? null;
    if (event.pointerType !== 'mouse' && !handle) return;
    // 按钮、输入框上按下不拖（手柄本身除外）
    if (!handle && target?.closest('button, input, textarea, select, a[href], [data-no-drag]')) return;
    const item = target?.closest<HTMLElement>('[data-sort-key]');
    const container = item?.parentElement;
    const scope = container?.dataset.sortScope;
    if (!item || !container || !scope || !root.contains(container)) return;
    // 只能拖“本层”的行：例如在分组内容的空白处按下，不应拖动整个分组
    if (target?.closest('[data-sort-scope]') !== container) return;

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const threshold = handle ? HANDLE_START_DISTANCE : MOUSE_START_DISTANCE;
    let session: ReorderSession | null = null;
    let compact: string | null = null;
    if (handle) event.preventDefault();

    const stopListening = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCancel);
      root.removeEventListener('lostpointercapture', onLostCapture);
    };

    const activate = (y: number) => {
      busy = true;
      swallowClick = true;
      options.onDragState?.(true);
      document.documentElement.classList.add('cs-sorting');
      try {
        root.setPointerCapture(pointerId);
      } catch {
        // 指针已经抬起等情况：靠 window 上的监听收尾
      }
      const scroller = options.scroller();
      // 从按下的位置算起（不是越过阈值的位置），被拖的行与指针保持按下时的相对位置
      let beginY = startY;
      compact = options.compactClass?.(scope) ?? null;
      if (compact) {
        // 收起各分组的内容，再把被拖的分组标题移到指针下面
        const before = item.getBoundingClientRect().top;
        root.classList.add(compact);
        scroller.scrollTop += item.getBoundingClientRect().top - before;
        const rect = item.getBoundingClientRect();
        beginY = rect.top + rect.height / 2;
      }
      const items = [...container.children].filter(
        (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.sortKey !== undefined
      );
      session = beginReorder({
        container,
        item,
        items,
        scroller,
        y: beginY,
        onEnd: (changed) => {
          if (compact) {
            // 展开回来时让落下的分组保持在原来的屏幕位置
            const before = item.getBoundingClientRect().top;
            root.classList.remove(compact);
            scroller.scrollTop += item.getBoundingClientRect().top - before;
          }
          document.documentElement.classList.remove('cs-sorting');
          busy = false;
          // 先按 DOM 里的新顺序保存，再宣布拖动结束：拖动期间被推迟的重绘要在保存之后才能执行，
          // 否则会按旧顺序重绘，把刚拖好的顺序冲掉
          if (changed) {
            const keys = [...container.children]
              .filter((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.sortKey !== undefined)
              .map((node) => node.dataset.sortKey as string);
            options.onSort(scope, keys);
          }
          options.onDragState?.(false);
        },
      });
      session.move(y);
    };

    const finish = (commit: boolean) => {
      stopListening();
      if (!session) return;
      try {
        if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
      } catch {
        // 忽略
      }
      const current = session;
      session = null;
      if (commit) current.drop();
      else current.cancel();
    };

    function onMove(move: PointerEvent): void {
      if (move.pointerId !== pointerId) return;
      if (!session) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < threshold) return;
        activate(move.clientY);
      }
      move.preventDefault();
      session?.move(move.clientY);
    }
    function onUp(up: PointerEvent): void {
      if (up.pointerId === pointerId) finish(true);
    }
    function onCancel(): void {
      finish(false);
    }
    // 只认列表自己丢了捕获：触摸按下时浏览器先把指针隐式捕获到手柄上，开始拖动改由列表捕获时，
    // 手柄的 lostpointercapture 会冒泡上来，不能当成取消
    function onLostCapture(event: PointerEvent): void {
      if (event.target === root && event.pointerId === pointerId) finish(false);
    }
    function onKey(key: KeyboardEvent): void {
      if (key.key !== 'Escape' || !session) return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    }

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCancel);
    root.addEventListener('lostpointercapture', onLostCapture);
  });

  // 拖动之后紧跟的那次 click 不算点击（不会误触发选中、折叠分组）
  root.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
  // 新的一次按下时清掉标记（拖动后浏览器不一定会派发 click）
  root.addEventListener('pointerdown', () => !busy && (swallowClick = false), true);

  // 手柄上的长按不弹系统菜单/列表的右键菜单
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
