/** 移动端底部面板（操作菜单 / 设置表单共用）。只用 DOM API 与 textContent 渲染。 */

export interface SheetAction {
  label: string;
  icon?: string;
  danger?: boolean;
  action: () => void;
}

let current: { root: HTMLElement; onClose?: () => void } | null = null;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: string): HTMLSpanElement {
  const span = el('span', 'material-symbols-outlined cs-m-icon', name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

export function isSheetOpen(): boolean {
  return current !== null;
}

export function closeSheet(): void {
  if (!current) return;
  const { root, onClose } = current;
  current = null;
  root.classList.remove('is-open');
  setTimeout(() => root.remove(), 180);
  onClose?.();
}

/** 打开一个面板，content 为面板主体；返回主体容器 */
export function openSheet(title: string, content: HTMLElement, options: { onClose?: () => void; tall?: boolean } = {}): HTMLElement {
  closeSheet();
  const root = el('div', 'cs-m-sheet-root');
  const backdrop = el('div', 'cs-m-sheet-backdrop');
  backdrop.addEventListener('click', closeSheet);
  const panel = el('div', options.tall ? 'cs-m-sheet is-tall' : 'cs-m-sheet');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  const handle = el('div', 'cs-m-sheet-handle');
  const header = el('div', 'cs-m-sheet-title', title);
  panel.append(handle, header, content);
  root.append(backdrop, panel);
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add('is-open'));
  current = { root, onClose: options.onClose };
  return content;
}

export function showActions(title: string, actions: SheetAction[], cancelLabel: string): void {
  const list = el('div', 'cs-m-actions');
  for (const item of actions) {
    const button = el('button', item.danger ? 'cs-m-action is-danger' : 'cs-m-action');
    button.type = 'button';
    if (item.icon) button.append(icon(item.icon));
    button.append(el('span', '', item.label));
    button.addEventListener('click', () => {
      closeSheet();
      item.action();
    });
    list.append(button);
  }
  const cancel = el('button', 'cs-m-action is-cancel', cancelLabel);
  cancel.type = 'button';
  cancel.addEventListener('click', closeSheet);
  list.append(cancel);
  openSheet(title, list);
}

export function confirmSheet(message: string, confirmLabel: string, cancelLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const body = el('div', 'cs-m-confirm');
    body.append(el('p', 'cs-m-confirm-text', message));
    const row = el('div', 'cs-m-row');
    const cancel = el('button', 'cs-m-btn', cancelLabel);
    const ok = el('button', danger ? 'cs-m-btn is-danger' : 'cs-m-btn is-primary', confirmLabel);
    cancel.type = ok.type = 'button';
    cancel.addEventListener('click', () => closeSheet());
    ok.addEventListener('click', () => {
      decided = true;
      closeSheet();
      resolve(true);
    });
    row.append(cancel, ok);
    body.append(row);
    openSheet('', body, { onClose: () => !decided && resolve(false) });
  });
}
