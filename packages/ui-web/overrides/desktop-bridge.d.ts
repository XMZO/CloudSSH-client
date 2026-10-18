/** 桌面客户端 preload 注入的桥接对象（apps/desktop/src/preload/app.ts）；网页环境下不存在 */
interface CloudSSHDesktopBridgeInfo {
  platform: string;
  appVersion: string;
  instance: { id: string; name: string; baseUrl: string };
  /** 窗口没有系统边框，由界面自己画标题栏（旧版客户端没有这两项） */
  customChrome?: boolean;
  titleBarHeight?: number;
}

interface Window {
  cloudsshDesktop?: {
    info(): Promise<CloudSSHDesktopBridgeInfo>;
    openInstanceManager?(): Promise<void>;
    setTitleBarColors?(color: string, symbolColor: string): Promise<void>;
    menuState?(): Promise<CloudSSHDesktopMenuState>;
    command?(command: string, argument?: string): Promise<void>;
  };
}

interface CloudSSHDesktopMenuState {
  instances: { id: string; name: string; host: string }[];
  currentId: string | null;
  version: string;
  fullscreen: boolean;
}
