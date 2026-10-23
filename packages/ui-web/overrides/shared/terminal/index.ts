/**
 * 终端增强（桌面端与手机端共用）：内置 JetBrains Mono 字体 + 关键词高亮；等待自动重连时精确到毫秒的实时倒计时与
 * 按任意键立即重连（reconnect-countdown.ts）、会话正常结束（exit、空闲超时）后按任意键重新连接的提示。
 *
 * 构建钩子（vite.config.ts）在网页版每创建/销毁一个终端时调用 __cloudsshTerminalCreated / __cloudsshTerminalDisposed，
 * 这里据此设置字体、挂上高亮引擎；WebGL 上下文丢失时调用 __cloudsshWebglLost，这里在页面可见后重新挂上 WebGL 渲染器。
 */
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import { getActiveTerminalTheme, onTerminalThemeChange } from '../../../upstream/frontend/src/theme';
import { colorAdjuster, TerminalHighlighter, type CompiledRule } from './highlight-engine';
import { HIGHLIGHT_CHANGED_EVENT, loadSettings } from './highlight-rules';
import { ht } from './i18n';
import { startReconnectCountdown } from './reconnect-countdown';
import { installResumeRetry } from './resume-retry';
import { installResumeRedraw } from './resume-redraw';
import { installReconnectsExhausted } from './reboot-wait';
import { installIdleReminder } from './idle-reminder';
import { installHeartbeatGuard } from './heartbeat-guard';
import { installSessionEnd } from '../session-end';
import { installResizeSettle } from './resize-settle';
import { installResizeRender } from './resize-render';
import { confirmLinkHandler, setLinkTerminalResolver } from '../link-confirm';
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
  // OSC 8 超链接：xterm 默认弹浏览器自带的 confirm()，换成与普通链接同一张确认卡片（../link-confirm.ts）
  term.options.linkHandler = confirmLinkHandler;
  // 尺寸变化后远端的整屏重画攒齐了一次显示，不一截截地闪（./resize-settle.ts）
  installResizeSettle(term);
  // 改尺寸后先按新的折行重标关键词高亮，再当场重画：不留一帧空白画布，也不留几帧错位的高亮（./resize-render.ts）
  installResizeRender(term, () => highlighters.get(term)?.rescanNow());
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

/** 每个终端最近几次重建 WebGL 渲染器的时间 */
const webglRestores = new WeakMap<Terminal, number[]>();
const WEBGL_RESTORE_LIMIT = 5;
const WEBGL_RESTORE_WINDOW = 10 * 60_000;

/**
 * WebGL 上下文丢失后（安卓切到后台、显存紧张时常见）网页版只释放渲染器，终端从此退回 DOM 渲染：每个字符格
 * 都是页面元素，刷屏时整屏重排，小字号格子多时尤其卡。页面回到前台后过一会儿重新挂上 WebGL 渲染器；
 * 十分钟内丢了 5 次就不再重试（这台设备的 WebGL 不稳定，留在 DOM 渲染）
 */
function restoreWebgl(term: Terminal): void {
  const now = Date.now();
  const recent = (webglRestores.get(term) ?? []).filter((time) => now - time < WEBGL_RESTORE_WINDOW);
  if (recent.length >= WEBGL_RESTORE_LIMIT) return;
  webglRestores.set(term, [...recent, now]);
  const attach = () => {
    // 终端已经关掉了
    if (!highlighters.has(term) || !term.element?.isConnected) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        restoreWebgl(term);
      });
      term.loadAddon(addon);
    } catch (error) {
      console.warn('[cloudssh] webgl restore', error);
    }
  };
  const later = () => window.setTimeout(attach, 800);
  if (document.visibilityState === 'visible') {
    later();
    return;
  }
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVisible);
    later();
  };
  document.addEventListener('visibilitychange', onVisible);
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
    __cloudsshWebglLost?: (term: Terminal) => void;
  };
  scope.__cloudsshTerminalCreated = onCreated;
  scope.__cloudsshTerminalDisposed = onDisposed;
  scope.__cloudsshWebglLost = restoreWebgl;
  // 点链接确认时高亮点到的那个链接：要知道点的位置在哪个终端里
  setLinkTerminalResolver(terminalFor);
  // 服务器端断开时自动关闭标签（可开关，见 ../session-end.ts）
  installSessionEnd();
  // 断线后在服务器的 60 秒保持期内持续尝试秒级恢复，恢复不了才完整重连（./resume-retry.ts）
  installResumeRetry();
  // 恢复成功后让 Shell 重画提示符，不用按回车（./resume-redraw.ts）
  installResumeRedraw();
  // 自动重连次数用完还没连上：接着每隔几秒试，不停在那里（./reboot-wait.ts）
  installReconnectsExhausted();
  // 快空闲断开时弹提醒，点“继续”续期（./idle-reminder.ts）
  installIdleReminder();
  // 心跳超时前先看最近有没有收到过消息，不把还活着的慢连接当成卡死（./heartbeat-guard.ts）
  installHeartbeatGuard();
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
