/**
 * 移动端网络垫片：在网页版任何脚本之前执行（vite 以 head-prepend 注入）。
 *
 * 页面运行在 https://tauri.localhost，而 Worker 要求同源 Origin 与 HttpOnly Cookie。
 * 这里把网页版的 /api 请求与 SSH/SFTP WebSocket 改交给 Rust（apps/mobile/src-tauri/src/net.rs），
 * Rust 按实例保存 Cookie、补上 Origin，所以网页版代码与 Worker 都不用改。
 * 同时接管 blob 下载与剪贴板（WebView 自己做不到）。
 */
import { paletteCss } from './skin/palette-data';
import { applySkinAttributes, loadSkinState } from './skin/state';
import { Channel, isTauri, native, type MobileState, type WsEvent } from './tauri';

declare global {
  interface Window {
    __cloudsshMobile?: { ready: Promise<MobileState>; state: MobileState | null };
  }
}

/** 界面主题：在网页版脚本运行前写好 html 属性与配色变量，启动时不会先闪一下旧界面 */
function installSkinEarly(): void {
  const style = document.createElement('style');
  style.id = 'cs-skin-palette';
  style.textContent = paletteCss();
  document.head.append(style);
  applySkinAttributes(loadSkinState());
}

/** 不管怎样，启动这么久后都算完成（不会一直空白） */
const BOOT_TIMEOUT_MS = 8000;

/**
 * 启动首屏：网页版的 HTML 默认显示匿名连接页（#auth-section），要等登录检查（/api/auth/me）回来才换成服务器列表，
 * 已登录的实例启动时会先闪一下连接页（最近任务里的快照也常停在这一帧）。mobile.css 在启动完成（html.cs-m-booted）之前
 * 藏着连接页（等久了中间转个圈），这里决定什么时候算完成：
 * - 当前实例没登录过（或读不到状态）：马上完成，连接页照常出现
 * - 网页版决定显示什么了（服务器列表、匿名连接页、分享落地页、独立终端标签页；构建钩子调用 __cloudsshBootDone）
 * - 兜底 BOOT_TIMEOUT_MS
 */
function watchBoot(ready: Promise<MobileState>): void {
  const root = document.documentElement;
  let timer = 0;
  const finish = () => {
    window.clearTimeout(timer);
    root.classList.add('cs-m-booted');
  };
  timer = window.setTimeout(finish, BOOT_TIMEOUT_MS);
  (globalThis as { __cloudsshBootDone?: () => void }).__cloudsshBootDone = finish;
  ready.then((state) => !state.loggedIn && finish()).catch(finish);
}

