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
  /** 当前实例的界面缓存（应用数据目录，不受“清除缓存”影响；见 overrides/shared/boot.ts） */
  uiCacheRead: (key: string) => invoke<string | null>('ui_cache_read', { key }),
  uiCacheWrite: (key: string, value: string | null) => invoke<void>('ui_cache_write', { key, value }),
  testInstance: (baseUrl: string) => invoke<ProbeResult>('test_instance', { baseUrl }),
  http: (request: { method: string; path: string; headers: [string, string][]; body: string | null; bodyBase64: boolean }) =>
    invoke<HttpResult>('http_request', { request }),
  wsOpen: (path: string, onEvent: Channel<WsEvent | ArrayBuffer>) => invoke<number>('ws_open', { path, onEvent }),
  wsSend: (id: number, text: string) => invoke<void>('ws_send', { id, text }),
  wsSendBinary: (id: number, bytes: Uint8Array) =>
    invoke<void>('ws_send_binary', bytes, { headers: { 'x-ws-id': String(id) } }),
  wsClose: (id: number, code?: number, reason?: string) => invoke<void>('ws_close', { id, code, reason }),
  keepAlive: (sessions: number) => invoke<void>('keep_alive', { sessions }),
  /** 后台提醒；tab 为点通知后要切到的会话标签 id */
  notify: (title: string, text: string, tab: string) => invoke<void>('notify', { title, text, tab }),
  /** 凭据预设的加解密（Android Keystore；其他平台报 unsupported） */
  secretEncrypt: (text: string) => invoke<string>('secret_encrypt', { text }),
  secretDecrypt: (text: string) => invoke<string>('secret_decrypt', { text }),
  /** 用浏览器登录 GitHub；失败时抛出错误代码（cancelled / not_callback / no_browser / http_xxx / network） */
  githubLoginBrowser: () => invoke<void>('github_login_browser'),
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
