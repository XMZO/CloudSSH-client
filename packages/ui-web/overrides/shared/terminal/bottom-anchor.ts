/**
 * 终端贴着底边放：不足一行的余量放在上面，提示符始终贴着终端区域的底边（电脑端安装）。
 *
 * 终端只能整行增减：区域高度不是行高的整数倍时，余下的不到一行留在底下。拖窗口改高度时，文字先停着不动、底边
 * 一点点靠近，挪够一整行才整体跳一行——看起来文字跟不上、慢半拍。现在把整个终端（.xterm）往下平移这块余量，
 * 提示符跟着底边连续移动；凑够一行时网页版增减一行，平移量同时跳回，画面不动。
 * - 平移不改变终端自己的高度，按父元素算行数（FitAddon）不受影响；鼠标位置、选区按实际位置算，也照常
 * - 平移量按设备像素取整（175% 缩放下是 1/1.75 px 的整数倍），画布不落在半个像素上，文字不发虚
 * - ResizeObserver 在排版之后、绘制之前回调，平移和这一帧的尺寸变化同时生效
 */
import type { Terminal } from '@xterm/xterm';

const anchored = new WeakSet<Terminal>();

function attach(term: Terminal): void {
  const element = term.element;
  const parent = element?.parentElement;
  if (!element || !parent || anchored.has(term)) return;
  anchored.add(term);
  let applied = '';
  const update = () => {
    if (!element.isConnected) return;
    // 隐藏的标签（display: none）量不出尺寸：保持原样，切回来时会再量
    const room = parent.clientHeight;
    const height = element.offsetHeight;
    if (room <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const shift = Math.max(0, Math.round((room - height) * dpr) / dpr);
    const value = shift > 0 ? `translateY(${shift}px)` : '';
    if (value === applied) return;
    applied = value;
    element.style.transform = value;
  };
  const observer = new ResizeObserver(update);
  observer.observe(parent);
  observer.observe(element);
  update();
  const dispose = term.onRender(() => {
    if (element.isConnected) return;
    observer.disconnect();
    dispose.dispose();
  });
}

export function installBottomAnchor(term: Terminal): void {
  // .xterm 要等终端挂到页面上（open）才有：第一次重画时挂上
  if (term.element) {
    attach(term);
    return;
  }
  const once = term.onRender(() => {
    once.dispose();
    attach(term);
  });
}
