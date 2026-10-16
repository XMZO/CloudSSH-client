/** 桌面客户端 preload 注入的桥接对象（apps/desktop/src/preload/app.ts）；网页环境下不存在 */
interface CloudSSHDesktopBridgeInfo {
  platform: string;
  appVersion: string;
  instance: { id: string; name: string; baseUrl: string };
}

interface Window {
  cloudsshDesktop?: {
    info(): Promise<CloudSSHDesktopBridgeInfo>;
    openInstanceManager?(): Promise<void>;
  };
}
