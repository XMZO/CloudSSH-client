/**
 * 终端改尺寸后当场重画，不留一帧空白，也不留几帧错位的高亮（电脑与手机）。
 *
 * xterm 改尺寸时先把画布清空（改 canvas 宽高就会清空），再排到“下一帧”重画。改尺寸本身发生在某一帧的绘制回调里时
 * （开关侧栏、停靠的面板、AI 助手，拖动右侧面板边缘，都是在绘制回调里通知终端重新适配），重画被推到再下一帧，
 * 中间那一帧显示的是空白画布，看起来就是终端闪一下。这里在改完尺寸后（同一次派发里 xterm 自己的监听都跑完）
 * 先让 beforeRender 把依赖排版的东西（关键词高亮）按新的折行重新算好，再立刻执行 xterm 排好的那次重画；
 * 本来就不在绘制回调里的（拖动窗口的 resize 事件），只是早一点画，结果一样。
 * 用的是 xterm 6 的内部成员（_core._renderService._renderDebouncer），找不到就照旧下一帧画。
 */
import type { Terminal } from '@xterm/xterm';

interface RenderInternals {
  _core?: { _renderService?: { _renderDebouncer?: { _innerRefresh?: () => void } } };
}

export function installResizeRender(term: Terminal, beforeRender?: () => void): void {
  term.onResize(() => {
    // 这个监听比 xterm 自己的（清空画布、排重画）先注册：等这次派发全部跑完再画
    queueMicrotask(() => {
      try {
        beforeRender?.();
      } catch {
        // 高亮算不了不影响重画
      }
      try {
        (term as unknown as RenderInternals)._core?._renderService?._renderDebouncer?._innerRefresh?.();
      } catch {
        // 画不了就照旧等下一帧
      }
    });
  });
}
