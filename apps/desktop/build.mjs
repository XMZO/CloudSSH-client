/**
 * 构建桌面端：主进程 / preload / 实例管理页面，全部用 esbuild 打成单文件。
 * @cloudssh/core 以源码形式被打进产物，所以安装包不需要 node_modules。
 *
 *   node build.mjs           构建一次
 *   node build.mjs --watch   监听修改（改主进程后需重启 electron）
 */
import { context, build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCli } from '../../packages/cli/build.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production';

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: false,
  logLevel: 'info',
  legalComments: 'none',
};

const targets = [
  {
    ...common,
    entryPoints: { 'main/index': path.join(root, 'src/main/index.ts') },
    outdir: out,
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: {
      'preload/app': path.join(root, 'src/preload/app.ts'),
      'preload/manager': path.join(root, 'src/preload/manager.ts'),
    },
    outdir: out,
    outExtension: { '.js': '.cjs' },
    // 沙箱 preload 只能 require('electron')，必须打成单个 CommonJS 文件
    platform: 'node',
    format: 'cjs',
    target: 'chrome140',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: { 'manager/main': path.join(root, 'src/manager/main.ts') },
    outdir: out,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
  },
];

function copyStatic() {
  const dir = path.join(out, 'manager');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['index.html', 'style.css']) {
    fs.copyFileSync(path.join(root, 'src/manager', file), path.join(dir, file));
  }
}

fs.rmSync(out, { recursive: true, force: true });
// 命令行 cloudssh：打进安装包的 resources/cli/（electron-builder.yml extraResources），实例管理里一键安装
await buildCli({ logLevel: 'warning' });

if (watch) {
  for (const options of targets) {
    const ctx = await context(options);
    await ctx.watch();
  }
  copyStatic();
  fs.watch(path.join(root, 'src/manager'), (_event, file) => {
    if (file === 'index.html' || file === 'style.css') copyStatic();
  });
  console.log('[desktop] 监听中…');
} else {
  await Promise.all(targets.map((options) => build(options)));
  copyStatic();
}
