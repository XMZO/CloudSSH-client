/**
 * 构建命令行：esbuild 打成单个 dist/cloudssh.mjs（Node 22 起，零依赖；桌面客户端的 Electron 也能直接运行它）。
 *
 * 后台会话、SFTP、服务器之间传文件直接复用客户端 AI 跨服务器操作的代码（packages/ui-web/overrides/shared/ai-remote），
 * 它们在浏览器里从侧栏数据源（sidebar/store，模块加载时要用 window）取服务器列表，这里换成命令行自己的 store-shim。
 * skill 说明（skill/SKILL.md）以文本打进产物，cloudssh install 时写到 ~/.claude/skills/cloudssh。
 * 桌面端构建（apps/desktop/build.mjs）会先调这里的 buildCli，再把产物打进安装包的 resources/cli/。
 *
 *   node build.mjs
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export const CLI_OUTFILE = path.join(root, 'dist', 'cloudssh.mjs');

/** 把对侧栏数据源的引用换成命令行的 store-shim */
const sidebarStore = {
  name: 'sidebar-store',
  setup(build) {
    const shim = path.join(root, 'src', 'store-shim.ts');
    build.onResolve({ filter: /sidebar[\\/]store$/ }, () => ({ path: shim }));
  },
};

export async function buildCli({ logLevel = 'info' } = {}) {
  await build({
    entryPoints: [path.join(root, 'src', 'main.ts')],
    outfile: CLI_OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: false,
    legalComments: 'none',
    logLevel,
    loader: { '.md': 'text' },
    banner: { js: '#!/usr/bin/env node' },
    plugins: [sidebarStore],
  });
  return CLI_OUTFILE;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await buildCli();
