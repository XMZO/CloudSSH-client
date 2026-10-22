/**
 * 手机上的提示条（网页版 notify() 弹出的 .app-toast）：
 * - 放在屏幕顶部、一行紧凑的样式：网页版放在底部、整宽、带标题行，切换服务器时正好挡住键盘和快捷命令栏
 * - 显示时长按文字长短算（短的两三秒），不超过调用方要的时长、也不超过各类型的上限
 * - 底边一条 2px 的进度条显示还剩多久（浮在提示条上，不占布局），它走完就是提示条消失的时刻
 * - 左右或往上滑走；手指按着时暂停；轻点展开被截断的长文字，并停住直到手动关掉（再点一下收起、接着计时）
 * 网页版的计时交给这里：网页版轻点会触发 mouseenter 停表、要等点了别处才重新计时，提示条会一直不走。
 * 一直显示的提示（时长 0，比如快空闲断开的提醒）不计时，只换样式、可以滑走。
 */
import './toasts.css';

/** 读完一条提示大概要的时间：基础 + 每个字 */
const BASE_MS = 1500;
const PER_CHAR_MS = 50;
const MIN_MS = 2000;
const MAX_MS: Record<string, number> = { info: 5000, success: 4000, warning: 6000, danger: 7000 };
/** 滑动超过提示条宽度的这个比例（或甩得够快）就关掉 */
const DISMISS_RATIO = 0.3;
const FLING_PX_PER_MS = 0.5;

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

function manage(toast: HTMLElement): void {
  if (toast.dataset.csManaged) return;
  toast.dataset.csManaged = '1';
  // 停掉网页版自己的计时（它在 mouseenter 时停表），并且不让它再开始：它在 mouseleave / focusout 时重新计时，
  // 手机上点了别处才会有 mouseleave，会把展开着在看的提示条收走。目标阶段捕获监听先于网页版的普通监听执行
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
    gesture.dy = Math.min(0, event.clientY - gesture.y);
    if (!gesture.moved && Math.hypot(gesture.dx, gesture.dy) < 8) return;
    gesture.moved = true;
    // 横着跟手；往上推也可以（提示条在顶部）
    const horizontal = Math.abs(gesture.dx) >= Math.abs(gesture.dy);
    const dx = horizontal ? gesture.dx : 0;
    const dy = horizontal ? 0 : gesture.dy;
    const progress = Math.min(1, (horizontal ? Math.abs(dx) / toast.offsetWidth : Math.abs(dy) / toast.offsetHeight) || 0);
    toast.style.transform = `translate(${dx}px, ${dy}px)`;
    toast.style.opacity = String(1 - progress * 0.7);
  });

  const release = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { dx, dy, moved, t } = gesture;
    gesture = null;
    if (!moved) {
      // 轻点：展开 / 收起长文字；展开时停住
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
      settle(horizontal ? Math.sign(dx) * toast.offsetWidth * 1.2 : 0, horizontal ? 0 : -toast.offsetHeight * 2);
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
}

export function installMobileToasts(): void {
  let watched: HTMLElement | null = null;
  const containerObserver = new MutationObserver(() => {
    for (const node of watched?.children ?? []) if (node instanceof HTMLElement) manage(node);
  });
  const attach = () => {
    const container = document.querySelector<HTMLElement>('.app-toast-container');
    if (!container || container === watched) return;
    watched = container;
    container.classList.add('cs-toasts');
    containerObserver.disconnect();
    containerObserver.observe(container, { childList: true });
    for (const node of container.children) if (node instanceof HTMLElement) manage(node);
  };
  // 网页版第一次弹提示时才创建容器
  new MutationObserver(attach).observe(document.body, { childList: true });
  attach();
}
