/**
 * 黑曜配色的运行时部分：
 * - 应用：交给网页版 applyImportedTheme（终端调色板、外观档位与界面变量一起切换，不写入网页版的主题选择）
 * - 守护：网页版之后若恢复了自己的主题（例如登录后同步云端主题），立即重新套用黑曜，避免终端配色被换走
 * - 恢复经典：沿用网页版自己的主题选择逻辑（派发主题下拉框的 change），无需刷新页面，SSH 会话不受影响
 */
import { customThemeStore } from '../../../upstream/frontend/src/custom-theme-manager';
import { applyImportedTheme, onTerminalThemeChange } from '../../../upstream/frontend/src/theme';
import { accentUi, BASE_UI, terminalPalette } from './palette-data';
import type { AccentId } from './state';

const CLASSIC_SELECTION_KEY = 'cloudssh_theme_selection';
const CUSTOM_THEME_VALUE = '__custom__';
const FALLBACK_THEME = 'cyberpunk';

let activeAccent: AccentId | null = null;
let applying = false;
let guardInstalled = false;

function themeData(accent: AccentId) {
  return {
    name: 'Obsidian',
    colorScheme: 'dark' as const,
    baseTheme: 'standard-dark' as const,
    ui: { ...BASE_UI, ...accentUi(accent) },
    terminal: terminalPalette(accent),
    appearance: {
      style: 'standard' as const,
      shape: 'soft' as const,
      density: 'comfortable' as const,
      font: 'system' as const,
      shadow: 'subtle' as const,
      motion: 'full' as const,
      blur: 'none' as const,
      components: { button: 'soft' as const, input: 'boxed' as const, card: 'flat' as const, tabs: 'segmented' as const },
    },
    effects: {},
    typography: { fontScale: 1, radiusScale: 1.2 },
  };
}

function installGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  onTerminalThemeChange((theme) => {
    if (applying || activeAccent === null) return;
    const ours = terminalPalette(activeAccent);
    if (theme.background === ours.background && theme.foreground === ours.foreground && theme.cursor === ours.cursor) return;
    // 不在网页版 applyTheme 的调用栈里递归：等它把监听者都通知完再改回来
    queueMicrotask(() => {
      if (activeAccent !== null) applyObsidianPalette(activeAccent);
    });
  });
}

export function applyObsidianPalette(accent: AccentId): void {
  activeAccent = accent;
  applying = true;
  try {
    applyImportedTheme(themeData(accent));
  } finally {
    applying = false;
  }
  installGuard();
}

/** 回到网页版主题：用户在网页版里选过的内置主题或自定义主题 */
export function restoreClassicPalette(): void {
  activeAccent = null;
  const select = document.querySelector<HTMLSelectElement>('select[data-theme-selector]');
  if (!select) return;
  const has = (value: string) => [...select.options].some((option) => option.value === value);
  let value = '';
  try {
    value = localStorage.getItem(CLASSIC_SELECTION_KEY) ?? '';
  } catch {
    value = '';
  }
  if (value === CUSTOM_THEME_VALUE && !customThemeStore.hasThemes()) value = FALLBACK_THEME;
  if (!value || !has(value)) value = FALLBACK_THEME;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}
