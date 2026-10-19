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
  /** 录制全局快捷键期间暂停旧快捷键（否则按下时被系统截走，窗口收不到） */
  setShortcutRecording: (recording: boolean) => ipcRenderer.invoke('manager:shortcut-recording', recording),
  pickDirectory: () => ipcRenderer.invoke('manager:pick-directory'),
  openPath: (kind: 'config' | 'logs') => ipcRenderer.invoke('manager:open-path', kind),
  checkUpdate: () => ipcRenderer.invoke('manager:check-update'),
  cliStatus: () => ipcRenderer.invoke('manager:cli-status'),
  cliInstall: () => ipcRenderer.invoke('manager:cli-install'),
  cliUninstall: () => ipcRenderer.invoke('manager:cli-uninstall'),
  cliSettings: () => ipcRenderer.invoke('manager:cli-settings'),
  setCliSettings: (patch: unknown) => ipcRenderer.invoke('manager:cli-settings-set', patch),
  /** 应用里点了“命令行与 Skill”：切到设置页 */
  onShowView: (listener: (view: string) => void) => {
    ipcRenderer.on('manager:show-view', (_event, view: unknown) => listener(String(view)));
  },
  onChanged: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('manager:changed', handler);
    return () => ipcRenderer.removeListener('manager:changed', handler);
  },
});
