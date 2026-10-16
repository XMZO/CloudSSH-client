/** 实例管理窗口的预加载脚本：把管理通道包装成 window.managerApi */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('managerApi', {
  state: () => ipcRenderer.invoke('manager:state'),
  saveInstance: (input: unknown) => ipcRenderer.invoke('manager:save-instance', input),
  deleteInstance: (id: string, clearData: boolean) => ipcRenderer.invoke('manager:delete-instance', id, clearData),
  setDefault: (id: string) => ipcRenderer.invoke('manager:set-default', id),
  openInstance: (id: string, newWindow: boolean) => ipcRenderer.invoke('manager:open-instance', id, newWindow),
  login: (id: string) => ipcRenderer.invoke('manager:login', id),
  clearData: (id: string) => ipcRenderer.invoke('manager:clear-data', id),
  testInstance: (baseUrl: string) => ipcRenderer.invoke('manager:test-instance', baseUrl),
  setPreferences: (patch: unknown) => ipcRenderer.invoke('manager:set-preferences', patch),
  pickDirectory: () => ipcRenderer.invoke('manager:pick-directory'),
  openPath: (kind: 'config' | 'logs') => ipcRenderer.invoke('manager:open-path', kind),
  checkUpdate: () => ipcRenderer.invoke('manager:check-update'),
  onChanged: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('manager:changed', handler);
    return () => ipcRenderer.removeListener('manager:changed', handler);
  },
});
