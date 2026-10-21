/**
 * 实例页面报来的配色（ui-web 的 desktop/theme-share.ts）：实例管理窗口照着它配色，跟随用户选的主题。
 * 存在 userData/ui-palette.json，没开实例窗口时打开实例管理也是上次的主题；只收固定几项、格式正确的十六进制颜色。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const PALETTE_KEYS = ['bg', 'surface', 'elevated', 'border', 'borderStrong', 'text', 'muted', 'accent', 'onAccent', 'danger'] as const;
export type UiPalette = Record<(typeof PALETTE_KEYS)[number], string>;

const HEX = /^#[0-9a-f]{6}$/i;
let current: UiPalette | null = null;
let loaded = false;

function file(): string {
  return path.join(app.getPath('userData'), 'ui-palette.json');
}

export function normalizePalette(input: unknown): UiPalette | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const palette = {} as UiPalette;
  for (const key of PALETTE_KEYS) {
    const value = source[key];
    if (typeof value !== 'string' || !HEX.test(value)) return null;
    palette[key] = value.toLowerCase();
  }
  return palette;
}

export function currentPalette(): UiPalette | null {
  if (!loaded) {
    loaded = true;
    try {
      current = normalizePalette(JSON.parse(fs.readFileSync(file(), 'utf8')));
    } catch {
      current = null;
    }
  }
  return current;
}

/** 记下新配色；和原来一样时返回 false */
export function setPalette(palette: UiPalette): boolean {
  if (JSON.stringify(currentPalette()) === JSON.stringify(palette)) return false;
  current = palette;
  try {
    fs.writeFileSync(file(), `${JSON.stringify(palette, null, 2)}\n`);
  } catch {
    // 存不下只影响下次启动
  }
  return true;
}

/** 背景偏暗算深色（决定表单控件、滚动条的 color-scheme） */
export function isDarkPalette(palette: UiPalette): boolean {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(palette.bg.slice(index, index + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}
