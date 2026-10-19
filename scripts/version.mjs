#!/usr/bin/env node
/**
 * 客户端版本号与版本代号：唯一来源是仓库根目录的 version.json，本脚本负责同步到各处——
 *   - package.json：根目录、apps/desktop（安装包版本）、apps/mobile、packages/core
 *   - apps/mobile/src-tauri：Cargo.toml、Cargo.lock、tauri.conf.json
 *     （Android versionName 取这里的版本；versionCode 由 Tauri 按 主×1000000 + 次×1000 + 修订 推导，0.2.0 → 2000）
 *   - packages/core/src/version.ts：生成文件，桌面端与手机端界面据此显示版本和代号
 * packages/ui-web 的版本跟随上游 CloudSSH 网页版，不在此列。
 *
 *   node scripts/version.mjs                          查看当前版本并检查各处是否一致（同 check）
 *   node scripts/version.mjs check                    检查各处是否一致，不一致时退出码为 1
 *   node scripts/version.mjs sync                     按 version.json 改写各处
 *   node scripts/version.mjs set 0.3.0 牛郎 Altair    修改版本号和代号并同步（省略代号则沿用当前代号）
 *   node scripts/version.mjs set 0.1.1 --force        允许改成更低的版本号（Android 无法覆盖安装更低的 versionCode）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = path.join(root, 'version.json');
const TAURI_DIR = path.join(root, 'apps', 'mobile', 'src-tauri');
const GENERATED_TS = path.join(root, 'packages', 'core', 'src', 'version.ts');

const PACKAGE_JSONS = ['package.json', 'apps/desktop/package.json', 'apps/mobile/package.json', 'packages/core/package.json', 'packages/cli/package.json'];

/** 只接受 x.y.z：次版本号与修订号小于 1000、主版本号小于 2000，保证 Android versionCode 单调且不溢出 */
export function parseVersion(text) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major >= 2000 || minor >= 1000 || patch >= 1000) return null;
  return { major, minor, patch, code: major * 1_000_000 + minor * 1000 + patch };
}

function validCodename(text) {
  return typeof text === 'string' && text.trim() === text && text.length > 0 && text.length <= 32 && !/[\n\r"'`\\]/.test(text);
}

export function readVersionInfo() {
  const info = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  if (!parseVersion(info.version)) throw new Error(`version.json 的 version 不是有效的 x.y.z：${info.version}`);
  if (!validCodename(info.codename?.zh) || !validCodename(info.codename?.en)) {
    throw new Error('version.json 的 codename 需要 zh 与 en 两个非空代号（不含引号、反斜杠与换行）');
  }
  return info;
}

// ---------- 各处版本号的读取与改写（只改版本那一行，保留原有格式） ----------

const JSON_VERSION = /^( {2}"version":\s*")([^"]*)(")/m;

function jsonTarget(relative) {
  const file = path.join(root, relative);
  return {
    label: relative,
    file,
    read: (text) => JSON_VERSION.exec(text)?.[2] ?? null,
    write: (text, version) => text.replace(JSON_VERSION, `$1${version}$3`),
  };
}

/** Cargo.toml 的 [package] 段 */
function packageSection(text) {
  const start = text.search(/^\[package\]\s*$/m);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/^\[/m);
  const end = next < 0 ? text.length : start + 1 + next;
  return { start, end };
}

const TOML_VERSION = /^(version\s*=\s*")([^"]*)(")/m;

const cargoToml = {
  label: 'apps/mobile/src-tauri/Cargo.toml',
  file: path.join(TAURI_DIR, 'Cargo.toml'),
  read(text) {
    const section = packageSection(text);
    return section ? TOML_VERSION.exec(text.slice(section.start, section.end))?.[2] ?? null : null;
  },
  write(text, version) {
    const section = packageSection(text);
    if (!section) return text;
    const body = text.slice(section.start, section.end).replace(TOML_VERSION, `$1${version}$3`);
    return text.slice(0, section.start) + body + text.slice(section.end);
  },
};

function crateName() {
  const text = fs.readFileSync(cargoToml.file, 'utf8');
  const section = packageSection(text);
  return section ? /^name\s*=\s*"([^"]+)"/m.exec(text.slice(section.start, section.end))?.[1] ?? null : null;
}

function lockEntry(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = ")([^"]*)(")`);
}

const cargoLock = {
  label: 'apps/mobile/src-tauri/Cargo.lock',
  file: path.join(TAURI_DIR, 'Cargo.lock'),
  read(text) {
    const name = crateName();
    return name ? lockEntry(name).exec(text)?.[2] ?? null : null;
  },
  write(text, version) {
    const name = crateName();
    return name ? text.replace(lockEntry(name), `$1${version}$3`) : text;
  },
};

const TARGETS = [...PACKAGE_JSONS.map(jsonTarget), cargoToml, cargoLock, jsonTarget('apps/mobile/src-tauri/tauri.conf.json')];

/** 单引号字符串字面量（版本号与代号都已校验过，不含引号、反斜杠和换行） */
const quote = (text) => `'${text}'`;

