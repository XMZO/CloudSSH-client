/**
 * 手机端快捷键栏：按住方向键等连续输入（像实体键盘按住不放），并屏蔽长按的系统行为。不改网页版。
 *
 * - 网页版的快捷键栏只认 click：按一下发一次。按住方向键、PgUp / PgDn、Del 时，400ms 后开始连发（先 70ms 一次，
 *   按住超过 1.5 秒后 35ms 一次）；松手、手指移开（还没开始连发时超过 10px，当成在横向滑动工具栏；连发中超过 24px）、
 *   系统接管手势（pointercancel）、切到后台时停止
 * - 连发复用网页版的处理：对按钮派发 click（一次性修饰键、trzsz 管线、Shell 就绪前不发等照旧）；
 *   连发过的那次松手不再补发 click，免得多出一下
 * - 长按图标会被安卓当成选中文字（图标是 Material Symbols 的连字，例如 keyboard_arrow_up），出现选区和系统菜单：
 *   工具栏里不允许选中文字（key-repeat.css）、不弹长按菜单
 */
import './key-repeat.css';

const TOOLBAR = '#mobile-terminal-toolbar';
const REPEAT_KEYS = new Set(['arrow_up', 'arrow_down', 'arrow_left', 'arrow_right', 'page_up', 'page_down', 'delete']);
const DELAY_MS = 400;
const SLOW_MS = 70;
const FAST_MS = 35;
const FAST_AFTER_MS = 1500;
const MOVE_TOLERANCE = 10;
const REPEAT_TOLERANCE = 24;
/** 连发结束后这段时间里，松手带来的那次原生 click 吞掉 */
const SWALLOW_MS = 600;

interface Press {
  button: HTMLButtonElement;
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
  repeating: boolean;
  timer: ReturnType<typeof setTimeout>;
}

function repeatButton(target: EventTarget | null): HTMLButtonElement | null {
  const button = target instanceof Element ? target.closest<HTMLButtonElement>(`${TOOLBAR} button`) : null;
  return button && REPEAT_KEYS.has(button.dataset.terminalKey ?? '') ? button : null;
}

export function installKeyRepeat(): void {
  let press: Press | null = null;
  let synthetic = false;
  let swallowUntil = 0;

  const fire = (button: HTMLButtonElement) => {
    synthetic = true;
    try {
      button.click();
    } finally {
      synthetic = false;
    }
  };

  const stop = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press.button.classList.remove('cs-key-repeating');
    if (press.repeating) swallowUntil = Date.now() + SWALLOW_MS;
    press = null;
  };

  const tick = () => {
    if (!press) return;
    if (!press.button.isConnected) return stop();
    fire(press.button);
    const held = Date.now() - press.startedAt;
    press.timer = setTimeout(tick, held >= FAST_AFTER_MS ? FAST_MS : SLOW_MS);
  };

  document.addEventListener(
    'pointerdown',
    (event) => {
      const button = repeatButton(event.target);
      if (!button || !event.isPrimary || event.button !== 0) return;
      stop();
      // 新的一次按下：之后的 click 属于这一次（上一次连发松手时系统可能根本没发 click），不再吞
      swallowUntil = 0;
      const current: Press = {
        button,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startedAt: Date.now(),
        repeating: false,
        timer: setTimeout(() => {
          if (press !== current) return;
          current.repeating = true;
          button.classList.add('cs-key-repeating');
          tick();
        }, DELAY_MS),
      };
      press = current;
    },
    true
  );

  document.addEventListener(
    'pointermove',
    (event) => {
      if (!press || event.pointerId !== press.pointerId) return;
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (moved > (press.repeating ? REPEAT_TOLERANCE : MOVE_TOLERANCE)) stop();
    },
    true
  );

  for (const type of ['pointerup', 'pointercancel'] as const) {
    document.addEventListener(
      type,
      (event) => {
        if (press && event.pointerId === press.pointerId) stop();
      },
      true
    );
  }
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });

  // 连发过的那次松手：原生 click 不再交给网页版（不然会多发一次）
  document.addEventListener(
    'click',
    (event) => {
      if (synthetic || Date.now() > swallowUntil || !repeatButton(event.target)) return;
      swallowUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );

  // 长按工具栏：不弹系统菜单、不开始选中文字
  for (const type of ['contextmenu', 'selectstart'] as const) {
    document.addEventListener(
      type,
      (event) => {
        if (event.target instanceof Element && event.target.closest(TOOLBAR)) event.preventDefault();
      },
      true
    );
  }
}
