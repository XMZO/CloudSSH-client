import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const upstreamFrontend = path.join(packageDir, 'upstream', 'frontend');
const overridesEntry = path.join(packageDir, 'overrides', 'index.ts');
const sourceInfoPath = path.join(packageDir, 'upstream', 'SOURCE.json');

/**
 * 在不修改 upstream 源码的前提下注入桌面端定制（overrides/index.ts）。
 * 想改样式/行为时优先在 overrides 里做，upstream 保持与 CloudSSH 主仓库逐字节一致。
 */
const OVERRIDES_ID = '/@cloudssh/overrides.ts';

function desktopOverrides(): Plugin {
  return {
    name: 'cloudssh-desktop-overrides',
    resolveId(id) {
      return id === OVERRIDES_ID ? overridesEntry : null;
    },
    transformIndexHtml: {
      // pre：让注入的脚本与上游入口一样参与打包
      order: 'pre',
      handler() {
        if (!fs.existsSync(overridesEntry)) return [];
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src: OVERRIDES_ID },
            injectTo: 'body',
          },
        ];
      },
    },
  };
}

/**
 * 桌面端扩展钩子：构建时（不改 upstream 文件）在两处构造函数里登记实例，
 * 供 overrides（如左侧节点侧栏）调用网页版自身的连接/编辑/切换标签逻辑。
 *   globalThis.__cloudsshServerList  —— ServerList（connectServer / showModal / servers）
 *   globalThis.__cloudsshTabManager  —— TabManager（tabs / switchTab / getActiveTab）
 * 锚点找不到时只告警不失败：侧栏会自动降级（不显示或提示）。
 */
const DESKTOP_HOOKS: { file: string; anchor: string; inject: string }[] = [
  {
    file: '/upstream/frontend/src/server-list.ts',
    anchor: '    this.onConnect = onConnect;\n',
    inject:
      "    (globalThis as any).__cloudsshServerList = this;\n    globalThis.dispatchEvent?.(new CustomEvent('cloudssh:server-list'));\n",
  },
  {
    file: '/upstream/frontend/src/tab-manager.ts',
    anchor: '  constructor(tabBarId: string, terminalAreaId: string) {\n',
    inject: '    (globalThis as any).__cloudsshTabManager = this;\n',
  },
];

function desktopHooks(): Plugin {
  return {
    name: 'cloudssh-desktop-hooks',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      const hook = DESKTOP_HOOKS.find((item) => normalized.endsWith(item.file));
      if (!hook) return null;
      const source = code.replace(/\r\n/g, '\n');
      if (!source.includes(hook.anchor)) {
        this.warn(`桌面钩子锚点未找到（上游代码可能已变化）：${hook.file}`);
        return null;
      }
      return { code: source.replace(hook.anchor, hook.anchor + hook.inject), map: null };
    },
  };
}

/** 构建产物附带 UI 清单，桌面端据此展示内置 UI 的来源版本 */
function uiManifest(): Plugin {
  return {
    name: 'cloudssh-ui-manifest',
    apply: 'build',
    generateBundle() {
      const source = fs.existsSync(sourceInfoPath)
        ? JSON.parse(fs.readFileSync(sourceInfoPath, 'utf8'))
        : null;
      this.emitFile({
        type: 'asset',
        fileName: 'cloudssh-ui.json',
        source: JSON.stringify(
          {
            id: 'web',
            name: 'CloudSSH Web UI',
            entry: 'index.html',
            upstreamVersion: source?.version ?? null,
            upstreamCommit: source?.commit ?? null,
            builtAt: new Date().toISOString(),
          },
          null,
          2
        ),
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: upstreamFrontend,
  // 与上游 vite.config.ts 保持一致：xterm 6 预压缩 ESM 再做语法压缩会破坏 DECRQM 处理
  // https://github.com/xtermjs/xterm.js/issues/5800
  esbuild: {
    minifySyntax: false,
  },
  plugins: [desktopHooks(), desktopOverrides(), uiManifest()],
  server: {
    // 显式用 IPv4 回环：部分 Windows 环境 localhost 只解析/监听到 ::1，Electron 侧会连不上
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: [packageDir],
    },
    // 页面运行在 Worker origin 下（由桌面端 origin bridge 转发到本服务），
    // HMR WebSocket 必须显式指回本地开发服务器，否则会连到 Worker。
    hmr: {
      protocol: 'ws',
      host: '127.0.0.1',
      port: 5173,
      clientPort: 5173,
    },
  },
  build: {
    outDir: path.join(packageDir, 'dist'),
    emptyOutDir: true,
    modulePreload: {
      polyfill: false,
    },
    // 桌面端本地读取文件，无需像 Worker 那样内联；保留多文件产物便于缓存与调试
    sourcemap: command === 'build' ? false : true,
  },
}));
