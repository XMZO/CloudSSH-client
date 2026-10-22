/**
 * 手机上的提示条（网页版 notify() 弹出的 .app-toast）：放在页面上本来就有的位置，不浮在按钮或终端内容上（./slots.ts）。
 * - 只是告诉你一件事的提示：显示在顶栏中间的标题区（终端页的服务器名、服务器列表页的 CloudSSH 标题），
 *   两边的按钮照常可点。轻点就关掉；文字被截断时第一下先展开、停住
 * - 要你点一下的（带“继续”之类按钮）：显示在底部的操作行（快捷命令条 / 快捷键栏 / 搜索栏），在键盘上方
 * - 这些位置被面板、对话框盖住时，才退回浮在屏幕顶部的一行（与原来一样）
 * 都不改变布局：终端不会因此重算行数、远端不会重画。同一个位置只放最新的一条。
 *
 * 计时：显示时长按文字长短算（短的两三秒），不超过调用方要的时长、也不超过各类型的上限；底边一条 2px 的进度条
 * 显示还剩多久，它走完就是提示消失的时刻。手指按着时暂停；左右滑或往边上推关掉。网页版的计时交给这里：
 * 网页版轻点会触发 mouseenter 停表、要等点了别处才重新计时，提示会一直不走。
 * 一直显示的提示（时长 0，比如快空闲断开的提醒）不计时。
 */
import { applySlot, findSlot, type SlotKind } from './slots';
import './toasts.css';

/** 读完一条提示大概要的时间：基础 + 每个字 */
const BASE_MS = 1500;
const PER_CHAR_MS = 50;
const MIN_MS = 2000;
const MAX_MS: Record<string, number> = { info: 5000, success: 4000, warning: 6000, danger: 7000 };
/** 滑动超过提示条宽度的这个比例（或甩得够快）就关掉 */
const DISMISS_RATIO = 0.3;
const FLING_PX_PER_MS = 0.5;

/** 浮在顶部的容器（网页版的 .app-toast-container）：没有合适位置时放回这里 */
let floating: HTMLElement | null = null;
const hosts = new Map<SlotKind, HTMLElement>();

