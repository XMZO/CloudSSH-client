/**
 * 黑曜主题配色（唯一来源，零依赖）：
 * - early.ts 用它生成带 !important 的 CSS 变量：启动即生效不闪烁，网页版恢复自己的主题时也盖不掉
 * - palette.ts 用同一份数据调用网页版 applyImportedTheme，驱动终端（xterm）调色板与外观档位
 * 颜色值都满足网页版主题白名单（#hex / rgba），可原样通过 normalizeThemeData 校验。
 */
import type { AccentId } from './state';

export const ACCENT_COLORS: Record<AccentId, string> = {
  indigo: '#8c9eff',
  teal: '#4fd8c4',
  green: '#6edb98',
  amber: '#f4c062',
  rose: '#ff8fae',
};

const BG = '#0c0e12';

export function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 与强调色无关的界面变量 */
export const BASE_UI: Record<string, string> = {
  '--bg': BG,
  '--bg-surface': '#13161c',
  '--bg-elevated': '#191d24',
  '--bg-terminal': BG,
  '--text': '#e7eaf0',
  '--text-muted': '#a2abba',
  '--text-dim': '#6c7486',
  '--accent-secondary': '#5ad3c2',
  '--accent-secondary-light': '#a8efe5',
  '--border': 'rgba(255, 255, 255, 0.07)',
  '--border-strong': 'rgba(255, 255, 255, 0.13)',
  '--error': '#ff6b7a',
  '--error-bg': 'rgba(255, 107, 122, 0.14)',
  '--warning': '#f4c062',
  '--on-accent': BG,
  '--surface-dot': '#2a2f39',
  '--on-surface': '#e7eaf0',
  '--on-surface-variant': '#a2abba',
  '--scrollbar-track': 'rgba(0, 0, 0, 0)',
  '--scrollbar-thumb': 'rgba(255, 255, 255, 0.14)',
  '--scrollbar-thumb-hover': 'rgba(255, 255, 255, 0.24)',
  '--scanline-tint': 'rgba(0, 0, 0, 0)',
  '--modal-overlay': 'rgba(5, 7, 10, 0.62)',
  '--agent-agent-color': '#5ad3c2',
};

/** 随强调色变化的界面变量 */
export function accentUi(accent: AccentId): Record<string, string> {
  const color = ACCENT_COLORS[accent];
  return {
    '--accent': color,
    '--accent-bg': rgba(color, 0.14),
    '--accent-glow': rgba(color, 0.22),
    '--agent-user-color': color,
  };
}

/** 非网页版主题白名单里的设计变量：只走 CSS（字体、圆角、阴影） */
export const DESIGN_TOKENS: Record<string, string> = {
  '--font-ui': 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", "PingFang SC", sans-serif',
  '--cs-radius-sm': '10px',
  '--cs-radius': '14px',
  '--cs-radius-lg': '20px',
  '--cs-surface-2': '#1f242d',
  '--cs-hairline': 'rgba(255, 255, 255, 0.06)',
  '--cs-shadow': '0 10px 30px rgba(0, 0, 0, 0.45)',
  '--cs-ok': '#5ad3c2',
  '--cs-warn': '#f4c062',
  '--cs-bad': '#ff6b7a',
};

export function terminalPalette(accent: AccentId): Record<string, string> {
  const color = ACCENT_COLORS[accent];
  return {
    background: BG,
    foreground: '#dde3ec',
    cursor: color,
    cursorAccent: BG,
    selectionBackground: rgba(color, 0.32),
    selectionInactiveBackground: rgba(color, 0.18),
    black: '#1c2029',
    red: '#ff6b7a',
    green: '#6edb98',
    yellow: '#f4c062',
    blue: '#82aaff',
    magenta: '#c792ea',
    cyan: '#5ad3c2',
    white: '#c9d1dc',
    brightBlack: '#5c6578',
    brightRed: '#ff8c97',
    brightGreen: '#8ee8b0',
    brightYellow: '#f8d68b',
    brightBlue: '#a3c1ff',
    brightMagenta: '#dbb2f5',
    brightCyan: '#84e6d8',
    brightWhite: '#f2f5f9',
  };
}

const declarations = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([name, value]) => `${name}:${value} !important;`)
    .join('');

/** 生成全部门控样式：html[data-cs-skin="obsidian"] 才生效，强调色按 data-cs-accent 切换 */
export function paletteCss(): string {
  const base = `html[data-cs-skin="obsidian"]{${declarations({ ...BASE_UI, ...DESIGN_TOKENS })}color-scheme:dark;}`;
  const accents = (Object.keys(ACCENT_COLORS) as AccentId[])
    .map((id) => `html[data-cs-skin="obsidian"][data-cs-accent="${id}"]{${declarations(accentUi(id))}}`)
    .join('');
  return base + accents;
}
