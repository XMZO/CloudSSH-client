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
 *   app-menus.ts     标题栏左上角的应用菜单、实例菜单（页面里画，不用系统原生菜单）
 *   links.ts         终端里的链接用系统浏览器打开
 *   palette.ts/css   命令面板（Ctrl+Shift+P / 系统全局快捷键）：搜服务器、会话、命令片段与操作
 *   notifications.ts 窗口不在前台时，长命令结束、响铃、断线与重连发系统通知
 *   sftp-drop.ts/css 文件/文件夹拖到终端或 SFTP 面板上传；SFTP 文件拖到桌面下载
 * 凭据预设（shared/credential-presets）的密码与私钥用系统加密（safeStorage）保存在配置目录。
 *
 * 窗口有没有系统边框由客户端决定（内置界面才去掉边框）：没有边框时两种主题都显示标题栏；
 * 有边框时只有工作台显示（作为应用顶栏）。
 */
import type { ITheme } from '@xterm/xterm';
import { getActiveTerminalTheme, onTerminalThemeChange } from '../../upstream/frontend/src/theme';
import { installCredentialPresets, openPresetManager, presetText } from '../shared/credential-presets';
import { mountDrawerResizers } from './drawers';
import { mountHome } from './home';
import { installExternalLinks } from './links';
import { installDesktopNotifications } from './notifications';
import { qt } from '../shared/qr-sync/i18n';
import { installPalette, registerPaletteAction } from './palette';
import { openQrSync } from './qr-sync';
import { installSftpDragDrop } from './sftp-drop';
import { mountSnippetEnhancements } from './snippets';
import { desktopSkin, SKIN_CHANGED_EVENT, trackView } from './state';
import { mountTitlebar } from './titlebar';
import './workbench.css';
import './classic.css';
import './snippets.css';
import './drawers.css';

export async function mountDesktopShell(): Promise<void> {
  // 终端里的链接用系统浏览器打开（不依赖界面主题，越早装越好）
  installExternalLinks();
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
    installPalette();
    installDesktopNotifications();
    installSftpDragDrop();
    installCredentialPresets({ vault: bridge?.vault ?? null, scope: info?.instance.id ? `instance:${info.instance.id}` : null });
    registerPaletteAction(() => ({
      title: presetText('title'),
      icon: 'key',
      keywords: 'credential preset password key 凭据 密码 私钥',
      run: () => void openPresetManager(),
    }));
    registerPaletteAction(() => ({
      title: qt('title'),
      icon: 'qr_code_2',
      keywords: 'sync phone qr mobile 同步 手机 二维码 扫码',
      run: () => void openQrSync(),
    }));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
