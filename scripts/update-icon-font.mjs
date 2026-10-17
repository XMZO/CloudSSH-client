#!/usr/bin/env node
/**
 * 生成内置的 Material Symbols 图标字体子集（packages/ui-web/overrides/fonts/）。
 *
 * 网页版从 Google Fonts 在线加载整套图标字体；客户端改为打包本地子集：离线、或 Google Fonts 访问不畅时
 * 图标也不会退化成 “close”“search” 这样的文字，体积也只有用到的图标。
 *
 * 做法：扫描网页版与 overrides 源码里出现的图标名（字符串字面量、material-symbols-outlined 元素内容），
 * 与官方图标名单取交集，再向 Google Fonts 请求只含这些图标的子集（轴与网页版一致：wght 100..700、FILL 0..1）。
 * 同步网页版（pnpm sync:web-ui）后如有新图标，重新运行：pnpm update:icon-font
 * 需要能访问 Google Fonts；有代理时设置 HTTPS_PROXY（curl 会自动使用）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(repoRoot, 'packages', 'ui-web');
const outDir = path.join(uiRoot, 'overrides', 'fonts');
const CODEPOINTS_URL =
  'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsOutlined%5BFILL,GRAD,opsz,wght%5D.codepoints';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** 运行时拼出来、扫描不到的图标名，手动补上 */
const EXTRA_ICONS = [];

function curl(url, binary = false) {
  return execFileSync('curl', ['-sSL', '--fail', '--max-time', '120', '-A', CHROME_UA, url], {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(ts|html)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

const known = new Set(
  curl(CODEPOINTS_URL)
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter(Boolean)
);
console.log(`[icons] 官方图标名单 ${known.size} 个`);

const sources = [
  ...walk(path.join(uiRoot, 'upstream', 'frontend', 'src')),
  path.join(uiRoot, 'upstream', 'frontend', 'index.html'),
  // 前后端共享的 schema（移动端快捷键预设的图标等）
  ...walk(path.join(uiRoot, 'upstream', 'src')),
  ...walk(path.join(uiRoot, 'overrides')),
];
const used = new Set(EXTRA_ICONS);
for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8');
  // 整个字符串字面量就是图标名：'close'、"search"、`add`
  for (const match of text.matchAll(/(['"`])([a-z0-9_]+)\1/g)) if (known.has(match[2])) used.add(match[2]);
  // material-symbols-outlined 元素的文本：<span class="material-symbols-outlined ...">close</span>
  for (const match of text.matchAll(/material-symbols-outlined[^>]*>\s*([a-z0-9_]+)\s*</g)) if (known.has(match[1])) used.add(match[1]);
}
const names = [...used].sort();
console.log(`[icons] 源码中用到 ${names.length} 个图标`);

const css = curl(
  `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&icon_names=${names.join(',')}&display=block`
);
const fontUrl = /url\((https:[^)]+)\)/.exec(css)?.[1];
if (!fontUrl) throw new Error(`Google Fonts 返回的 CSS 里没有字体地址：\n${css}`);
const font = curl(fontUrl, true);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'material-symbols-outlined.woff2'), font);

const localCss = `/* 由 scripts/update-icon-font.mjs 生成，勿手改。${names.length} 个图标：Material Symbols Outlined 子集（Apache-2.0） */
${css.replace(/url\(https:[^)]+\)/, "url('./material-symbols-outlined.woff2')").trim()}
`;
fs.writeFileSync(path.join(outDir, 'material-symbols.css'), localCss);
fs.writeFileSync(path.join(outDir, 'icons.txt'), `${names.join('\n')}\n`);
console.log(`[icons] 已写入 ${path.relative(repoRoot, outDir)}（字体 ${(font.length / 1024).toFixed(0)} KB）`);
