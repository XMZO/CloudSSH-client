import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const upstreamFrontend = path.join(packageDir, 'upstream', 'frontend');
const sourceInfoPath = path.join(packageDir, 'upstream', 'SOURCE.json');

/**
 * 构建目标：
 *   desktop（默认）——Electron 内置 UI：overrides/index.ts（左侧节点侧栏等）
 *   mobile（--mode mobile）——Tauri 移动端：
 *     overrides/mobile/early.ts 最先执行（网络垫片：/api 与 WebSocket 改由 Rust 发出；
 *       网页版入口一加载就会请求，所以必须排在它前面）
 *     overrides/mobile/index.ts 在网页版之后执行（节点分组首页、保活、下载、设置……）
 */
type Target = 'desktop' | 'mobile';

interface Injection {
  id: string;
  file: string;
  injectTo: 'head-prepend' | 'body';
}

function injectionsFor(target: Target): Injection[] {
  if (target === 'mobile') {
    return [
      {
        id: '/@cloudssh/mobile-early.ts',
        file: path.join(packageDir, 'overrides', 'mobile', 'early.ts'),
        injectTo: 'head-prepend',
      },
      {
        id: '/@cloudssh/mobile.ts',
        file: path.join(packageDir, 'overrides', 'mobile', 'index.ts'),
        injectTo: 'body',
      },
    ];
  }
  return [
    { id: '/@cloudssh/overrides.ts', file: path.join(packageDir, 'overrides', 'index.ts'), injectTo: 'body' },
  ];
}

/**
 * 在不修改 upstream 源码的前提下注入定制脚本。
 * 想改样式/行为时优先在 overrides 里做，upstream 保持与 CloudSSH 主仓库逐字节一致。
 */
function overrides(target: Target): Plugin {
  const injections = injectionsFor(target);
  return {
    name: 'cloudssh-overrides',
    resolveId(id) {
      return injections.find((item) => item.id === id)?.file ?? null;
    },
    transformIndexHtml: {
      // pre：让注入的脚本与上游入口一样参与打包（同一个入口里按文档顺序执行）
      order: 'pre',
      handler() {
        return injections
          .filter((item) => fs.existsSync(item.file))
          .map((item) => ({
            tag: 'script',
            attrs: { type: 'module', src: item.id },
            injectTo: item.injectTo,
          }));
      },
    },
  };
}

interface Hook {
  file: string;
  anchor: string;
  inject: string;
}

/**
 * 扩展钩子：构建时（不改 upstream 文件）在两处构造函数里登记实例，
 * 供 overrides（桌面侧栏、移动端节点首页）调用网页版自身的连接/编辑/切换标签逻辑。
 *   globalThis.__cloudsshServerList  —— ServerList（connectServer / showModal / servers）
 *   globalThis.__cloudsshTabManager  —— TabManager（tabs / switchTab / getActiveTab）
 * 锚点找不到时只告警不失败：相关功能会自动降级。
 */
const COMMON_HOOKS: Hook[] = [
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

/**
 * 移动端额外钩子：页面运行在 tauri.localhost，网页版 validateWsUrl 只认页面同源，
 * 这里让它同时认可当前实例的 WebSocket 地址（判断函数由 overrides/mobile/early.ts 提供）。
 */
const MOBILE_HOOKS: Hook[] = [
  {
    file: '/upstream/frontend/src/main.ts',
    anchor: '      url.origin === window.location.origin ||\n',
    inject: '      (globalThis as any).__cloudsshIsInstanceWs?.(url) === true ||\n',
  },
];

function extensionHooks(target: Target): Plugin {
  const hooks = target === 'mobile' ? [...COMMON_HOOKS, ...MOBILE_HOOKS] : COMMON_HOOKS;
  return {
    name: 'cloudssh-extension-hooks',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      const matched = hooks.filter((item) => normalized.endsWith(item.file));
      if (!matched.length) return null;
      let source = code.replace(/\r\n/g, '\n');
      for (const hook of matched) {
        if (!source.includes(hook.anchor)) {
          this.warn(`扩展钩子锚点未找到（上游代码可能已变化）：${hook.file}`);
          continue;
        }
        source = source.replace(hook.anchor, hook.anchor + hook.inject);
      }
      return { code: source, map: null };
    },
  };
}

/** 构建产物附带 UI 清单，客户端据此展示内置 UI 的来源版本 */
function uiManifest(target: Target): Plugin {
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
            target,
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

export default defineConfig(({ command, mode }) => {
  const target: Target = mode === 'mobile' ? 'mobile' : 'desktop';
  const port = target === 'mobile' ? 5174 : 5173;
  return {
    root: upstreamFrontend,
    // 与上游 vite.config.ts 保持一致：xterm 6 预压缩 ESM 再做语法压缩会破坏 DECRQM 处理
    // https://github.com/xtermjs/xterm.js/issues/5800
    esbuild: {
      minifySyntax: false,
    },
    plugins: [extensionHooks(target), overrides(target), uiManifest(target)],
    server: {
      // 显式用 IPv4 回环：部分 Windows 环境 localhost 只解析/监听到 ::1
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: {
        allow: [packageDir, path.resolve(packageDir, '..', '..', 'node_modules')],
      },
      // 桌面端页面运行在 Worker origin 下（由 origin bridge 转发到本服务），
      // HMR WebSocket 必须显式指回本地开发服务器，否则会连到 Worker。
      hmr: {
        protocol: 'ws',
        host: '127.0.0.1',
        port,
        clientPort: port,
      },
    },
    build: {
      outDir: path.join(packageDir, target === 'mobile' ? 'dist-mobile' : 'dist'),
      emptyOutDir: true,
      modulePreload: {
        polyfill: false,
      },
      // 客户端本地读取文件，无需像 Worker 那样内联；保留多文件产物便于缓存与调试
      sourcemap: command === 'build' ? false : true,
    },
  };
});
