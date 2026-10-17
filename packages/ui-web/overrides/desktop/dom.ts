/** 桌面端界面主题的 DOM 小工具（只用 DOM API 与 textContent，不拼 HTML） */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: string, className = ''): HTMLSpanElement {
  const span = el('span', `material-symbols-outlined cs-dk-icon ${className}`.trim(), name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

export function iconButton(name: string, label: string, className: string): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  return button;
}

/**
 * 把任意 CSS 颜色（含 color-mix、半透明）按页面背景合成为不透明的 #rrggbb。
 * 系统窗口按钮的配色只接受不透明颜色。
 */
export function opaqueHex(color: string, base = '#131313'): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = base;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
