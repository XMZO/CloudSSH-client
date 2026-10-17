/** 网页版抽屉面板（SFTP / 常用命令 / AI 助手）的开关状态判断、关闭与监听 */

const CLOSE_SELECTOR = '#sftp-close-btn, #snippet-close-btn, #agent-close-btn, .panel-close-btn';

/** 用面板自己的关闭按钮关闭（与点 × 完全一致，含 SFTP 传输中断等语义）；找不到按钮时退回 Esc */
export function closePanel(panel: HTMLElement): void {
  const button = panel.querySelector<HTMLElement>(CLOSE_SELECTOR);
  if (button) {
    button.click();
    return;
  }
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

/** 网页版关闭面板时写入 translateX(100%)；AI 助手关闭后还会 display:none */
export function panelIsOpen(panel: HTMLElement): boolean {
  if (!panel.isConnected || panel.style.display === 'none') return false;
  return !/translateX\(\s*100%\s*\)/.test(panel.style.transform);
}

/**
 * 监听某个面板（按 id，可能稍后才创建）的开关变化；返回取消函数。
 * 面板由网页版首次打开时才挂到 body 上，所以同时监听 body 的子节点变化。
 */
export function watchPanel(id: string, onChange: (open: boolean) => void): () => void {
  let panelObserver: MutationObserver | null = null;
  let current: HTMLElement | null = null;
  let open = false;

  const attach = (panel: HTMLElement | null) => {
    if (panel === current) return;
    panelObserver?.disconnect();
    current = panel;
    open = panel ? panelIsOpen(panel) : false;
    if (!panel) return;
    panelObserver = new MutationObserver(() => {
      const next = panelIsOpen(panel);
      if (next === open) return;
      open = next;
      onChange(open);
    });
    panelObserver.observe(panel, { attributes: true, attributeFilter: ['style'] });
  };

  const bodyObserver = new MutationObserver(() => attach(document.getElementById(id)));
  bodyObserver.observe(document.body, { childList: true });
  attach(document.getElementById(id));

  return () => {
    bodyObserver.disconnect();
    panelObserver?.disconnect();
  };
}
