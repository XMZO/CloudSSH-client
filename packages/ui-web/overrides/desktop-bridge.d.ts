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
    /** view 为 'cli' 时直接打开“命令行与 Skill”设置页（旧版客户端忽略参数，只打开实例管理） */
    openInstanceManager?(view?: 'cli'): Promise<void>;
    setTitleBarColors?(color: string, symbolColor: string): Promise<void>;
    menuState?(): Promise<CloudSSHDesktopMenuState>;
    command?(command: string, argument?: string): Promise<void>;
    onPalette?(callback: (toggle: boolean) => void): void;
    focusWindow?(): Promise<void>;
    vault?: {
      available(): Promise<boolean>;
      read(): Promise<string | null>;
      write(data: string): Promise<void>;
      encrypt(text: string): Promise<string>;
      decrypt(data: string): Promise<string>;
    };
    dragOut?: {
      prepare(token: string, names: string[]): Promise<void>;
      start(token: string): void;
      release(token: string): Promise<void>;
      onReady(callback: (token: string, ok: boolean) => void): void;
    };
  };
}

interface CloudSSHDesktopMenuState {
  instances: { id: string; name: string; host: string }[];
  currentId: string | null;
  version: string;
  fullscreen: boolean;
}
