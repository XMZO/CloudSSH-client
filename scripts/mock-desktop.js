/**
 * 在普通浏览器里模拟桌面客户端 preload 注入的桥接对象（apps/desktop/src/preload/app.ts），只为调试桌面版界面（不进安装包）：
 *   node scripts/mock-worker.mjs 8788 --ui packages/ui-web/dist --desktop-shim
 * 假 Worker 会把本文件插到 index.html 最前面。实例固定为假 Worker 本身；左下角版本号可以点：
 * 模拟检查更新 → 下载新版本（约 15 秒，带进度、大小与速度）→ 下载好后点“重启更新”只在控制台记一笔。
 * 地址带 ?update=start 时打开页面就开始模拟下载，?update=ready 时一打开就是“已下载好”。
 * 其他原生能力（实例管理、保险箱、拖出文件……）都没有。
 */
(() => {
  const instance = { id: 'mock', name: '假 Worker', baseUrl: location.origin };
  const appVersion = '0.3.36';
  const nextVersion = '0.3.37';
  const total = 121_570_142;
  const listeners = new Set();
  let status = { state: 'idle' };
  let timer = null;

  const set = (next) => {
    status = next;
    for (const listener of listeners) listener(status);
  };

  const simulate = () =>
    new Promise((resolve) => {
      set({ state: 'checking' });
      setTimeout(() => {
        set({ state: 'downloading', version: nextVersion, percent: 0 });
        resolve(status);
        const started = Date.now();
        // 和 electron-updater 一样大约每秒报一次进度，速度忽快忽慢
        timer = setInterval(() => {
          const elapsed = (Date.now() - started) / 1000;
          const transferred = Math.min(total, Math.round(total * (elapsed / 15) * (0.9 + Math.random() * 0.2)));
          if (transferred >= total) {
            clearInterval(timer);
            timer = null;
            set({ state: 'downloaded', version: nextVersion });
            return;
          }
          set({
            state: 'downloading',
            version: nextVersion,
            percent: Math.floor((transferred / total) * 100),
            transferred,
            total,
            bytesPerSecond: Math.round(transferred / elapsed),
          });
        }, 1000);
      }, 800);
    });

  window.cloudsshDesktop = {
    info: async () => ({ platform: 'win32', appVersion, instance, customChrome: false }),
    // 界面缓存（客户端里存在应用数据目录）：这里放进浏览器的 localStorage，刷新页面后还在
    uiCache: {
      read: async (key) => localStorage.getItem(`__mock_ui_cache_${key}`),
      write: async (key, value) => {
        if (value == null) localStorage.removeItem(`__mock_ui_cache_${key}`);
        else localStorage.setItem(`__mock_ui_cache_${key}`, value);
      },
    },
    update: {
      status: async () => status,
      check: async () => (status.state === 'idle' || status.state === 'not-available' || status.state === 'error' ? simulate() : status),
      install: async (confirmed) => {
        console.info('[mock-desktop] 重启更新到', status.version, confirmed ? '（界面已确认）' : '（客户端弹系统对话框）', '——模拟，不做任何事');
        return false;
      },
      onStatus: (callback) => void listeners.add(callback),
    },
  };

  const mode = new URLSearchParams(location.search).get('update');
  if (mode === 'start') setTimeout(() => void simulate(), 1500);
  if (mode === 'ready') status = { state: 'downloaded', version: nextVersion };
  window.addEventListener('pagehide', () => timer && clearInterval(timer));
})();
