/** 标题栏按钮下方的弹出面板：点外面、按 Esc、再点按钮都会关闭 */
import { el } from './dom';

let current: { panel: HTMLElement; anchor: HTMLElement; cleanup: () => void } | null = null;

export function closePopover(): void {
  if (!current) return;
  const { panel, anchor, cleanup } = current;
  current = null;
  cleanup();
  panel.remove();
  anchor.setAttribute('aria-expanded', 'false');
  anchor.classList.remove('is-open');
}

export function isPopoverOpenFor(anchor: HTMLElement): boolean {
  return current?.anchor === anchor;
}

/** 在 anchor 下方打开面板（右对齐到按钮），返回面板主体 */
export function openPopover(anchor: HTMLElement, className: string, build: (panel: HTMLElement) => void): HTMLElement {
  closePopover();
  const panel = el('div', `cs-dk-popover ${className}`);
  panel.setAttribute('role', 'dialog');
  build(panel);
  document.body.append(panel);
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.maxHeight = `${window.innerHeight - rect.bottom - 16}px`;
  anchor.setAttribute('aria-expanded', 'true');
  anchor.classList.add('is-open');

  const onPointer = (event: PointerEvent) => {
    const target = event.target as Node;
    if (panel.contains(target) || anchor.contains(target)) return;
    closePopover();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePopover();
      anchor.focus();
    }
  };
  const onBlur = () => closePopover();
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  current = {
    panel,
    anchor,
    cleanup: () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    },
  };
  (panel.querySelector<HTMLElement>('button, [tabindex]') ?? panel).focus?.();
  return panel;
}
