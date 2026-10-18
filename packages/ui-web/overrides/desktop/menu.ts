/**
 * 页面内的菜单（右键菜单、标题栏的应用菜单与实例菜单）：在指定位置弹出；点外面、Esc、滚动、窗口失焦都会关闭；
 * 方向键在可点的项之间移动。不用系统原生菜单，外观与配色跟随网页版主题。
 */
import { el, icon } from './dom';

export interface MenuItem {
  label: string;
  /** 前面的图标；checked 为 true 时显示勾，省略时留空位与其他项对齐 */
  icon?: string;
  danger?: boolean;
  /** 菜单项前加一条分隔线 */
  separated?: boolean;
  /** 单选项（例如当前实例）：显示勾 */
  checked?: boolean;
  /** 第二行小字说明（例如实例地址） */
  detail?: string;
  /** 右侧的快捷键说明 */
  shortcut?: string;
  /** 只显示、不能点（例如版本号） */
  disabled?: boolean;
  /** 行尾的小按钮（例如“在新窗口打开”） */
  trailing?: { icon: string; label: string; action: () => void };
  action?: () => void;
}

let close: (() => void) | null = null;

export function closeMenu(): void {
  close?.();
}

export function isMenuOpen(): boolean {
  return close !== null;
}

function renderItem(item: MenuItem): HTMLElement {
  const row = el('div', 'cs-dk-menu-row');
  const button = el('button', item.danger ? 'cs-dk-menu-item is-danger' : 'cs-dk-menu-item');
  button.type = 'button';
  button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
  if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
  if (item.disabled) {
    button.disabled = true;
    button.classList.add('is-disabled');
  }
  const lead = item.checked ? icon('check') : item.icon ? icon(item.icon) : el('span', 'cs-dk-icon cs-dk-menu-blank');
  const text = el('span', 'cs-dk-menu-text');
  text.append(el('span', 'cs-dk-menu-label', item.label));
  if (item.detail) text.append(el('span', 'cs-dk-menu-detail', item.detail));
  button.append(lead, text);
  if (item.shortcut) button.append(el('span', 'cs-dk-menu-shortcut', item.shortcut));
  button.addEventListener('click', () => {
    closeMenu();
    item.action?.();
  });
  row.append(button);
  if (item.trailing) {
    const trailing = item.trailing;
    const extra = el('button', 'cs-dk-menu-trailing');
    extra.type = 'button';
    extra.title = trailing.label;
    extra.setAttribute('aria-label', trailing.label);
    extra.append(icon(trailing.icon));
    extra.addEventListener('click', () => {
      closeMenu();
      trailing.action();
    });
    row.append(extra);
  }
  return row;
}

/** onClose：菜单因任何原因关闭时调用 */
export function showMenu(x: number, y: number, items: MenuItem[], onClose?: () => void): void {
  closeMenu();
  const menu = el('div', 'cs-dk-menu');
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.separated && menu.childElementCount) menu.append(el('div', 'cs-dk-menu-sep'));
    menu.append(renderItem(item));
  }
  document.body.append(menu);
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - menu.offsetWidth - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - menu.offsetHeight - 6))}px`;

  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const onPointer = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) closeMenu();
  };
  const onKey = (event: KeyboardEvent) => {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') closeMenu();
    else if (event.key === 'ArrowDown') list[(index + 1) % list.length]?.focus();
    else if (event.key === 'ArrowUp') list[(index - 1 + list.length) % list.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const dismiss = () => closeMenu();
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', dismiss, true);
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);
  close = () => {
    close = null;
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', dismiss, true);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('resize', dismiss);
    menu.remove();
    onClose?.();
  };
  buttons()[0]?.focus();
}
