/**
 * 桌面端对网页版 UI 的定制入口（构建时注入，不修改 upstream 源码）。
 *
 * 可以在这里：
 * - 引入额外样式：import './desktop.css';
 * - 读取桌面桥接信息：window.cloudsshDesktop（由客户端 preload 注入，网页环境下不存在）
 * - 监听/增强 DOM（尽量做成可选、失败无害，避免上游改版后报错）
 */
import './desktop.css';

interface DesktopBridgeInfo {
  platform: string;
  appVersion: string;
  instance: { id: string; name: string; baseUrl: string };
}

declare global {
  interface Window {
    cloudsshDesktop?: { info(): Promise<DesktopBridgeInfo> };
  }
}

document.documentElement.dataset.cloudsshClient = 'desktop';

window.cloudsshDesktop
  ?.info()
  .then((info) => {
    document.documentElement.dataset.cloudsshPlatform = info.platform;
  })
  .catch(() => {
    // 桥接不可用时保持网页版原样
  });

export {};
