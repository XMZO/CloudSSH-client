/**
 * 命令片段面板（网页版的 #snippet-panel）的桌面交互：
 * - 双击一条片段 = 点它的“填入”按钮（只填入、不回车，与网页版默认一致）
 * - 紧凑列表里命令最多显示两行，悬停时提示完整命令
 * 都用事件委托，不依赖面板何时创建，也不改网页版的渲染。
 */
import { dt } from './i18n';

const CARD = '#snippet-list > [data-snippet-id]';

export function mountSnippetEnhancements(): void {
  document.addEventListener('dblclick', (event) => {
    const target = event.target as Element | null;
    const card = target?.closest<HTMLElement>(CARD);
    if (!card || target?.closest('button, a, input, textarea')) return;
    const insert = card.querySelector<HTMLElement>('[data-action="insert"]');
    if (!insert) return;
    window.getSelection()?.removeAllRanges();
    insert.click();
  });

  document.addEventListener(
    'pointerover',
    (event) => {
      const card = (event.target as Element | null)?.closest<HTMLElement>(CARD);
      if (!card || card.dataset.csTitled === '1') return;
      const command = card.lastElementChild?.textContent?.trim();
      if (!command) return;
      card.title = `${command}\n\n${dt('snippetHint')}`;
      card.dataset.csTitled = '1';
    },
    { passive: true }
  );
}
