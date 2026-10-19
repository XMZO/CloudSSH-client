/**
 * 终端增强（桌面端与手机端共用）：内置 JetBrains Mono 字体 + 关键词高亮；等待自动重连时精确到毫秒的实时倒计时与
 * 按任意键立即重连（reconnect-countdown.ts）、会话正常结束（exit、空闲超时）后按任意键重新连接的提示。
 *
 * 构建钩子（vite.config.ts）在网页版每创建/销毁一个终端时调用 __cloudsshTerminalCreated / __cloudsshTerminalDisposed，
 * 这里据此设置字体、挂上高亮引擎。
 */
import type { Terminal } from '@xterm/xterm';
import { getActiveTerminalTheme, onTerminalThemeChange } from '../../../upstream/frontend/src/theme';
import { colorAdjuster, TerminalHighlighter, type CompiledRule } from './highlight-engine';
import { HIGHLIGHT_CHANGED_EVENT, loadSettings } from './highlight-rules';
import { ht } from './i18n';
import { startReconnectCountdown } from './reconnect-countdown';
import './terminal.css';

export { openHighlightEditor } from './highlight-editor';

/**
 * 终端字体：JetBrains Mono 随客户端内置（不再依赖 Google Fonts）。中文等它没有的字形按顺序回退：
 * Windows 上用微软雅黑 UI（不写的话浏览器默认用新宋体，小字号很难看），macOS 苹方，安卓 Noto Sans CJK
 */
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", monospace';

const highlighters = new Map<Terminal, TerminalHighlighter>();
let compiled: CompiledRule[] = [];
let adjust = colorAdjuster(undefined);

function compile(): void {
  const settings = loadSettings();
  compiled = [];
  if (!settings.enabled) return;
  for (const rule of settings.rules) {
    if (!rule.enabled || !rule.pattern) continue;
    try {
      compiled.push({ regex: new RegExp(rule.pattern, `g${rule.flags ?? 'i'}`), color: rule.color });
    } catch {
      // 写错的规则跳过，不影响其他规则
    }
  }
}

function refreshAll(): void {
  for (const highlighter of highlighters.values()) highlighter.refresh();
}

function onCreated(term: Terminal): void {
  if (highlighters.has(term)) return;
  term.options.fontFamily = TERMINAL_FONT_FAMILY;
  highlighters.set(
    term,
    new TerminalHighlighter(term, () => compiled, (hex) => adjust(hex))
  );
}

function onDisposed(term: Terminal): void {
  highlighters.get(term)?.dispose();
  highlighters.delete(term);
}

/** 页面上某个节点所在的终端（手机端的长按选择、双指缩放用） */
export function terminalFor(node: Element | null): Terminal | null {
  const element = node?.closest('.xterm');
  if (!element) return null;
  for (const term of highlighters.keys()) if (term.element === element) return term;
  return null;
}

/** 字体在终端打开之后才加载完时，让 xterm 重新测量字宽并按新字宽重排 */
async function loadFont(): Promise<void> {
  try {
    await Promise.all([document.fonts.load('400 14px "JetBrains Mono"'), document.fonts.load('700 14px "JetBrains Mono"')]);
  } catch {
    return;
  }
  let opened = false;
  for (const term of highlighters.keys()) {
    if (!term.element) continue;
    opened = true;
    term.options.fontFamily = `${TERMINAL_FONT_FAMILY}, sans-serif`;
    term.options.fontFamily = TERMINAL_FONT_FAMILY;
  }
  if (opened) window.dispatchEvent(new Event('resize'));
}

let installed = false;

export function installTerminalEnhancements(): void {
  if (installed) return;
  installed = true;
  const scope = globalThis as {
    __cloudsshTerminalCreated?: (term: Terminal) => void;
    __cloudsshTerminalDisposed?: (term: Terminal) => void;
  };
  scope.__cloudsshTerminalCreated = onCreated;
  scope.__cloudsshTerminalDisposed = onDisposed;
  // 等待自动重连时：构建钩子在网页版写出“x 秒后重连”之后调用，把那一行换成精确到毫秒的实时倒计时并附上按键提示
  (globalThis as { __cloudsshReconnectCountdown?: typeof startReconnectCountdown }).__cloudsshReconnectCountdown =
    startReconnectCountdown;
  // 按键重连的静态提示：会话正常结束（exit、空闲超时）后网页版不再重连时（manual，按键重新连接）；
  // 倒计时没装上时也用它在“x 秒后重连”下面加一行
  (globalThis as { __cloudsshReconnectHint?: (mode?: 'manual') => string }).__cloudsshReconnectHint = (mode) =>
    ht(mode === 'manual' ? 'reconnectManual' : 'reconnectNow');

  compile();
  adjust = colorAdjuster(getActiveTerminalTheme().background);
  window.addEventListener(HIGHLIGHT_CHANGED_EVENT, () => {
    compile();
    refreshAll();
  });
  // 换主题后按新背景调整高亮颜色（浅色背景上压暗）
  onTerminalThemeChange((theme) => {
    adjust = colorAdjuster(theme.background);
    refreshAll();
  });
  void loadFont();
}
