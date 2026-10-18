/**
 * 实例页面（运行在 Worker origin 的网页 UI）的预加载脚本。
 * 只暴露最小的只读能力；网页版 UI 不依赖它，自研 UI 可按需使用。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cloudsshDesktop', {
  /** { platform, appVersion, instance: { id, name, baseUrl } } */
  info: () => ipcRenderer.invoke('desktop:info'),
  openInstanceManager: () => ipcRenderer.invoke('desktop:open-manager'),
  /** 自绘标题栏：系统窗口按钮的背景色与图标色（#rrggbb） */
  setTitleBarColors: (color: string, symbolColor: string) => ipcRenderer.invoke('desktop:titlebar', { color, symbolColor }),
  /** 自绘标题栏的应用菜单、实例菜单：{ instances: [{ id, name, host }], currentId, version, fullscreen } */
  menuState: () => ipcRenderer.invoke('desktop:menu-state'),
  /** 菜单命令：switch-instance / new-window（参数为实例 id）、login、manager、reload、force-reload、devtools、
   *  zoom-reset / zoom-in / zoom-out、fullscreen、open-config、open-logs、quit */
  command: (command: string, argument?: string) => ipcRenderer.invoke('desktop:command', command, argument),
});
