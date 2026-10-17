/** 右键菜单（在鼠标位置弹出；点外面、Esc、滚动、窗口失焦都会关闭；方向键可选） */
import { el, icon } from './dom';

export interface MenuItem {
  label: string;
  icon: string;
  danger?: boolean;
  /** 菜单项前加一条分隔线 */
  separated?: boolean;
  action: () => void;
}

let close: (() => void) | null = null;

export function closeMenu(): void {
  close?.();
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = el('div', 'cs-dk-menu');
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.separated && menu.childElementCount) menu.append(el('div', 'cs-dk-menu-sep'));
    const button = el('button', item.danger ? 'cs-dk-menu-item is-danger' : 'cs-dk-menu-item');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.append(icon(item.icon), el('span', '', item.label));
    button.addEventListener('click', () => {
      closeMenu();
      item.action();
    });
    menu.append(button);
  }
  document.body.append(menu);
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 6)}px`;

  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>('.cs-dk-menu-item')];
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
  };
  buttons()[0]?.focus();
}
