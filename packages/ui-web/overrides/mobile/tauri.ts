/** Rust 侧命令的类型化封装（apps/mobile/src-tauri/src/lib.rs） */
import { Channel, invoke } from '@tauri-apps/api/core';

export interface MobileInstance {
  id: string;
  name: string;
  baseUrl: string;
}

export interface MobileState {
  instances: MobileInstance[];
  currentId: string;
  current: MobileInstance;
  proxy: string | null;
  loggedIn: boolean;
  appVersion: string;
  platform: string;
}

export interface HttpResult {
  status: number;
  headers: [string, string][];
  body: string;
  base64: boolean;
}

export interface ProbeResult {
  latencyMs: number;
  authMode: string;
  loginRequired: boolean;
  oauthRedirectUri: string | null;
}

export type WsEvent =
  | { type: 'open'; protocol: string }
  | { type: 'text'; data: string }
  | { type: 'close'; code: number; reason: string; wasClean: boolean }
  | { type: 'error'; message: string };

export const isTauri = (): boolean =>
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === 'object';

export const native = {
  state: () => invoke<MobileState>('app_state'),
  saveInstance: (id: string | null, name: string, baseUrl: string) =>
    invoke<MobileInstance>('save_instance', { id, name, baseUrl }),
  deleteInstance: (id: string) => invoke<void>('delete_instance', { id }),
  selectInstance: (id: string) => invoke<void>('select_instance', { id }),
  setProxy: (proxy: string | null) => invoke<string | null>('set_proxy', { proxy }),
  clearLogin: (id: string) => invoke<void>('clear_login', { id }),
  testInstance: (baseUrl: string) => invoke<ProbeResult>('test_instance', { baseUrl }),
  http: (request: { method: string; path: string; headers: [string, string][]; body: string | null; bodyBase64: boolean }) =>
    invoke<HttpResult>('http_request', { request }),
  wsOpen: (path: string, onEvent: Channel<WsEvent | ArrayBuffer>) => invoke<number>('ws_open', { path, onEvent }),
  wsSend: (id: number, text: string) => invoke<void>('ws_send', { id, text }),
  wsSendBinary: (id: number, bytes: Uint8Array) =>
    invoke<void>('ws_send_binary', bytes, { headers: { 'x-ws-id': String(id) } }),
  wsClose: (id: number, code?: number, reason?: string) => invoke<void>('ws_close', { id, code, reason }),
  keepAlive: (sessions: number) => invoke<void>('keep_alive', { sessions }),
  saveDownload: (name: string, mime: string, bytes: Uint8Array) =>
    invoke<string>('save_download', bytes, {
      headers: { 'x-file-name': encodeURIComponent(name), 'x-mime': mime || 'application/octet-stream' },
    }),
  clipboardRead: () => invoke<string>('clipboard_read'),
  clipboardWrite: (text: string) => invoke<void>('clipboard_write', { text }),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  moveToBackground: () => invoke<void>('move_to_background'),
  systemBars: (color: string) => invoke<void>('system_bars', { color }),
  /** null 表示当前平台没有电池优化（桌面调试） */
  batteryStatus: () => invoke<boolean | null>('battery_status'),
  requestBatteryExemption: () => invoke<void>('request_battery_exemption'),
  /** null 表示当前平台不统计（桌面调试） */
  storageInfo: () => invoke<{ data: number; cache: number } | null>('storage_info'),
  clearCache: () => invoke<void>('clear_cache'),
};

export { Channel };
