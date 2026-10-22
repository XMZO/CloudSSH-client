/**
 * 拖动会话标签调换顺序（像浏览器那样）：在标签上按住鼠标左右拖，其余标签让位，松手落下，拖的那个标签成为当前标签；
 * 拖动中按 Esc 取消。两种界面主题用的都是网页版的标签栏（#tab-bar，工作台主题把它挪进了标题栏）。
 * - 移动超过几像素才算拖：单击切换、双击改名、中键关闭、右键菜单都不受影响；在 × 上按下不会拖
 * - 标签多到放不下时，拖到标签栏两端会自动滚动
 * - 顺序就是网页版标签管理器里 tabs 的顺序：落下后按新顺序重排，命令面板里的会话列表等都跟着变
 * 构建钩子（vite.config.ts）给每个标签带上 data-sort-key，并在拖动期间暂停重绘标签栏
 * （连上、状态点变化都会整栏重画，会把拖到一半的标签冲掉），落下后这里按新顺序补画。
 */
import { installSortable } from '../shared/sortable';
import './tab-sort.css';

interface TabManagerLike {
  tabs?: Map<string, unknown>;
  renderTabBar?: () => void;
  switchTab?: (id: string) => void;
  /** 构建钩子读它：为 true 时网页版不重绘标签栏 */
  __cloudsshTabSorting?: boolean;
}

const manager = () => (globalThis as { __cloudsshTabManager?: TabManagerLike }).__cloudsshTabManager;

/** 按标签栏里的新顺序重排网页版的 tabs（同一个 Map，别处拿着的引用照样有效） */
function reorderTabs(keys: string[]): void {
  const tabs = manager()?.tabs;
  if (!(tabs instanceof Map)) return;
  const ordered = new Map<string, unknown>();
  for (const key of keys) {
    const tab = tabs.get(key);
    if (tab !== undefined) ordered.set(key, tab);
  }
  // 拖动期间新开的标签（还没画进标签栏）排在最后
  for (const [key, tab] of tabs) if (!ordered.has(key)) ordered.set(key, tab);
  tabs.clear();
  for (const [key, tab] of ordered) tabs.set(key, tab);
}

export function installTabSort(): void {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;
  bar.dataset.sortScope = 'tabs';
  /** 按下的那个标签：落下后切到它 */
  let pressed: string | null = null;
  let moved = false;
  bar.addEventListener(
    'pointerdown',
    (event) => {
      pressed = (event.target as Element | null)?.closest<HTMLElement>('.tab-item')?.dataset.tabId ?? null;
    },
    true
  );
  installSortable({
    root: bar,
    axis: 'x',
    scroller: () => bar,
    onSort: (_scope, keys) => {
      reorderTabs(keys);
      moved = true;
    },
    onDragState: (dragging) => {
      const tabs = manager();
      if (!tabs) return;
      tabs.__cloudsshTabSorting = dragging;
      if (dragging) {
        moved = false;
        return;
      }
      // 补上拖动期间暂停的重绘（按新顺序）
      tabs.renderTabBar?.();
      if (moved && pressed) tabs.switchTab?.(pressed);
    },
  });
}
