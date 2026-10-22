/**
 * 会话标签上按鼠标中键关闭这个标签（和点标签上的 × 一样，走网页版自己的关闭流程）。
 * 两种界面主题用的都是网页版的标签栏（#tab-bar，工作台主题把它挪进了标题栏），在页面上委托监听一次即可。
 * 中键按下时顺带拦掉浏览器的中键自动滚动（标签栏放不下时会出现滚动光标）。
 */
const TAB = '#tab-bar .tab-item';

export function installTabMiddleClose(): void {
  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.button === 1 && (event.target as Element | null)?.closest(TAB)) event.preventDefault();
    },
    true
  );
  document.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const tab = (event.target as Element | null)?.closest<HTMLElement>(TAB);
    const close = tab?.querySelector<HTMLElement>('.tab-close');
    if (!close) return;
    event.preventDefault();
    close.click();
  });
}
