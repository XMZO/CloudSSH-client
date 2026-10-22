/**
 * 终端里的链接用系统浏览器打开，点了先确认（卡片与接管方式见 ../shared/link-confirm.ts）。
 *
 * xterm 的链接插件（WebLinksAddon，以及 OSC 8 超链接）打开链接的方式是先 window.open() 一个空白页、
 * 断开 opener，再把它的 location.href 设成链接地址。客户端只允许把 http(s) 地址交给系统浏览器
 * （setWindowOpenHandler），空白页会被拒绝：由共用模块给链接插件一个替身，确认后再用真实地址调用
 * window.open，由主进程交给系统浏览器。按住 Ctrl 单击直接打开。
 */
import { installLinkConfirm } from '../shared/link-confirm';

export function installExternalLinks(): void {
  installLinkConfirm({
    desktop: true,
    open: (url) => {
      window.open(url, '_blank');
    },
  });
}
