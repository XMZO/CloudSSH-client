/**
 * 实例页面（运行在 Worker origin 的网页 UI）的预加载脚本。
 * 只暴露最小的只读能力；网页版 UI 不依赖它，自研 UI 可按需使用。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cloudsshDesktop', {
  /** { platform, appVersion, instance: { id, name, baseUrl } } */
  info: () => ipcRenderer.invoke('desktop:info'),
  /** view 为 'cli' 时直接打开“命令行与 Skill”设置页 */
  openInstanceManager: (view?: 'cli') => ipcRenderer.invoke('desktop:open-manager', view),
  /** 自绘标题栏：系统窗口按钮的背景色与图标色（#rrggbb） */
  setTitleBarColors: (color: string, symbolColor: string) => ipcRenderer.invoke('desktop:titlebar', { color, symbolColor }),
  /** 自绘标题栏的应用菜单、实例菜单：{ instances: [{ id, name, host }], currentId, version, fullscreen } */
  menuState: () => ipcRenderer.invoke('desktop:menu-state'),
  /** 菜单命令：switch-instance / new-window（参数为实例 id）、login、manager、cli-settings、reload、force-reload、devtools、
   *  zoom-reset / zoom-in / zoom-out、fullscreen、open-config、open-logs、quit */
  command: (command: string, argument?: string) => ipcRenderer.invoke('desktop:command', command, argument),
  /** 系统全局快捷键：打开命令面板（toggle 为 true 表示窗口本来就在前台，再按一次应关闭面板） */
  onPalette: (callback: (toggle: boolean) => void) => {
    ipcRenderer.on('desktop:palette', (_event, toggle: unknown) => callback(toggle === true));
    // 快捷键打开的新窗口：页面装好命令面板后再打开
    void ipcRenderer.invoke('desktop:palette-pending').then((pending: unknown) => pending === true && callback(false));
  },
  /** 把本窗口叫到前台（点系统通知后） */
  focusWindow: () => ipcRenderer.invoke('desktop:focus'),
  /** 自动更新（左下角版本号）：状态 { state, version?, percent?, checkedAt?, message?, reason? }、手动检查、确认后重启安装 */
  update: {
    status: () => ipcRenderer.invoke('desktop:update-status'),
    check: () => ipcRenderer.invoke('desktop:update-check'),
    /** confirmed：界面已经用自己的弹窗确认过（只对内置界面生效，其他页面仍弹系统对话框） */
    install: (confirmed?: boolean) => ipcRenderer.invoke('desktop:update-install', confirmed === true),
    onStatus: (callback: (status: unknown) => void) => {
      ipcRenderer.on('desktop:update-status', (_event, status: unknown) => callback(status));
    },
  },
  /** 凭据预设的本地保管（仅内置界面可用）：列表 JSON 的读写与系统加密 */
  vault: {
    available: () => ipcRenderer.invoke('desktop:vault', 'available'),
    read: () => ipcRenderer.invoke('desktop:vault', 'read'),
    write: (data: string) => ipcRenderer.invoke('desktop:vault', 'write', data),
    encrypt: (text: string) => ipcRenderer.invoke('desktop:vault', 'encrypt', text),
    decrypt: (data: string) => ipcRenderer.invoke('desktop:vault', 'decrypt', data),
  },
  /** 界面缓存（仅内置界面可用）：服务器列表等，启动时先用它显示；value 为 null 时删除 */
  uiCache: {
    read: (key: string) => ipcRenderer.invoke('desktop:ui-cache', 'read', key),
    write: (key: string, value: string | null) => ipcRenderer.invoke('desktop:ui-cache', 'write', key, value),
  },
  /** 把 SFTP 文件拖到桌面：登记 → 网页版照常下载（主进程存进临时目录）→ 准备好后开始系统拖放 */
  dragOut: {
    prepare: (token: string, names: string[]) => ipcRenderer.invoke('desktop:drag-prepare', token, names),
    start: (token: string) => ipcRenderer.send('desktop:drag-start', token),
    release: (token: string) => ipcRenderer.invoke('desktop:drag-release', token),
    onReady: (callback: (token: string, ok: boolean) => void) => {
      ipcRenderer.on('desktop:drag-ready', (_event, token: unknown, ok: unknown) => {
        if (typeof token === 'string') callback(token, ok === true);
      });
    },
  },
});
