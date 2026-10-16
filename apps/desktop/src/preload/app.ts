/**
 * 实例页面（运行在 Worker origin 的网页 UI）的预加载脚本。
 * 只暴露最小的只读能力；网页版 UI 不依赖它，自研 UI 可按需使用。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cloudsshDesktop', {
  /** { platform, appVersion, instance: { id, name, baseUrl } } */
  info: () => ipcRenderer.invoke('desktop:info'),
  openInstanceManager: () => ipcRenderer.invoke('desktop:open-manager'),
});
