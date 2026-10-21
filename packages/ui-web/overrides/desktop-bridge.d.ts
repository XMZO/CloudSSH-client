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
    /** 连接诊断元数据（旧版客户端没有）。 */
    connectionLog?(entry: unknown): void;
    info(): Promise<CloudSSHDesktopBridgeInfo>;
    /** view 为 'cli' 时直接打开“命令行与 Skill”设置页（旧版客户端忽略参数，只打开实例管理） */
    openInstanceManager?(view?: 'cli'): Promise<void>;
    setTitleBarColors?(color: string, symbolColor: string): Promise<void>;
    menuState?(): Promise<CloudSSHDesktopMenuState>;
    command?(command: string, argument?: string): Promise<void>;
    onPalette?(callback: (toggle: boolean) => void): void;
    focusWindow?(): Promise<void>;
    /** 自动更新（旧版客户端没有） */
    update?: {
      status(): Promise<CloudSSHUpdateStatus>;
      check(): Promise<CloudSSHUpdateStatus>;
      /** confirmed：界面已经用自己的弹窗问过（客户端不再弹系统对话框；旧版客户端忽略，照样弹） */
      install(confirmed?: boolean): Promise<boolean>;
      onStatus(callback: (status: CloudSSHUpdateStatus) => void): void;
    };
    vault?: {
      available(): Promise<boolean>;
      read(): Promise<string | null>;
      write(data: string): Promise<void>;
      encrypt(text: string): Promise<string>;
      decrypt(data: string): Promise<string>;
    };
    /** 界面缓存（服务器列表等，启动时先用它显示；旧版客户端没有）。value 为 null 时删除 */
    uiCache?: {
      read(key: string): Promise<string | null>;
      write(key: string, value: string | null): Promise<void>;
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

/** 客户端自动更新的状态（apps/desktop/src/main/platform/updater.ts 的 UpdateStatus） */
type CloudSSHUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number; transferred?: number; total?: number; bytesPerSecond?: number }
  | { state: 'downloaded'; version: string }
  | { state: 'not-available'; checkedAt: number }
  | { state: 'error'; message: string }
  | { state: 'disabled'; reason: string };
