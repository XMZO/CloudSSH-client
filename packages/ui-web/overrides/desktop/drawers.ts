/**
 * 工作台主题下右侧三个抽屉（SFTP、命令片段、AI 助手）的宽度：拖动面板左边缘调整（聚焦后方向键也可以），
 * 宽度按面板分别记在本地，双击左边缘恢复默认（SFTP、AI 助手是网页版的默认宽度，命令片段 300px）。
 *
 * SFTP 与 AI 助手的面板每个会话标签各有一个（id 相同），命令片段面板第一次打开时才创建，
 * 都直接挂在 body 下：看着 body 的直接子节点，给每个面板挂上拖动条。宽度写进一个 <style>，
 * 同名面板一起生效；没调过的面板不写规则，沿用网页版自己的宽度（含窄窗口下的全宽）。
 */
import { el } from './dom';
import { dt } from './i18n';

interface DrawerSpec {
  id: string;
  storageKey: string;
  min: number;
  max: number;
  /** 最宽不超过窗口宽度的这个比例 */
  maxFraction: number;
}

const SPECS: DrawerSpec[] = [
  { id: 'sftp-panel', storageKey: 'cloudssh_desktop_sftp_width', min: 360, max: 960, maxFraction: 0.6 },
  { id: 'snippet-panel', storageKey: 'cloudssh_desktop_snippet_width', min: 240, max: 560, maxFraction: 0.5 },
  { id: 'agent-panel', storageKey: 'cloudssh_desktop_agent_width', min: 320, max: 960, maxFraction: 0.6 },
];
const KEY_STEP = 16;

const widths = new Map<string, number>();
let styleEl: HTMLStyleElement | null = null;

function clampWidth(spec: DrawerSpec, width: number): number {
  const max = Math.max(spec.min, Math.min(spec.max, Math.round(window.innerWidth * spec.maxFraction)));
  return Math.round(Math.min(max, Math.max(spec.min, width)));
}

function readSaved(spec: DrawerSpec): number | null {
  try {
    const value = Number(localStorage.getItem(spec.storageKey));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeSaved(spec: DrawerSpec, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(spec.storageKey);
    else localStorage.setItem(spec.storageKey, String(width));
  } catch {
    // 忽略：只是记不住宽度
  }
}

/** 按当前窗口宽度重新夹紧并写出全部规则 */
function renderWidths(): void {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'cs-drawer-widths';
    document.head.append(styleEl);
  }
  styleEl.textContent = SPECS.filter((spec) => widths.has(spec.id))
    .map((spec) => `html[data-cs-desk="workbench"] #${spec.id}{width:min(${clampWidth(spec, widths.get(spec.id)!)}px,100vw)!important}`)
    .join('\n');
}

function setWidth(spec: DrawerSpec, width: number | null, save: boolean): void {
  if (width === null) widths.delete(spec.id);
  else widths.set(spec.id, clampWidth(spec, width));
  renderWidths();
  if (save) writeSaved(spec, width === null ? null : widths.get(spec.id)!);
}

function attachResizer(panel: HTMLElement, spec: DrawerSpec): void {
  if (panel.querySelector(':scope > .cs-drawer-resizer')) return;
  const grip = el('div', 'cs-drawer-resizer');
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.title = dt('resizeHint');
  grip.setAttribute('aria-label', dt('resizeHint'));

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.offsetWidth;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('is-dragging');
    document.documentElement.classList.add('cs-resizing');
    // 面板在右边：往左拖变宽
    const widthAt = (x: number) => startWidth + (startX - x);
    const move = (moveEvent: PointerEvent) => setWidth(spec, widthAt(moveEvent.clientX), false);
    const end = (endEvent: PointerEvent) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.classList.remove('is-dragging');
      document.documentElement.classList.remove('cs-resizing');
      setWidth(spec, widthAt(endEvent.clientX), true);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
  grip.addEventListener('dblclick', () => setWidth(spec, null, true));
  grip.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setWidth(spec, panel.offsetWidth + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP), true);
  });
  // 放在最前面：有的样式按 “> div:last-child” 选面板的底栏
  panel.prepend(grip);
}

export function mountDrawerResizers(): void {
  for (const spec of SPECS) {
    const saved = readSaved(spec);
    if (saved !== null) widths.set(spec.id, saved);
  }
  renderWidths();

  const ensureResizers = () => {
    for (const spec of SPECS) {
      for (const panel of document.querySelectorAll<HTMLElement>(`[id="${spec.id}"]`)) attachResizer(panel, spec);
    }
  };
  ensureResizers();
  new MutationObserver(ensureResizers).observe(document.body, { childList: true });
  // 窗口变窄后，记住的宽度可能超过上限
  window.addEventListener('resize', renderWidths);
}
