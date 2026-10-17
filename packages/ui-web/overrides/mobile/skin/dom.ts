/** 模块共用的小工具：建元素、找元素、批量撤销 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: string, className = ''): HTMLSpanElement {
  const span = h('span', `material-symbols-outlined cs-ob-icon ${className}`.trim(), name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

export function iconButton(name: string, label: string, className = 'cs-ob-iconbtn'): HTMLButtonElement {
  const button = h('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  return button;
}

/** 点一下网页版自己的按钮（即使它被隐藏），复用原有逻辑 */
export function clickById(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  target.click();
  return true;
}

/** 网页版按钮是否可用：存在且没有被网页版自己隐藏（例如分享会话里隐藏的命令片段） */
export function upstreamButtonAvailable(id: string): boolean {
  const target = document.getElementById(id);
  return !!target && !target.classList.contains('hidden');
}

/** 收集撤销函数，模块卸载时倒序执行 */
export class Disposer {
  private readonly tasks: (() => void)[] = [];

  add(task: () => void): void {
    this.tasks.push(task);
  }

  listen<K extends keyof WindowEventMap>(target: Window, type: K, handler: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void;
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, handler: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.add(() => target.removeEventListener(type, handler, options));
  }

  observe(target: Node, callback: MutationCallback, options: MutationObserverInit): MutationObserver {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    this.add(() => observer.disconnect());
    return observer;
  }

  /** 插入的元素在卸载时移除 */
  own<T extends Element>(node: T): T {
    this.add(() => node.remove());
    return node;
  }

  run(): void {
    while (this.tasks.length) {
      const task = this.tasks.pop()!;
      try {
        task();
      } catch (error) {
        console.warn('[cloudssh] skin cleanup', error);
      }
    }
  }
}

/** 同一帧内多次触发只执行一次 */
export function rafThrottle(fn: () => void): () => void {
  let frame = 0;
  return () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn();
    });
  };
}

/** 让终端按新的可用空间重新计算行列（复用网页版对 resize 的处理） */
export function requestTerminalRefit(): void {
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