function generatedSource(info) {
  return [
    '// 由 scripts/version.mjs 根据仓库根目录的 version.json 生成，请勿手改（改版本请运行 node scripts/version.mjs set）。',
    '',
    '/** 客户端版本号：与桌面安装包、Android versionName 一致 */',
    `export const CLIENT_VERSION = ${quote(info.version)};`,
    '',
    '/** 版本代号（中文 / 英文） */',
    `export const CLIENT_CODENAME = { zh: ${quote(info.codename.zh)}, en: ${quote(info.codename.en)} } as const;`,
    '',
  ].join('\n');
}

/** 返回与 version.json 不一致的地方；空数组表示全部一致 */
export function versionProblems(info = readVersionInfo()) {
  const problems = [];
  for (const target of TARGETS) {
    if (!fs.existsSync(target.file)) {
      problems.push(`${target.label}：文件不存在`);
      continue;
    }
    const current = target.read(fs.readFileSync(target.file, 'utf8'));
    if (current !== info.version) problems.push(`${target.label}：${current ?? '未找到版本号'}（应为 ${info.version}）`);
  }
  const generated = fs.existsSync(GENERATED_TS) ? fs.readFileSync(GENERATED_TS, 'utf8') : null;
  if (generated !== generatedSource(info)) problems.push('packages/core/src/version.ts：与 version.json 不一致（需要重新生成）');
  return problems;
}

function syncAll(info) {
  // 先全部算好、确认每个文件都找得到版本号字段，再统一写入，避免改到一半失败留下不一致的状态
  const writes = TARGETS.map((target) => {
    const text = fs.readFileSync(target.file, 'utf8');
    if (target.read(text) === null) throw new Error(`${target.label}：找不到版本号字段，未修改任何文件，请先手动检查该文件`);
    return { label: target.label, file: target.file, text, next: target.write(text, info.version) };
  });
  const source = generatedSource(info);
  const generated = fs.existsSync(GENERATED_TS) ? fs.readFileSync(GENERATED_TS, 'utf8') : null;
  writes.push({ label: 'packages/core/src/version.ts', file: GENERATED_TS, text: generated, next: source });

  const changed = [];
  for (const write of writes) {
    if (write.next === write.text) continue;
    fs.writeFileSync(write.file, write.next);
    changed.push(write.label);
  }
  return changed;
}

function describe(info) {
  const { code } = parseVersion(info.version);
  return `v${info.version}「${info.codename.zh} ${info.codename.en}」（Android versionCode ${code}）`;
}

function main(argv) {
  const [command = 'check', ...args] = argv;
  switch (command) {
    case 'check': {
      const info = readVersionInfo();
      const problems = versionProblems(info);
      console.log(`[version] 当前版本 ${describe(info)}`);
      if (problems.length) {
        console.error(`[version] 以下位置与 version.json 不一致，运行 node scripts/version.mjs sync 修正：\n  - ${problems.join('\n  - ')}`);
        return 1;
      }
      console.log('[version] 各处版本号一致');
      return 0;
    }
    case 'sync': {
      const info = readVersionInfo();
      const changed = syncAll(info);
      console.log(`[version] ${describe(info)}：${changed.length ? `已更新 ${changed.join('、')}` : '各处已是最新'}`);
      return 0;
    }
    case 'set': {
      const force = args.includes('--force');
      const [version, zh, en] = args.filter((arg) => arg !== '--force');
      const next = parseVersion(version);
      if (!next) {
        console.error('[version] 用法：node scripts/version.mjs set <x.y.z> [中文代号 英文代号] [--force]（次版本号、修订号需小于 1000）');
        return 1;
      }
      if ((zh === undefined) !== (en === undefined)) {
        console.error('[version] 代号需要同时给出中文和英文，例如：set 0.3.0 牛郎 Altair');
        return 1;
      }
      const info = readVersionInfo();
      const previous = parseVersion(info.version);
      if (next.code < previous.code && !force) {
        console.error(`[version] ${version} 低于当前的 ${info.version}：Android 无法覆盖安装更低的版本。确实要改请加 --force`);
        return 1;
      }
      const codename = zh === undefined ? info.codename : { zh, en };
      if (!validCodename(codename.zh) || !validCodename(codename.en)) {
        console.error('[version] 代号不能为空，且不能包含引号、反斜杠或换行');
        return 1;
      }
      const updated = { ...info, version: next.major + '.' + next.minor + '.' + next.patch, codename };
      fs.writeFileSync(VERSION_FILE, `${JSON.stringify(updated, null, 2)}\n`);
      const changed = syncAll(updated);
      console.log(`[version] 已改为 ${describe(updated)}，更新了 version.json${changed.length ? `、${changed.join('、')}` : ''}`);
      console.log('[version] 记得在 CHANGELOG.md 顶部补上这一版的更新内容');
      return 0;
    }
    default:
      console.error(`[version] 未知命令：${command}（可用：check / sync / set）`);
      return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[version] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
