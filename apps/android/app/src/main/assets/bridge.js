/*
 * CloudSSH Android 桥接脚本：在页面任何脚本之前注入，且只注入到当前实例 origin（GitHub 等页面拿不到）。
 * 原生侧通过 addWebMessageListener 注入 window.__cloudsshAndroidPort，这里在其上封装：
 *   - window.cloudsshAndroid：info() / openInstanceManager()（与桌面端 window.cloudsshDesktop 对应）
 *   - blob:/data: 下载 → 分块交给原生写入系统“下载”目录（WebView 原生无法下载 blob）
 *   - navigator.clipboard.readText/writeText → 原生剪贴板（WebView 默认禁止读取）
 * 改这里不需要动网页版代码；网页版升级后这些行为依然生效。
 */
(() => {
  'use strict';
  if (window.cloudsshAndroid) return;
  const port = window.__cloudsshAndroidPort;
  if (!port) return;

  document.documentElement.dataset.cloudsshClient = 'android';

  // ---------- 请求/应答 ----------
  let seq = 0;
  const pending = new Map();
  port.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'native error'));
  };
  const call = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      port.postMessage(JSON.stringify({ ...payload, id, type }));
    });

  // ---------- 系统返回键 ----------
  // 由原生在返回键时同步调用：关闭最上层浮层并返回 true；没有可关闭的浮层返回 false（交给 WebView 历史/原生菜单）。
  // 复用网页版自己的 Escape 处理，不直接改它的内部状态。
  const pressEscape = (target) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  const isShown = (el) => {
    if (!el || el.classList.contains('hidden')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left < innerWidth - 4 && rect.right > 4;
  };
  function handleBack() {
    const dialog = [...document.querySelectorAll('dialog[open]')].pop();
    if (dialog) {
      pressEscape(dialog);
      if (dialog.open) dialog.close();
      return true;
    }
    const modal = [...document.querySelectorAll('.responsive-modal, [role="dialog"]')].filter(isShown).pop();
    if (modal) {
      pressEscape(modal);
      return true;
    }
    const moreMenu = document.getElementById('mobile-more-menu');
    if (isShown(moreMenu)) {
      document.querySelector('[aria-controls="mobile-more-menu"]')?.click();
      return true;
    }
    for (const id of ['snippet-panel', 'agent-panel', 'sftp-panel']) {
      const panel = document.getElementById(id);
      if (isShown(panel)) {
        pressEscape(panel);
        return true;
      }
    }
    return false;
  }

  window.cloudsshAndroid = Object.freeze({
    info: () => call('info'),
    openInstanceManager: () => call('open-manager'),
    handleBack,
  });

  // ---------- 下载 ----------
  const CHUNK = 512 * 1024;
  const blobs = new Map();
  const nativeCreate = URL.createObjectURL.bind(URL);
  const nativeRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj) => {
    const url = nativeCreate(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  // 网页版有时 click() 之后立刻 revoke：这里延迟释放，保证还能读到内容
  URL.revokeObjectURL = (url) => {
    setTimeout(() => {
      blobs.delete(url);
      nativeRevoke(url);
    }, 60_000);
  };

  const toBase64 = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };

  async function saveBlob(blob, filename) {
    const name = filename || 'download';
    const id = await call('download-begin', { name, mime: blob.type || 'application/octet-stream', size: blob.size });
    try {
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
        await call('download-chunk', { download: id, data: toBase64(bytes) });
      }
      await call('download-end', { download: id });
    } catch (error) {
      call('download-abort', { download: id }).catch(() => undefined);
      throw error;
    }
  }

  function interceptDownload(anchor) {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.hasAttribute('download')) return false;
    const href = anchor.href;
    const filename = anchor.getAttribute('download') || '';
    if (href.startsWith('blob:')) {
      const blob = blobs.get(href);
      const source = blob ? Promise.resolve(blob) : fetch(href).then((r) => r.blob());
      source.then((b) => saveBlob(b, filename)).catch((e) => console.error('[cloudssh-android] download failed', e));
      return true;
    }
    if (href.startsWith('data:')) {
      fetch(href)
        .then((r) => r.blob())
        .then((b) => saveBlob(b, filename))
        .catch((e) => console.error('[cloudssh-android] download failed', e));
      return true;
    }
    return false;
  }

  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {
    if (interceptDownload(this)) return;
    return nativeClick.call(this);
  };
  // 用户直接点击的 <a download>（不经过 .click()）
  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[download]') : null;
      if (anchor && interceptDownload(anchor)) event.preventDefault();
    },
    true
  );

  // ---------- 剪贴板 ----------
  const clipboard = navigator.clipboard;
  const readText = () => call('clipboard-read');
  const writeText = (text) => call('clipboard-write', { text: String(text ?? '') });
  if (clipboard) {
    try {
      clipboard.readText = readText;
      clipboard.writeText = writeText;
    } catch {
      // 只读环境下保持原样
    }
  } else {
    Object.defineProperty(navigator, 'clipboard', { value: { readText, writeText }, configurable: true });
  }
})();