function displayTime(toast: HTMLElement): number {
  const requested = Number(toast.dataset.duration);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  const length = toast.querySelector('.app-toast__message')?.textContent?.trim().length ?? 0;
  const cap = MAX_MS[toast.dataset.variant ?? 'info'] ?? MAX_MS.info;
  return Math.min(requested, cap, Math.max(MIN_MS, BASE_MS + length * PER_CHAR_MS));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** 带关闭以外按钮的（如快空闲断开提醒的“继续”）要你点一下，放底部操作行；其余放顶栏标题区 */
function kindOf(toast: HTMLElement): SlotKind {
  return toast.querySelector('button:not(.app-toast__close)') ? 'prompt' : 'notice';
}

function hostFor(kind: SlotKind): HTMLElement {
  const existing = hosts.get(kind);
  if (existing?.isConnected) return existing;
  const host = document.createElement('div');
  host.className = `cs-slot-host is-${kind}`;
  document.body.append(host);
  hosts.set(kind, host);
  // 提示收走（网页版收起动画结束后移除）后，这块地方还给原来的内容
  new MutationObserver(() => {
    if (host.querySelector('.app-toast')) return;
    host.remove();
    if (hosts.get(kind) === host) hosts.delete(kind);
  }).observe(host, { childList: true });
  return host;
}

/** 放到合适的位置；没有就浮在顶部 */
function place(toast: HTMLElement): void {
  if (!toast.isConnected || toast.classList.contains('app-toast--leaving')) return;
  const kind = kindOf(toast);
  const slot = findSlot(kind);
  if (!slot) {
    if (toast.classList.contains('in-slot') && floating) {
      toast.classList.remove('in-slot');
      floating.append(toast);
    }
    return;
  }
  const host = hostFor(kind);
  // 同一个位置只放最新的一条
  for (const old of [...host.querySelectorAll<HTMLElement>('.app-toast')]) {
    if (old === toast) continue;
    old.querySelector<HTMLElement>('.app-toast__close')?.click();
    old.remove();
  }
  applySlot(host, slot);
  toast.classList.add('in-slot');
  if (toast.parentElement !== host) host.append(toast);
}

function manage(toast: HTMLElement): void {
  if (toast.dataset.csManaged) return;
  toast.dataset.csManaged = '1';
  // 停掉网页版自己的计时（它在 mouseenter 时停表），并且不让它再开始：它在 mouseleave / focusout 时重新计时，
  // 手机上点了别处才会有 mouseleave，会把展开着在看的提示收走。目标阶段捕获监听先于网页版的普通监听执行
  for (const type of ['mouseleave', 'focusout']) toast.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
  toast.dispatchEvent(new Event('mouseenter'));
  const closeButton = toast.querySelector<HTMLElement>('.app-toast__close');
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    timer?.cancel();
    closeButton?.click();
  };

  // 进度条：动画本身就是计时器，走完即关闭，进度和消失时刻完全一致
  let timer: Animation | null = null;
  const duration = displayTime(toast);
  if (duration > 0) {
    const bar = document.createElement('span');
    bar.className = 'cs-toast-bar';
    bar.setAttribute('aria-hidden', 'true');
    toast.append(bar);
    timer = bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration, easing: 'linear', fill: 'forwards' });
    timer.onfinish = dismiss;
  }

  let expanded = false;
  let gesture: { id: number; x: number; y: number; t: number; dx: number; dy: number; moved: boolean } | null = null;
  /** 在底部（往下推关掉）还是顶部（往上推关掉） */
  const atBottom = () => toast.closest<HTMLElement>('.cs-slot-host')?.dataset.edge === 'bottom';

  const resume = () => {
    if (!done && !expanded && !gesture && timer?.playState === 'paused') timer.play();
  };

  const settle = (dx: number, dy: number) => {
    toast.style.transition = prefersReducedMotion() ? 'none' : 'transform 180ms ease, opacity 180ms ease';
    toast.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
    toast.style.opacity = dx || dy ? '0' : '';
  };

  toast.addEventListener('pointerdown', (event) => {
    if (done || !event.isPrimary || (event.target as Element).closest('button, a')) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, t: performance.now(), dx: 0, dy: 0, moved: false };
    timer?.pause();
    toast.style.transition = 'none';
    try {
      toast.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件等情况
    }
  });

  toast.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    gesture.dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture.dy = atBottom() ? Math.max(0, dy) : Math.min(0, dy);
    if (!gesture.moved && Math.hypot(gesture.dx, gesture.dy) < 8) return;
    gesture.moved = true;
    // 横着跟手；也可以往边上推（顶部的往上、底部的往下）
    const horizontal = Math.abs(gesture.dx) >= Math.abs(gesture.dy);
    const moveX = horizontal ? gesture.dx : 0;
    const moveY = horizontal ? 0 : gesture.dy;
    const progress = Math.min(1, (horizontal ? Math.abs(moveX) / toast.offsetWidth : Math.abs(moveY) / toast.offsetHeight) || 0);
    toast.style.transform = `translate(${moveX}px, ${moveY}px)`;
    toast.style.opacity = String(1 - progress * 0.7);
  });

  const release = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { dx, dy, moved, t } = gesture;
    gesture = null;
    if (!moved) {
      // 顶栏里的提示：轻点就关掉（它盖着标题，别挡着）；文字被截断时第一下先展开、停住
      const message = toast.querySelector<HTMLElement>('.app-toast__message');
      const truncated = !!message && message.scrollHeight > message.clientHeight + 1;
      if (toast.closest('.cs-slot-host.is-notice') && (expanded || !truncated)) {
        dismiss();
        return;
      }
      expanded = !expanded;
      toast.classList.toggle('is-expanded', expanded);
      if (!expanded) resume();
      return;
    }
    const elapsed = Math.max(1, performance.now() - t);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const distance = horizontal ? Math.abs(dx) : Math.abs(dy);
    const size = horizontal ? toast.offsetWidth : toast.offsetHeight;
    if (event.type === 'pointerup' && (distance > size * DISMISS_RATIO || distance / elapsed > FLING_PX_PER_MS)) {
      settle(horizontal ? Math.sign(dx) * toast.offsetWidth * 1.2 : 0, horizontal ? 0 : Math.sign(dy) * toast.offsetHeight * 2);
      done = true;
      timer?.cancel();
      window.setTimeout(() => closeButton?.click(), prefersReducedMotion() ? 0 : 160);
      return;
    }
    settle(0, 0);
    resume();
  };
  toast.addEventListener('pointerup', release);
  toast.addEventListener('pointercancel', release);
  closeButton?.addEventListener('click', () => {
    done = true;
    timer?.cancel();
  });

  place(toast);
  // 刚切换页面时（关了最后一个标签回到服务器列表）页头还在滑入动画里，量到的位置偏了：动画结束后再摆一次
  window.setTimeout(() => place(toast), 350);
}

export function installMobileToasts(): void {
  const containerObserver = new MutationObserver(() => {
    for (const node of floating?.children ?? []) if (node instanceof HTMLElement) manage(node);
  });
  const attach = () => {
    const container = document.querySelector<HTMLElement>('.app-toast-container');
    if (!container || container === floating) return;
    floating = container;
    container.classList.add('cs-toasts');
    containerObserver.disconnect();
    containerObserver.observe(container, { childList: true });
    for (const node of container.children) if (node instanceof HTMLElement) manage(node);
  };
  // 网页版第一次弹提示时才创建容器
  new MutationObserver(attach).observe(document.body, { childList: true });
  attach();

  // 键盘弹出 / 收起、横竖屏切换后，借用的那块地方位置变了：跟着挪（没有了就浮到顶部）
  let frame = 0;
  const reflow = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const placed = [...hosts.values()].flatMap((host) => [...host.querySelectorAll<HTMLElement>('.app-toast')]);
      for (const toast of placed) place(toast);
    });
  };
  window.visualViewport?.addEventListener('resize', reflow, { passive: true });
  window.addEventListener('resize', reflow, { passive: true });
}
