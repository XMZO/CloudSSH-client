#!/usr/bin/env node
/**
 * Android（Tauri 2）构建辅助：自动定位 JDK / Android SDK / NDK，按 HTTPS_PROXY 给 Gradle 配代理，
 * 构建后把 APK 复制到 apps/mobile/release/。
 *
 *   pnpm android:build           # release APK（arm64，手机用）
 *   pnpm android:build:debug     # debug APK（arm64 + x86_64，含模拟器）
 *   pnpm android:install         # adb 安装最近一次构建的 APK（需已连接设备或启动模拟器）
 *   pnpm android:dev             # tauri android dev（热更新，需已连接设备）
 *   node scripts/mobile.mjs build --target aarch64 armv7   # 透传额外参数给 tauri android build
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersionInfo, versionProblems } from './version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = path.join(repoRoot, 'apps', 'mobile');
const androidDir = path.join(mobileDir, 'src-tauri', 'gen', 'android');
const releaseDir = path.join(mobileDir, 'release');
const isWin = process.platform === 'win32';

const exists = (p) => Boolean(p) && fs.existsSync(p);

function findJavaHome() {
  const candidates = [
    process.env.CLOUDSSH_ANDROID_JAVA_HOME,
    // Android Studio 自带的 JBR（JDK 21）最省心；系统 JDK 过新时 AGP 可能不支持
    isWin ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : null,
    process.platform === 'darwin' ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home' : null,
    path.join(os.homedir(), 'android-studio', 'jbr'),
    process.env.JAVA_HOME,
  ];
  return candidates.find((dir) => exists(dir) && exists(path.join(dir, 'bin', isWin ? 'java.exe' : 'java')));
}

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : null,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : null,
    path.join(os.homedir(), 'Android', 'Sdk'),
  ];
  return candidates.find((dir) => exists(dir) && exists(path.join(dir, 'platforms')));
}

function findNdk(sdk) {
  if (exists(process.env.NDK_HOME)) return process.env.NDK_HOME;
  const root = path.join(sdk, 'ndk');
  if (!exists(root)) return null;
  const versions = fs
    .readdirSync(root)
    .filter((name) => /^\d+\./.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions.length ? path.join(root, versions[0]) : null;
}

/** Gradle 守护进程不读 HTTPS_PROXY：用 JAVA_TOOL_OPTIONS 把代理传给所有 JVM（含 wrapper 与 daemon） */
function gradleProxyOptions() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const noProxy = (process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1')
      .split(',')
      .map((item) => item.trim().replace(/^\./, '*.'))
      .filter(Boolean)
      .join('|');
    return [
      `-Dhttp.proxyHost=${url.hostname}`,
      `-Dhttp.proxyPort=${port}`,
      `-Dhttps.proxyHost=${url.hostname}`,
      `-Dhttps.proxyPort=${port}`,
      `-Dhttp.nonProxyHosts=${noProxy}`,
    ].join(' ');
  } catch {
    return null;
  }
}

function run(command, args, env) {
  console.log(`[mobile] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: mobileDir, stdio: 'inherit', env, shell: isWin });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** 复制本次构建类型（debug/release）的 APK，避免把上次留下的另一种包也当成新产物 */
function copyApks(version, buildType) {
  const outputs = path.join(androidDir, 'app', 'build', 'outputs', 'apk');
  if (!exists(outputs)) return [];
  const copied = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.apk')) {
        // app-universal-release.apk → CloudSSH-0.1.0-release.apk
        const type = /-(debug|release)(-unsigned)?\.apk$/.exec(entry.name)?.[1] ?? 'build';
        if (type !== buildType) continue;
        const target = path.join(releaseDir, `CloudSSH-${version}-${type}.apk`);
        fs.mkdirSync(releaseDir, { recursive: true });
        fs.copyFileSync(full, target);
        copied.push({ target, mtime: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(outputs);
  return copied;
}

const javaHome = findJavaHome();
const sdk = findSdk();
const ndk = sdk ? findNdk(sdk) : null;
if (!javaHome) {
  console.error('[mobile] 找不到 JDK 17+：安装 Android Studio，或设置 CLOUDSSH_ANDROID_JAVA_HOME / JAVA_HOME');
  process.exit(1);
}
if (!sdk) {
  console.error('[mobile] 找不到 Android SDK：安装 Android Studio，或设置 ANDROID_HOME');
  process.exit(1);
}
if (!ndk) {
  console.error('[mobile] 找不到 Android NDK：在 Android Studio 的 SDK Manager 安装 NDK (Side by side)，或设置 NDK_HOME');
  process.exit(1);
}

const proxy = gradleProxyOptions();
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdk,
  NDK_HOME: ndk,
  ...(proxy ? { JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, proxy].filter(Boolean).join(' ') } : {}),
};
console.log(`[mobile] JAVA_HOME=${javaHome}`);
console.log(`[mobile] ANDROID_HOME=${sdk}`);
console.log(`[mobile] NDK_HOME=${ndk}`);

const [command = 'build', ...rest] = process.argv.slice(2);
// 版本号以 version.json 为准；打包前确认 Cargo.toml / tauri.conf.json 等已同步，避免装出版本号对不上的 APK
const { version } = readVersionInfo();
if (command === 'build') {
  const problems = versionProblems();
  if (problems.length) {
    console.error(`[mobile] 版本号不一致，先运行 node scripts/version.mjs sync：\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}
const tauri = ['exec', 'tauri', 'android'];

switch (command) {
  case 'build': {
    const debug = rest.includes('--debug');
    const extra = rest.filter((arg) => arg !== '--debug');
    const targets = extra.includes('--target') ? [] : ['--target', 'aarch64', ...(debug ? ['x86_64'] : [])];
    // Gradle 的 debug 构建会在旧 APK 上增量打包：替换掉的动态库空间不回收，每重建一次 APK 就大一圈。
    // 先删掉上次的输出，强制全新打包
    fs.rmSync(path.join(androidDir, 'app', 'build', 'outputs', 'apk'), { recursive: true, force: true });
    run('pnpm', [...tauri, 'build', '--apk', ...(debug ? ['--debug'] : []), ...targets, ...extra], env);
    const apks = copyApks(version, debug ? 'debug' : 'release');
    for (const apk of apks) {
      const size = (fs.statSync(apk.target).size / 1024 / 1024).toFixed(1);
      console.log(`[mobile] APK → ${path.relative(repoRoot, apk.target)}（${size} MB）`);
    }
    break;
  }
  case 'install': {
    const candidates = fs.existsSync(releaseDir)
      ? fs
          .readdirSync(releaseDir)
          .filter((name) => name.endsWith('.apk'))
          .map((name) => path.join(releaseDir, name))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      : [];
    if (!candidates.length) {
      console.error('[mobile] 还没有 APK，先运行 pnpm android:build');
      process.exit(1);
    }
    const adb = path.join(sdk, 'platform-tools', isWin ? 'adb.exe' : 'adb');
    run(adb, ['install', '-r', candidates[0], ...rest], env);
    break;
  }
  case 'dev':
    run('pnpm', [...tauri, 'dev', ...rest], env);
    break;
  default:
    run('pnpm', [...tauri, command, ...rest], env);
}
