/**
 * 把 electron-builder 传好的草稿 Release 改成正式发布（pnpm release:win 的最后一步）。
 *
 * electron-builder.yml 的 publish 用 releaseType: draft：先建草稿、把安装包、blockmap、latest.yml 都传完，
 * 这里核对文件齐全后再公开。直接建正式 Release 时，文件还没传完那一两分钟里“最新版本”已经指向它，
 * 客户端检查更新会因为找不到 latest.yml 报错。
 *
 *   GH_TOKEN=... node scripts/publish-release.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
const config = fs.readFileSync(path.join(root, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
const owner = /^\s*owner:\s*(\S+)/m.exec(config)?.[1];
const repo = /^\s*repo:\s*(\S+)/m.exec(config)?.[1];
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

function fail(message) {
  console.error(`[publish-release] ${message}`);
  process.exit(1);
}

if (!owner || !repo) fail('electron-builder.yml 里没有 publish.owner / publish.repo');
if (!token) fail('需要环境变量 GH_TOKEN');

async function github(method, url, body) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cloudssh-client-release',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) fail(`${method} ${url}：HTTP ${response.status} ${data?.message ?? ''}`);
  return data;
}

const tag = `v${version}`;
const releases = await github('GET', '/releases?per_page=30');
const release = releases.find((item) => item.tag_name === tag);
if (!release) fail(`没有找到 ${tag} 的 Release（electron-builder 应该已经建好草稿）`);

const installer = `CloudSSH-Setup-${version}-x64.exe`;
const required = ['latest.yml', installer, `${installer}.blockmap`];
const uploaded = new Set(release.assets.filter((asset) => asset.state === 'uploaded').map((asset) => asset.name));
const missing = required.filter((name) => !uploaded.has(name));
if (missing.length) fail(`${tag} 还缺文件：${missing.join('、')}（没有公开）`);

if (!release.draft) {
  console.log(`[publish-release] ${tag} 已经是正式发布：${release.html_url}`);
} else {
  const published = await github('PATCH', `/releases/${release.id}`, { draft: false, make_latest: 'true' });
  console.log(`[publish-release] 已公开 ${tag}：${published.html_url}`);
}
