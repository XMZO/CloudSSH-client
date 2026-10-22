/**
 * 手机上给消息用的固定位置：借用页面上本来就有的一块地方，消息显示时暂时盖住它，
 * 不浮在任何按钮或终端内容上，也不改变布局（终端不会因此重算行数、远端不会重画）。
 * - notice（只是告诉你一件事，如“会话已结束，已自动关闭标签”）：顶栏中间的标题区——终端页是服务器名与副标题，
 *   服务器列表页是 CloudSSH 标题。两边的按钮（返回、SFTP、关闭、更多……）照常可点
 * - prompt（要你点一下，如链接确认、快空闲断开的“继续”）：底部的操作行——快捷命令条，没开时是快捷键栏，
 *   服务器列表页是底部的搜索栏。都在键盘上方，不挡终端内容
 * 这块地方没显示、或者被面板 / 对话框盖住时返回 null，调用方退回浮在屏幕顶部。
 */

export type SlotKind = 'notice' | 'prompt';

export interface Slot {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 借用那块地方原来的底色、圆角、磨砂，盖上去看不出边界 */
  background: string;
  radius: string;
  backdrop: string;
  /** 在顶部（展开时往下长）还是底部（往上长） */
  edge: 'top' | 'bottom';
}

/** 我们自己盖上去的东西：判断“这块地方是不是在最上层”时跳过 */
const OWN = '.cs-slot-host, .cs-link-bar, .app-toast-container';

function onTop(element: Element, x: number, y: number): boolean {
  const first = document.elementsFromPoint(x, y).find((node) => !node.closest(OWN));
  return !!first && element.contains(first);
}

interface Candidate {
  /** 消息盖住的那一块 */
  area: string;
  /** 取底色、圆角的元素（默认就是 area） */
  surface?: string;
  /** 上下边取这个元素的（标题区比整条顶栏矮，消息用整条顶栏的高度，两行字才放得下） */
  vertical?: string;
  edge: 'top' | 'bottom';
}

const CANDIDATES: Record<SlotKind, Candidate[]> = {
  notice: [
    { area: '.cs-ob-bar .cs-ob-title', surface: '.cs-ob-bar', edge: 'top' },
    { area: '.user-space-header .user-space-brand', surface: '.user-space-header', vertical: '.user-space-header', edge: 'top' },
  ],
  prompt: [
    { area: '.cs-ob-cmds', edge: 'bottom' },
    { area: '#mobile-terminal-toolbar', edge: 'bottom' },
    { area: '.cs-m-nodes-bar', edge: 'bottom' },
  ],
};

export function findSlot(kind: SlotKind): Slot | null {
  for (const candidate of CANDIDATES[kind]) {
    const area = document.querySelector<HTMLElement>(candidate.area);
    if (!area) continue;
    const rect = area.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 24) continue;
    if (!onTop(area, rect.left + rect.width / 2, rect.top + rect.height / 2)) continue;
    const surface = (candidate.surface ? area.closest<HTMLElement>(candidate.surface) : null) ?? area;
    const style = getComputedStyle(surface);
    let top = rect.top;
    let height = rect.height;
    if (candidate.vertical) {
      const outer = area.closest<HTMLElement>(candidate.vertical)?.getBoundingClientRect();
      if (outer) {
        top = outer.top + 4;
        height = outer.height - 8;
      }
    }
    // 那一块的底色常是半透明的（磨砂玻璃）：叠在不透明的页面底色上，才能完全盖住原来的文字
    const color = style.backgroundColor;
    const background = color === 'rgba(0, 0, 0, 0)' || color === 'transparent' ? 'var(--bg)' : `linear-gradient(${color}, ${color}), var(--bg)`;
    return {
      left: rect.left,
      top,
      width: rect.width,
      height,
      background,
      radius: surface === area ? style.borderRadius : '10px',
      backdrop: style.backdropFilter,
      edge: candidate.edge,
    };
  }
  return null;
}

/** 把一个盖上去的元素摆到这块地方（顶部的往下长、底部的往上长） */
export function applySlot(element: HTMLElement, slot: Slot): void {
  element.style.left = `${Math.round(slot.left)}px`;
  element.style.right = 'auto';
  element.style.width = `${Math.round(slot.width)}px`;
  element.style.minHeight = `${Math.round(slot.height)}px`;
  if (slot.edge === 'top') {
    element.style.top = `${Math.round(slot.top)}px`;
    element.style.bottom = 'auto';
  } else {
    element.style.bottom = `${Math.round(innerHeight - slot.top - slot.height)}px`;
    element.style.top = 'auto';
  }
  element.style.background = slot.background;
  element.style.borderRadius = slot.radius;
  element.style.backdropFilter = slot.backdrop;
  element.dataset.edge = slot.edge;
}
