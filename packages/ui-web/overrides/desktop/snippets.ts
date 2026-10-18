/**
 * 命令片段面板（网页版的 #snippet-panel）的桌面交互：
 * - 双击一条片段 = 点它的“填入”按钮（只填入、不回车，与网页版默认一致）
 * - 紧凑列表里命令最多显示两行，悬停时提示完整命令
 * - 工作台主题下拖动面板左边缘调宽（方向键也可以），宽度记在本地；双击左边缘恢复默认
 * 都用事件委托或在面板出现时挂上，不改网页版的渲染。
 */
import { el } from './dom';
import { dt } from './i18n';

const CARD = '#snippet-list > [data-snippet-id]';
const PANEL_ID = 'snippet-panel';
const WIDTH_KEY = 'cloudssh_desktop_snippet_width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const KEY_STEP = 16;

/** 最宽不超过 560px，也不超过窗口的一半 */
function clampWidth(width: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(560, Math.round(window.innerWidth / 2)));
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

function savedWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // 忽略：只是记不住宽度
  }
}

function applyWidth(panel: HTMLElement, width: number | null): void {
  if (width === null) panel.style.removeProperty('--cs-snippet-w');
  else panel.style.setProperty('--cs-snippet-w', `${clampWidth(width)}px`);
}

function attachResizer(panel: HTMLElement): void {
  if (panel.querySelector('.cs-drawer-resizer')) return;
  applyWidth(panel, savedWidth());

  const grip = el('div', 'cs-drawer-resizer');
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.title = dt('resizeHint');
  grip.setAttribute('aria-label', dt('resizeHint'));

  const commit = (width: number) => {
    const next = clampWidth(width);
    applyWidth(panel, next);
    saveWidth(next);
  };

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.offsetWidth;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('is-dragging');
    document.documentElement.classList.add('cs-resizing');
    // 面板在右边：往左拖变宽
    const move = (moveEvent: PointerEvent) => applyWidth(panel, startWidth + (startX - moveEvent.clientX));
    const end = (endEvent: PointerEvent) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.classList.remove('is-dragging');
      document.documentElement.classList.remove('cs-resizing');
      commit(startWidth + (startX - endEvent.clientX));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
  grip.addEventListener('dblclick', () => {
    applyWidth(panel, null);
    saveWidth(null);
  });
  grip.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    commit(panel.offsetWidth + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP));
  });
  // 放在最前面：网页版（液态玻璃主题）和这里的底栏样式都按 “> div:last-child” 选中底栏
  panel.prepend(grip);
}

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
      const target = event.target as Element | null;
      // “新建片段”只显示图标，提示用按钮当前的文字（展开表单后是“取消”）
      const newButton = target?.closest<HTMLElement>('#snippet-new-btn');
      if (newButton) {
        newButton.title = newButton.querySelector('#snippet-new-btn-label')?.textContent?.trim() ?? '';
        return;
      }
      const card = target?.closest<HTMLElement>(CARD);
      if (!card || card.dataset.csTitled === '1') return;
      const command = card.lastElementChild?.textContent?.trim();
      if (!command) return;
      card.title = `${command}\n\n${dt('snippetHint')}`;
      card.dataset.csTitled = '1';
    },
    { passive: true }
  );

  // 面板在第一次打开时才创建（直接挂在 body 下），网页版销毁后也可能重建：一直看着 body 的直接子节点
  const ensureResizer = () => {
    const panel = document.getElementById(PANEL_ID);
    if (panel) attachResizer(panel);
  };
  ensureResizer();
  new MutationObserver(ensureResizer).observe(document.body, { childList: true });
  // 窗口变窄后已保存的宽度可能超过一半窗口
  window.addEventListener('resize', () => {
    const panel = document.getElementById(PANEL_ID);
    const width = savedWidth();
    if (panel && width !== null) applyWidth(panel, width);
  });
}
