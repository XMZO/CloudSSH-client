/**
 * 平台传输抽象。core 不依赖 DOM / Node / Electron，任何平台注入自己的实现即可：
 *
 * - 浏览器 / Electron 渲染进程（页面位于 Worker origin）：直接用全局 fetch / WebSocket，
 *   浏览器自动附带同源 Origin 与 HttpOnly Cookie，什么都不用做。
 * - Electron 主进程：`session.fetch`（共享该实例分区的 Cookie 罐）。
 * - React Native / 原生移动端：fetch 需手动加 `Cookie: session=...`，
 *   WebSocket 需在握手头里带 `Origin`（见 routes.webSocketHandshakeHeaders）。
 */

/** 与 WHATWG fetch 兼容的最小签名 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 最小 WebSocket 接口（浏览器 WebSocket、ws、RN WebSocket 都满足） */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WebSocketFactory {
  /**
   * @param url 完整 ws/wss 地址
   * @param headers 原生平台需要附带的握手头（Origin / Cookie）。浏览器实现应忽略它。
   */
  create(url: string, headers: Record<string, string>): WebSocketLike;
}

/** 会话凭据存储（原生平台用；浏览器环境由 Cookie 罐自动管理，可不提供） */
export interface SessionStore {
  get(): Promise<string | null>;
  set(token: string | null): Promise<void>;
}

export interface PlatformTransport {
  fetch: FetchLike;
  webSocket?: WebSocketFactory;
  /**
   * 为 true 时，API 客户端会显式加 `Origin` 头（原生平台需要；浏览器禁止手动设置该头）。
   */
  sendOriginHeader?: boolean;
  session?: SessionStore;
}
