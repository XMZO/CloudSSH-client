/**
 * 终端里的链接用系统浏览器打开。
 *
 * xterm 的链接插件（WebLinksAddon，以及 OSC 8 超链接）打开链接的方式是先 window.open() 一个空白页、
 * 断开 opener，再把它的 location.href 设成链接地址。客户端只允许把 http(s) 地址交给系统浏览器
 * （setWindowOpenHandler），空白页被拒绝、window.open() 返回 null，链接就怎么点都打不开。
 * 这里让不带地址的 window.open() 返回一个替身：设置 location.href 时再用真实地址调用 window.open，
 * 由主进程交给系统浏览器。带地址的调用原样放行。
 */
export function installExternalLinks(): void {
  const nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (url !== undefined && url !== '' && String(url) !== 'about:blank') return nativeOpen(url, target, features);
    const location = {
      set href(value: string) {
        nativeOpen(value, '_blank');
      },
      get href() {
        return 'about:blank';
      },
    };
    return { opener: null, location, close() {}, focus() {} } as unknown as Window;
  }) as typeof window.open;
}
