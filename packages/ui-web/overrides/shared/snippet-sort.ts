/**
 * 命令片段面板（网页版的 #snippet-list）拖动排序，电脑与手机共用：
 * - 鼠标：在一条片段上按住拖动（命令文字上按下仍是选择文字，按钮上按下照常点击，双击照常填入）
 * - 触摸：按住每条右上角的拖动手柄（列表上的滑动仍是滚动）
 * - 选了分类或输入了搜索时，只在看得到的几条之间调换先后，其他片段的位置不变
 * 顺序存在本地（snippet-order.ts）。两处构建钩子：网页版每次画列表前按保存的顺序排好它的片段数组，
 * 画每张卡片时交给这里补上排序标记与手柄；拖动引擎是侧栏同款（sortable.ts）。
 */
import { getLocale } from '../../upstream/frontend/src/i18n';
import { reorderVisible, sortSnippets } from './snippet-order';
import { dragHandle, installSortable } from './sortable';
import './snippet-sort.css';

interface SnippetLike {
  id: string;
}

/** 网页版 SnippetManager 用到的几个（私有）成员 */
interface SnippetManagerLike {
  snippets?: SnippetLike[];
  deps?: { isAuthenticated?: () => boolean };
}

const LABELS: Record<string, string> = {
  'zh-CN': '拖动调整顺序',
  'zh-TW': '拖曳調整順序',
  'en-US': 'Drag to reorder',
};

function manager(): SnippetManagerLike | null {
  return ((globalThis as Record<string, unknown>).__cloudsshSnippetManager as SnippetManagerLike | undefined) ?? null;
}

function isCloud(target: SnippetManagerLike | null): boolean {
  return target?.deps?.isAuthenticated?.() === true;
}

const installed = new WeakSet<HTMLElement>();

function installOn(list: HTMLElement): void {
  if (installed.has(list)) return;
  installed.add(list);
  list.dataset.sortScope = 'snippets';
  installSortable({
    root: list,
    scroller: () => list,
    onSort: (_scope, keys) => {
      const target = manager();
      if (!target?.snippets) return;
      const cloud = isCloud(target);
      const order = reorderVisible(
        target.snippets.map((snippet) => snippet.id),
        keys,
        cloud
      );
      // 网页版的数组也换成新顺序（命令面板搜索、下次重绘都用它）；列表 DOM 已经是拖好的样子，不用重绘
      const rank = new Map(order.map((id, index) => [id, index]));
      target.snippets = [...target.snippets].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    },
  });
}

/**
 * @param touchHandles 每条片段加拖动手柄（手机；电脑用鼠标直接拖整条，不加）
 */
export function installSnippetSort(options: { touchHandles: boolean }): void {
  const scope = globalThis as Record<string, unknown>;
  // 网页版画列表前调用：按保存的顺序排好（返回新数组，网页版换上它）
  scope.__cloudsshSortSnippets = (snippets: SnippetLike[], cloud: boolean) => sortSnippets(snippets, cloud === true);
  // 网页版画好一张卡片（还没放进列表）时调用
  scope.__cloudsshSnippetCard = (card: HTMLElement, command: HTMLElement | null, actions: HTMLElement | null) => {
    const id = card.dataset.snippetId;
    if (!id) return;
    card.dataset.sortKey = id;
    // 命令文字上按下是选择文字，不开始拖动
    if (command) command.dataset.noDrag = '';
    if (options.touchHandles && actions) {
      actions.append(dragHandle('cs-snip-drag', LABELS[getLocale()] ?? LABELS['zh-CN']));
    }
    const list = document.getElementById('snippet-list');
    if (list) installOn(list);
  };
}