function install(): void {
  document.documentElement.dataset.cloudsshClient = 'mobile';
  installSkinEarly();

  // ---------- 实例状态（异步加载，供 WebSocket 地址判断等使用） ----------
  const mobile: { ready: Promise<MobileState>; state: MobileState | null } = { ready: native.state(), state: null };
  mobile.ready.then((state) => (mobile.state = state)).catch((e) => console.error('[cloudssh] state', e));
  window.__cloudsshMobile = mobile;
  watchBoot(mobile.ready);

  const instanceHost = () => (mobile.state ? new URL(mobile.state.current.baseUrl).host : null);
  const isApiSocket = (url: URL) =>
    url.pathname.startsWith('/api/ssh') && (url.host === location.host || url.host === instanceHost());

  // 网页版 validateWsUrl 的扩展判断（见 vite.config.ts 的 MOBILE_HOOKS）
  (globalThis as Record<string, unknown>).__cloudsshIsInstanceWs = (url: URL) => isApiSocket(url);

  // ---------- fetch ----------
  const nativeFetch = window.fetch.bind(window);
  const toBase64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api')) {
      return nativeFetch(input, init);
    }
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers: [string, string][] = [];
    new Headers(init?.headers ?? request?.headers).forEach((value, name) => headers.push([name, value]));
    let body: string | null = null;
    let bodyBase64 = false;
    const rawBody = init?.body ?? (request && method !== 'GET' && method !== 'HEAD' ? await request.clone().arrayBuffer() : null);
    if (typeof rawBody === 'string') {
      body = rawBody;
    } else if (rawBody != null) {
      body = toBase64(new Uint8Array(await new Response(rawBody as BodyInit).arrayBuffer()));
      bodyBase64 = true;
    }
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await native
      .http({ method, path: url.pathname + url.search, headers, body, bodyBase64 })
      .catch((error: unknown) => {
        throw new TypeError(`Failed to fetch: ${String(error)}`);
      });
    const payload = result.base64 ? fromBase64(result.body) : result.body;
    const nullBody = result.status === 204 || result.status === 205 || result.status === 304 || method === 'HEAD';
    return new Response(nullBody ? null : payload, { status: result.status, headers: result.headers });
  };

  // ---------- WebSocket ----------
  const NativeWebSocket = window.WebSocket;

  class TauriWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    readyState = 0;
    protocol = '';
    extensions = '';
    bufferedAmount = 0;
    binaryType: BinaryType = 'blob';
    onopen: ((ev: Event) => unknown) | null = null;
    onmessage: ((ev: MessageEvent) => unknown) | null = null;
    onclose: ((ev: CloseEvent) => unknown) | null = null;
    onerror: ((ev: Event) => unknown) | null = null;
    private id: number | null = null;
    private closeRequested: { code?: number; reason?: string } | null = null;
    // Rust 在 ws_open 返回 id 之前就可能经 Channel 推送 open/消息；先缓存，拿到 id 再按序派发，
    // 否则网页版在 onopen 里立刻 send 的内容（心跳、SFTP 初始化）会因为没有 id 而丢失
    private early: (WsEvent | ArrayBuffer)[] | null = [];

    constructor(url: string, path: string) {
      super();
      this.url = url;
      const channel = new Channel<WsEvent | ArrayBuffer>();
      channel.onmessage = (message) => (this.early ? this.early.push(message) : this.handle(message));
      native
        .wsOpen(path, channel)
        .then((id) => {
          this.id = id;
          const early = this.early ?? [];
          this.early = null;
          if (this.closeRequested) {
            void native.wsClose(id, this.closeRequested.code, this.closeRequested.reason);
            return;
          }
          for (const message of early) this.handle(message);
        })
        .catch((error: unknown) => {
          this.early = null;
          console.warn('[cloudssh] websocket', error);
          this.finish(1006, String(error), false, true);
        });
    }

    private emit(event: Event): void {
      const handler = (this as unknown as Record<string, ((ev: Event) => unknown) | null>)[`on${event.type}`];
      handler?.call(this, event);
      this.dispatchEvent(event);
    }

    private handle(message: WsEvent | ArrayBuffer): void {
      if (message instanceof ArrayBuffer) {
        const data = this.binaryType === 'arraybuffer' ? message : new Blob([message]);
        this.emit(new MessageEvent('message', { data }));
        return;
      }
      switch (message.type) {
        case 'open':
          if (this.readyState !== TauriWebSocket.CONNECTING) return;
          this.readyState = TauriWebSocket.OPEN;
          this.protocol = message.protocol;
          this.emit(new Event('open'));
          break;
        case 'text':
          this.emit(new MessageEvent('message', { data: message.data }));
          break;
        case 'error':
          console.warn('[cloudssh] websocket error', this.url.replace(/token=[^&]+/, 'token=***'), message.message);
          this.emit(new Event('error'));
          break;
        case 'close':
          this.finish(message.code, message.reason, message.wasClean, false);
          break;
      }
    }

    private finish(code: number, reason: string, wasClean: boolean, error: boolean): void {
      if (this.readyState === TauriWebSocket.CLOSED) return;
      this.readyState = TauriWebSocket.CLOSED;
      if (error) this.emit(new Event('error'));
      this.emit(new CloseEvent('close', { code, reason, wasClean }));
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState === TauriWebSocket.CONNECTING) {
        throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      }
      if (this.readyState !== TauriWebSocket.OPEN || this.id === null) return;
      const id = this.id;
      // 发送失败时 Rust 侧会随即推送 error/close，这里只留诊断日志
      const warn = (error: unknown) => console.warn('[cloudssh] websocket send', error);
      if (typeof data === 'string') {
        native.wsSend(id, data).catch(warn);
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buffer) => native.wsSendBinary(id, new Uint8Array(buffer))).catch(warn);
      } else if (ArrayBuffer.isView(data)) {
        native.wsSendBinary(id, new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()).catch(warn);
      } else {
        native.wsSendBinary(id, new Uint8Array(data as ArrayBuffer).slice()).catch(warn);
      }
    }

    close(code?: number, reason?: string): void {
      if (this.readyState === TauriWebSocket.CLOSING || this.readyState === TauriWebSocket.CLOSED) return;
      this.readyState = TauriWebSocket.CLOSING;
      if (this.id === null) this.closeRequested = { code, reason };
      else void native.wsClose(this.id, code, reason);
    }
  }

  const WebSocketShim = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const target = new URL(String(url), location.href);
    if ((target.protocol === 'ws:' || target.protocol === 'wss:') && isApiSocket(target)) {
      return new TauriWebSocket(target.toString(), target.pathname + target.search);
    }
    return new NativeWebSocket(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(WebSocketShim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  WebSocketShim.prototype = NativeWebSocket.prototype;
  window.WebSocket = WebSocketShim;

  // ---------- blob 下载 → 系统“下载”目录 ----------
  const blobs = new Map<string, Blob>();
  const nativeCreate = URL.createObjectURL.bind(URL);
  const nativeRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = nativeCreate(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  // 网页版有时 click() 之后立刻 revoke：延迟释放，保证还能读到内容
  URL.revokeObjectURL = (url: string) => {
    setTimeout(() => {
      blobs.delete(url);
      nativeRevoke(url);
    }, 60_000);
  };

  async function save(blob: Blob, filename: string): Promise<void> {
    const name = await native.saveDownload(filename || 'download', blob.type, new Uint8Array(await blob.arrayBuffer()));
    window.dispatchEvent(new CustomEvent('cloudssh:downloaded', { detail: { name } }));
  }

  function interceptDownload(anchor: HTMLAnchorElement): boolean {
    if (!anchor.hasAttribute('download')) return false;
    const href = anchor.href;
    const filename = anchor.getAttribute('download') || '';
    if (!href.startsWith('blob:') && !href.startsWith('data:')) return false;
    const blob = blobs.get(href);
    const source = blob ? Promise.resolve(blob) : nativeFetch(href).then((r) => r.blob());
    source
      .then((b) => save(b, filename))
      .catch((error: unknown) => window.dispatchEvent(new CustomEvent('cloudssh:download-failed', { detail: String(error) })));
    return true;
  }

  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (interceptDownload(this)) return;
    nativeClick.call(this);
  };
  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[download]') : null;
      if (anchor && interceptDownload(anchor)) event.preventDefault();
    },
    true
  );

  // ---------- 剪贴板 ----------
  const clipboard = {
    readText: () => native.clipboardRead(),
    writeText: (text: string) => native.clipboardWrite(String(text ?? '')),
  };
  try {
    if (navigator.clipboard) {
      Object.assign(navigator.clipboard, clipboard);
    } else {
      Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    }
  } catch {
    // 只读环境保持原样
  }
}

if (isTauri()) install();
// 不在客户端里（浏览器直接打开手机版构建）：没有登录状态可判断，连接页照常显示
else document.documentElement.classList.add('cs-m-booted');
