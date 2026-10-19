/**
 * 在普通浏览器里模拟 Tauri 2 的 IPC，只为调试手机版界面（不进安装包）：
 *   node scripts/mock-worker.mjs 8788 --ui <手机版构建目录> --mobile-shim
 * 假 Worker 会把本文件插到 index.html 最前面，于是手机版的网络垫片（overrides/mobile/early.ts）认为自己在 Tauri 里，
 * 把 /api 请求与 SSH/SFTP WebSocket 交给这里，这里再直接发给假 Worker。实例固定为假 Worker 本身、已登录。
 * 原生能力（通知、保活、电池、下载保存……）都只回空值。
 */
(() => {
  // 手机版的网络垫片随后会换掉 fetch 与 WebSocket（转给“原生”，也就是这里）：先留住浏览器自己的
  const browserFetch = window.fetch.bind(window);
  const BrowserWebSocket = window.WebSocket;
  const origin = location.origin;
  const callbacks = new Map();
  let nextCallback = 1;
  const sockets = new Map();
  let nextSocket = 1;

  const instance = { id: 'mock', name: '假 Worker', baseUrl: origin };
  const appState = { instances: [instance], currentId: instance.id, current: instance, proxy: null, loggedIn: true, appVersion: 'dev', platform: 'android' };

  const toBase64 = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  /** 按 Tauri Channel 的协议（{index, message}）往页面推消息 */
  const pusher = (channel) => {
    let index = 0;
    return (message) => callbacks.get(channel.id)?.({ index: index++, message });
  };

  const handlers = {
    app_state: () => appState,
    test_instance: () => ({ latencyMs: 1, authMode: 'github', loginRequired: false, oauthRedirectUri: null }),
    async http_request({ request }) {
      const body = request.body == null ? undefined : request.bodyBase64 ? fromBase64(request.body) : request.body;
      const response = await browserFetch(request.path, { method: request.method, headers: request.headers, body });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = response.headers.get('content-type') || '';
      const text = !bytes.length || /json|text|javascript|xml/.test(type);
      return { status: response.status, headers: [...response.headers], body: text ? new TextDecoder().decode(bytes) : toBase64(bytes), base64: !text };
    },
    ws_open({ path, onEvent }) {
      const id = nextSocket++;
      const push = pusher(onEvent);
      const ws = new BrowserWebSocket(origin.replace(/^http/, 'ws') + path);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => push({ type: 'open', protocol: ws.protocol });
      ws.onmessage = (event) => push(typeof event.data === 'string' ? { type: 'text', data: event.data } : event.data);
      ws.onerror = () => push({ type: 'error', message: 'websocket error' });
      ws.onclose = (event) => {
        sockets.delete(id);
        push({ type: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean });
      };
      sockets.set(id, ws);
      return id;
    },
    ws_send: ({ id, text }) => sockets.get(id)?.send(text),
    ws_close: ({ id, code, reason }) => sockets.get(id)?.close(code ?? 1000, reason),
    clipboard_read: () => navigator.clipboard?.readText?.().catch(() => '') ?? '',
    clipboard_write: ({ text }) => navigator.clipboard?.writeText?.(text).catch(() => {}),
    open_external: ({ url }) => void window.open(url, '_blank', 'noopener'),
    battery_status: () => null,
    storage_info: () => null,
  };

  window.__TAURI_INTERNALS__ = {
    async invoke(cmd, args, options) {
      // 二进制参数的命令：参数本身就是字节，附加信息在请求头里
      if (cmd === 'ws_send_binary') return sockets.get(Number(options?.headers?.['x-ws-id']))?.send(args);
      if (cmd === 'save_download') return 'mock-download';
      const handler = handlers[cmd];
      if (handler) return handler(args ?? {}, options);
      // 插件（返回键、事件监听等）与其余原生命令：回空值
      return cmd.startsWith('plugin:') ? 0 : null;
    },
    transformCallback(callback, once = false) {
      const id = nextCallback++;
      callbacks.set(id, (value) => {
        if (once) callbacks.delete(id);
        callback?.(value);
      });
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) => path,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    plugins: {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
