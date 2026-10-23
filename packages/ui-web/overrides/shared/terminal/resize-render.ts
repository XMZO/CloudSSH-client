/**
 * 终端改尺寸后当场重画，不留一帧空白，也不留几帧错位的高亮（电脑与手机）。
 *
 * 改 canvas 的宽高会清空画布，xterm 把重画排到“下一帧”。只要清空发生在一帧的绘制回调或排版之后，中间那一帧显示的
 * 就是空白画布，整块终端闪一下。有两处：
 * 1. xterm 改尺寸（开关侧栏、停靠的面板、AI 助手，拖动右侧面板边缘，都是在绘制回调里通知终端重新适配）：这里在改完
 *    尺寸后（同一次派发里 xterm 自己的监听都跑完）先让 beforeRender 把依赖排版的东西（关键词高亮）按新的折行重新
 *    算好，再立刻执行 xterm 排好的那次重画
 * 2. WebGL 渲染器的设备像素校正：缩放比例不是整数（例如 Windows 的 175%）时，画布的 CSS 尺寸乘缩放比例往往不是整数，
 *    排版之后它用 ResizeObserver 读到真实像素尺寸、再改一次画布宽高（又清空一次），重画还是排到下一帧——拖窗口、
 *    拖侧栏时几乎每一步都整块空白一帧。这里给这个校正补上“改完立刻重画”（ResizeObserver 回调在绘制之前，赶得上这一帧）
 * 用的是 xterm 6 / addon-webgl 0.19 的内部成员（_core._renderService、_setCanvasDevicePixelDimensions），
 * 找不到就照旧下一帧画。
 */
import type { Terminal } from '@xterm/xterm';

interface RenderDebouncer {
  _innerRefresh?: () => void;
}

interface RenderServiceInternals {
  _renderDebouncer?: RenderDebouncer;
  _renderer?: { value?: object };
}

interface TerminalInternals {
  _core?: { _renderService?: RenderServiceInternals };
}

/** WebGL 渲染器（addon-webgl 的 WebglRenderer）里用到的成员 */
interface WebglRendererInternals {
  _canvas?: HTMLCanvasElement;
  _core?: { _renderService?: RenderServiceInternals };
  _setCanvasDevicePixelDimensions?: (width: number, height: number) => void;
}

/** 执行 xterm 已经排好、本来要等下一帧的重画 */
function renderNow(service: RenderServiceInternals | undefined): void {
  try {
    service?._renderDebouncer?._innerRefresh?.();
  } catch {
    // 画不了就照旧等下一帧
  }
}

const patchedPrototypes = new WeakSet<object>();

/** 给 WebGL 渲染器的设备像素校正补上“改完立刻重画”（改原型，之后重建的渲染器也生效） */
function patchDevicePixelCorrection(term: Terminal): void {
  const renderer = (term as unknown as TerminalInternals)._core?._renderService?._renderer?.value;
  const proto = renderer ? (Object.getPrototypeOf(renderer) as WebglRendererInternals) : null;
  if (!proto || patchedPrototypes.has(proto)) return;
  patchedPrototypes.add(proto);
  const original = proto._setCanvasDevicePixelDimensions;
  if (typeof original !== 'function') return;
  proto._setCanvasDevicePixelDimensions = function (this: WebglRendererInternals, width: number, height: number) {
    const changed = this._canvas?.width !== width || this._canvas?.height !== height;
    original.call(this, width, height);
    if (changed) renderNow(this._core?._renderService);
  };
}

export function installResizeRender(term: Terminal, beforeRender?: () => void): void {
  // 渲染器（WebGL 或退回的 DOM）要等终端挂到页面上才有：每次重画时看一眼，补丁只打一次
  term.onRender(() => patchDevicePixelCorrection(term));
  term.onResize(() => {
    // 这个监听比 xterm 自己的（清空画布、排重画）先注册：等这次派发全部跑完再画
    queueMicrotask(() => {
      try {
        beforeRender?.();
      } catch {
        // 高亮算不了不影响重画
      }
      renderNow((term as unknown as TerminalInternals)._core?._renderService);
    });
  });
}
