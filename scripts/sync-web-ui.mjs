#!/usr/bin/env node
/**
 * 把 CloudSSH 主仓库的网页版前端同步到 packages/ui-web/upstream（只读源仓库，绝不修改它）。
 *
 * 用法：
 *   pnpm sync:web-ui                       # 默认源仓库 ../CloudSSH
 *   pnpm sync:web-ui -- --source D:/CloudSSH
 *   CLOUDSSH_REPO=D:/CloudSSH pnpm sync:web-ui
 *
 * 同步内容：
 *   - frontend/（排除 node_modules、dist）→ upstream/frontend/
 *   - frontend 通过 ../../src/*.ts 引用的共享 Schema 文件（递归解析）→ upstream/src/
 *   - 依赖版本：按源仓库 pnpm-lock.yaml 中 frontend 的确切版本改写 packages/ui-web/package.json，
 *     保证内置 UI 与 Worker 内联的前端用同一套依赖构建
 *   - upstream/SOURCE.json：记录源仓库提交、版本与同步时间
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiPackageDir = path.join(repoRoot, 'packages', 'ui-web');
const upstreamDir = path.join(uiPackageDir, 'upstream');

function parseArgs(argv) {
  const args = { source: process.env.CLOUDSSH_REPO || path.resolve(repoRoot, '..', 'CloudSSH') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source' && argv[i + 1]) args.source = path.resolve(argv[++i]);
  }
  return args;
}

const { source } = parseArgs(process.argv.slice(2));
const sourceFrontend = path.join(source, 'frontend');
if (!fs.existsSync(path.join(sourceFrontend, 'package.json'))) {
  console.error(`[sync-web-ui] 找不到 ${sourceFrontend}/package.json，请用 --source 指定 CloudSSH 仓库路径`);
  process.exit(1);
}

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.vite']);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 找出 frontend 依赖的、位于 frontend 目录之外的源文件（递归） */
function collectSharedFiles() {
  const shared = new Set();
  const queue = listTsFiles(path.join(sourceFrontend, 'src'));
  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.shift();
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(IMPORT_RE)) {
      const resolved = resolveModule(file, match[1] || match[2]);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      const rel = path.relative(source, resolved);
      if (!rel.startsWith(`frontend${path.sep}`)) {
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`frontend 引用了仓库之外的文件：${resolved}`);
        }
        shared.add(rel.split(path.sep).join('/'));
      }
      queue.push(resolved);
    }
  }
  return [...shared].sort();
}

/** 从 pnpm-lock.yaml 读取 frontend importer 的确切依赖版本 */
function readLockedFrontendVersions() {
  const lockPath = path.join(source, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) return null;
  const lines = fs.readFileSync(lockPath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line === '  frontend:');
  if (start < 0) return null;
  const result = { dependencies: {}, devDependencies: {} };
  let section = null;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break; // 下一个 importer / 顶级块
    const sectionMatch = /^ {4}(dependencies|devDependencies|optionalDependencies):$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] === 'optionalDependencies' ? null : sectionMatch[1];
      continue;
    }
    const nameMatch = /^ {6}'?([^':]+)'?:$/.exec(line);
    if (nameMatch) {
      current = nameMatch[1];
      continue;
    }
    const versionMatch = /^ {8}version: (\S+)$/.exec(line);
    if (versionMatch && section && current) {
      result[section][current] = versionMatch[1].replace(/\(.*$/, '');
    }
  }
  return result;
}

function gitInfo() {
  const run = (...args) => {
    try {
      return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: run('rev-parse', 'HEAD'),
    describe: run('log', '-1', '--format=%h %s'),
    remote: run('config', '--get', 'remote.origin.url'),
    dirty: Boolean(run('status', '--porcelain', '--', 'frontend', 'src')),
  };
}

// ---------- 执行 ----------

console.log(`[sync-web-ui] 源仓库：${source}`);
fs.rmSync(upstreamDir, { recursive: true, force: true });
copyDir(sourceFrontend, path.join(upstreamDir, 'frontend'));
// Apache-2.0：保留上游许可与署名（NOTICE 要求再分发时保留）
for (const file of ['LICENSE', 'NOTICE']) {
  if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(upstreamDir, file));
}

const sharedFiles = collectSharedFiles();
for (const rel of sharedFiles) {
  const dst = path.join(upstreamDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(source, rel), dst);
}
console.log(`[sync-web-ui] 共享文件 ${sharedFiles.length} 个：${sharedFiles.join(', ')}`);

const frontendPkg = JSON.parse(fs.readFileSync(path.join(sourceFrontend, 'package.json'), 'utf8'));
const uiPkgPath = path.join(uiPackageDir, 'package.json');
const uiPkg = JSON.parse(fs.readFileSync(uiPkgPath, 'utf8'));
const locked = readLockedFrontendVersions();
const changes = [];
for (const section of ['dependencies', 'devDependencies']) {
  const next = {};
  for (const [name, range] of Object.entries(frontendPkg[section] ?? {})) {
    const exact = locked?.[section]?.[name] ?? range;
    next[name] = exact;
    if (uiPkg[section]?.[name] !== exact) changes.push(`${section}.${name}: ${uiPkg[section]?.[name] ?? '(无)'} → ${exact}`);
  }
  for (const [name, range] of Object.entries(uiPkg[section] ?? {})) {
    if (name in next) continue;
    // 客户端自己的 workspace 依赖（如 @cloudssh/core，供 overrides 使用）不属于上游，保留
    if (String(range).startsWith('workspace:')) next[name] = range;
    else changes.push(`${section}.${name}: 已从上游移除`);
  }
  uiPkg[section] = next;
}
uiPkg.version = frontendPkg.version;
fs.writeFileSync(uiPkgPath, `${JSON.stringify(uiPkg, null, 2)}\n`);

const git = gitInfo();
const sourceInfo = {
  version: frontendPkg.version,
  commit: git.commit,
  describe: git.describe,
  remote: git.remote,
  dirty: git.dirty,
  syncedAt: new Date().toISOString(),
  sharedFiles,
};
fs.writeFileSync(path.join(upstreamDir, 'SOURCE.json'), `${JSON.stringify(sourceInfo, null, 2)}\n`);
fs.writeFileSync(
  path.join(upstreamDir, 'README.md'),
  '# upstream（自动生成，请勿手改）\n\n' +
    '本目录由 `pnpm sync:web-ui` 从 CloudSSH 主仓库复制而来，内容与上游逐字节一致，便于 diff 与重新同步。\n' +
    '定制界面请改 `packages/ui-web/overrides/` 或新建自己的 UI 包，不要直接修改这里。\n'
);

console.log(`[sync-web-ui] 已同步 v${frontendPkg.version} @ ${git.describe ?? '(非 git 仓库)'}${git.dirty ? '（源仓库有未提交改动）' : ''}`);
if (changes.length) {
  console.log('[sync-web-ui] 依赖版本有变化，请运行 pnpm install：');
  for (const change of changes) console.log(`  - ${change}`);
}
