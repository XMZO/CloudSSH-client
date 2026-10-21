/**
 * 把实例页面当前的配色报给主进程，实例管理窗口照着它配色（跟随主题：标准深浅、赛博朋克、液态玻璃、自定义主题……）。
 * 取网页版主题算好的 CSS 变量，半透明的叠在页面背景上算成不透明色；主题变了、窗口获得焦点时重报一次
 * （几个实例窗口主题不同时，以最近用的那个为准）。主进程只收下格式正确的十六进制颜色。
 */
import { onColorSchemeChange } from '../../upstream/frontend/src/theme';
import { opaqueHex } from './dom';

type Palette = Record<string, string>;

function readPalette(): Palette | null {
  const root = getComputedStyle(document.documentElement);
  const first = (...names: string[]) => {
    for (const name of names) {
      const value = root.getPropertyValue(name).trim();
      if (value) return value;
    }
    return '';
  };
  const bodyBg = opaqueHex(getComputedStyle(document.body).backgroundColor) ?? '#131313';
  const bg = first('--bg') ? opaqueHex(first('--bg'), bodyBg) : bodyBg;
  if (!bg) return null;
  const on = (value: string, base: string = bg) => (value ? opaqueHex(value, base) : null);
  const accent = on(first('--accent'));
  const palette = {
    bg,
    surface: on(first('--bg-surface', '--bg')),
    elevated: on(first('--bg-elevated', '--bg-surface')),
    border: on(first('--border')),
    borderStrong: on(first('--border-strong', '--border')),
    text: on(first('--on-surface', '--text')),
    muted: on(first('--on-surface-variant', '--text-muted', '--text-dim')),
    accent,
    onAccent: on(first('--on-accent'), accent ?? bg),
    danger: on(first('--error')),
  };
  return Object.values(palette).every((value) => typeof value === 'string') ? (palette as Palette) : null;
}

export function installThemeShare(): void {
  const bridge = window.cloudsshDesktop;
  if (!bridge?.setUiPalette) return;
  let last = '';
  const report = (force: boolean) => {
    const palette = readPalette();
    if (!palette) return;
    const key = JSON.stringify(palette);
    if (!force && key === last) return;
    last = key;
    bridge.setUiPalette?.(palette);
  };
  let frame = 0;
  // 主题过渡动画结束后再取色
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setTimeout(() => report(false), 300));
  };
  onColorSchemeChange(schedule);
  new MutationObserver(schedule).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-ui-style', 'data-cs-desk'],
  });
  window.addEventListener('focus', () => report(true));
  schedule();
}
