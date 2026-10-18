/**
 * 桌面端界面主题。
 *
 *   state.ts     主题（工作台 / 经典）与当前视图
 *   titlebar.ts  自绘标题栏：菜单、实例、会话标签、终端工具、设置；系统窗口按钮配色
 *   settings.ts  设置面板（主题、配色、语言、AI、关键词高亮、实例管理、退出登录）
 *   home.ts      工作台的服务器列表（表格）
 *   workbench.css  工作台的页面布局（收起网页版顶栏页脚、终端占满、底部状态栏）
 *   classic.css    经典主题在桌面窗口里的排版修正
 *   snippets.ts/css  命令片段面板：工作台下收窄成紧凑列表，双击填入终端
 *   drawers.ts/css   右侧抽屉（SFTP、命令片段、AI 助手）拖动左边缘调宽，按面板记住宽度
 *
 * 窗口有没有系统边框由客户端决定（内置界面才去掉边框）：没有边框时两种主题都显示标题栏；
 * 有边框时只有工作台显示（作为应用顶栏）。
 */
import type { ITheme } from '@xterm/xterm';
import { getActiveTerminalTheme, onTerminalThemeChange } from '../../upstream/frontend/src/theme';
import { mountDrawerResizers } from './drawers';
import { mountHome } from './home';
import { mountSnippetEnhancements } from './snippets';
import { desktopSkin, SKIN_CHANGED_EVENT, trackView } from './state';
import { mountTitlebar } from './titlebar';
import './workbench.css';
import './classic.css';
import './snippets.css';
import './drawers.css';

export async function mountDesktopShell(): Promise<void> {
  const html = document.documentElement;
  html.dataset.csDesk = desktopSkin();
  const bridge = window.cloudsshDesktop;
  const info = await bridge?.info().catch(() => null);
  // 在浏览器里调试界面时没有桥接：localStorage 设 cloudssh_desktop_frameless=1 可模拟无边框窗口
  let preview = false;
  try {
    preview = !bridge && localStorage.getItem('cloudssh_desktop_frameless') === '1';
  } catch {
    // 忽略
  }
  const customChrome = info?.customChrome === true || preview;

  const start = () => {
    trackView();
    mountTitlebar({
      customChrome,
      platform: info?.platform ?? 'web',
      instanceName: info?.instance.name ?? location.host,
      instanceUrl: info?.instance.baseUrl ?? location.origin,
    });
    // 有系统边框时，经典主题用网页版自己的顶栏，不需要标题栏
    const syncChrome = () => html.classList.toggle('cs-chrome', customChrome || desktopSkin() === 'workbench');
    syncChrome();
    // 终端四周留白的颜色跟终端背景一致（浅色配色下不会露出一圈灰边）
    const syncTerminalBackground = (theme: ITheme) => html.style.setProperty('--cs-term-bg', theme.background ?? 'transparent');
    syncTerminalBackground(getActiveTerminalTheme());
    onTerminalThemeChange(syncTerminalBackground);
    window.addEventListener(SKIN_CHANGED_EVENT, () => {
      syncChrome();
      // 顶栏收起/恢复后终端可用高度变了
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
    mountHome();
    mountSnippetEnhancements();
    mountDrawerResizers();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
