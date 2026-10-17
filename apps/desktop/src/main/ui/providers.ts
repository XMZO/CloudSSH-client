/**
 * 可替换的 UI 层：把实例配置里的 UiSource 解析成 origin bridge 能直接使用的形式。
 *
 * 不管 UI 从哪里来，页面最终都加载在 Worker 的 origin 下（https://<worker>/），
 * 所以 UI 只需要是“一个以 index.html 为入口、用相对 /api 访问后端的静态站点”。
 *
 * 查找顺序（bundled）：
 *   1. 环境变量 CLOUDSSH_UI_DIR（开发调试用，覆盖所有实例）
 *   2. 安装包内 resources/ui/<id>/
 *   3. 开发模式下工作区 packages/ui-<id>/dist/
 */
import { describeUiSource, type UiSource } from '@cloudssh/core';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';

const log = createLogger('ui');

export interface UiManifest {
  id?: string;
  name?: string;
  entry?: string;
  upstreamVersion?: string | null;
  upstreamCommit?: string | null;
  /** 界面自己画标题栏的协议版本（≥1 时窗口去掉系统边框，见 windows.ts） */
  desktopChrome?: number;
  builtAt?: string;
}

export type ResolvedUi =
  | { kind: 'remote'; label: string }
  | { kind: 'static'; root: string; label: string; manifest: UiManifest | null }
  | { kind: 'proxy'; target: string; label: string };

export interface BundledUiInfo {
  id: string;
  root: string;
  manifest: UiManifest | null;
}

function workspaceRoot(): string {
  // 开发模式下 app.getAppPath() = apps/desktop
  return path.resolve(app.getAppPath(), '..', '..');
}

function bundledCandidates(id: string): string[] {
  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'ui', id));
  } else {
    candidates.push(path.join(workspaceRoot(), 'packages', `ui-${id}`, 'dist'));
  }
  return candidates;
}

function readManifest(root: string): UiManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'cloudssh-ui.json'), 'utf8')) as UiManifest;
  } catch {
    return null;
  }
}

function hasEntry(root: string): boolean {
  return fs.existsSync(path.join(root, 'index.html'));
}

export function findBundledUi(id: string): BundledUiInfo | null {
  for (const root of bundledCandidates(id)) {
    if (hasEntry(root)) return { id, root, manifest: readManifest(root) };
  }
  return null;
}

/** 列出可用的内置 UI 包（供实例管理器展示） */
export function listBundledUis(): BundledUiInfo[] {
  const results: BundledUiInfo[] = [];
  const parents = app.isPackaged
    ? [path.join(process.resourcesPath, 'ui')]
    : [path.join(workspaceRoot(), 'packages')];
  for (const parent of parents) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = app.isPackaged ? entry.name : entry.name.replace(/^ui-/, '');
      if (!app.isPackaged && !entry.name.startsWith('ui-')) continue;
      const found = findBundledUi(id);
      if (found) results.push(found);
    }
  }
  return results;
}

export interface ResolveResult {
  ui: ResolvedUi;
  /** 解析时发生了回退（例如内置 UI 未构建），需要提示用户 */
  warning?: string;
}

export function resolveUi(source: UiSource): ResolveResult {
  const devServer = process.env.CLOUDSSH_UI_DEV_SERVER;
  if (devServer && source.kind !== 'remote') {
    return { ui: { kind: 'proxy', target: devServer.replace(/\/$/, ''), label: `开发服务器（${devServer}）` } };
  }
  const dirOverride = process.env.CLOUDSSH_UI_DIR;
  if (dirOverride && source.kind !== 'remote') {
    const root = path.resolve(dirOverride);
    if (hasEntry(root)) {
      return { ui: { kind: 'static', root, label: `本地目录（${root}）`, manifest: readManifest(root) } };
    }
    log.warn('CLOUDSSH_UI_DIR 下没有 index.html，忽略：', root);
  }

  switch (source.kind) {
    case 'remote':
      return { ui: { kind: 'remote', label: describeUiSource(source) } };
    case 'dev-server':
      return { ui: { kind: 'proxy', target: source.url, label: describeUiSource(source) } };
    case 'directory': {
      const root = path.resolve(source.path);
      if (hasEntry(root)) {
        return { ui: { kind: 'static', root, label: describeUiSource(source), manifest: readManifest(root) } };
      }
      return {
        ui: { kind: 'remote', label: '跟随 Worker（回退）' },
        warning: `UI 目录 ${root} 中没有 index.html，已临时改用 Worker 自带页面。`,
      };
    }
    case 'bundled': {
      const id = source.id ?? 'web';
      const found = findBundledUi(id);
      if (found) {
        return { ui: { kind: 'static', root: found.root, label: describeUiSource(source), manifest: found.manifest } };
      }
      return {
        ui: { kind: 'remote', label: '跟随 Worker（回退）' },
        warning: app.isPackaged
          ? `安装包内缺少内置 UI「${id}」，已临时改用 Worker 自带页面。`
          : `内置 UI「${id}」尚未构建（先运行 pnpm build:ui），已临时改用 Worker 自带页面。`,
      };
    }
  }
}
