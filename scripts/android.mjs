#!/usr/bin/env node
/**
 * Android 构建辅助：自动定位 JDK / Android SDK，写 local.properties，按 HTTPS_PROXY 配好 Gradle 代理，
 * 构建后把 APK 复制到 apps/android/release/。
 *
 *   pnpm android:build      # assembleDebug
 *   pnpm android:release    # assembleRelease（无 keystore.properties 时用 debug 证书签名）
 *   pnpm android:install    # installDebug（需已连接设备或启动模拟器）
 *   pnpm android:test       # 单元测试
 *   node scripts/android.mjs <任意 gradle 任务...>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(repoRoot, 'apps', 'android');
const isWin = process.platform === 'win32';

function exists(p) {
  return p && fs.existsSync(p);
}

function findJavaHome() {
  const candidates = [
    process.env.CLOUDSSH_ANDROID_JAVA_HOME,
    // Android Studio 自带的 JBR（JDK 21）最省心；系统 JDK 过新（如 25）时 AGP 可能不支持
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

function proxyArgs() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return [];
  try {
    const url = new URL(raw);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const args = [];
    for (const scheme of ['http', 'https']) {
      args.push(`-D${scheme}.proxyHost=${url.hostname}`, `-D${scheme}.proxyPort=${port}`);
    }
    const noProxy = (process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1')
      .split(',')
      .map((item) => item.trim().replace(/^\./, '*.'))
      .filter(Boolean)
      .join('|');
    args.push(`-Dhttp.nonProxyHosts=${noProxy}`);
    return args;
  } catch {
    return [];
  }
}

const javaHome = findJavaHome();
const sdk = findSdk();
if (!javaHome) {
  console.error('[android] 找不到 JDK 17+：安装 Android Studio，或设置 CLOUDSSH_ANDROID_JAVA_HOME / JAVA_HOME');
  process.exit(1);
}
if (!sdk) {
  console.error('[android] 找不到 Android SDK：安装 Android Studio，或设置 ANDROID_HOME');
  process.exit(1);
}

const localProps = path.join(androidDir, 'local.properties');
const sdkLine = `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}`;
if (!exists(localProps) || !fs.readFileSync(localProps, 'utf8').includes('sdk.dir=')) {
  fs.writeFileSync(localProps, `# 由 scripts/android.mjs 生成，不要提交\n${sdkLine}\n`);
}

const aliases = {
  build: ['assembleDebug'],
  release: ['assembleRelease'],
  install: ['installDebug'],
  test: ['testDebugUnitTest'],
};
const userArgs = process.argv.slice(2);
const tasks = userArgs.length ? userArgs.flatMap((arg) => aliases[arg] ?? [arg]) : aliases.build;

const gradlew = path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');
console.log(`[android] JAVA_HOME=${javaHome}`);
console.log(`[android] SDK=${sdk}`);
console.log(`[android] gradle ${tasks.join(' ')}`);
// Windows 需经 cmd 运行 gradlew.bat：给含 | & < > 等字符的参数加引号，避免被当成管道/重定向
const quote = (arg) => (/[\s|&<>^]/.test(arg) ? `"${arg}"` : arg);
const gradleArgs = [...proxyArgs(), ...tasks];
const spawnOptions = {
  cwd: androidDir,
  stdio: 'inherit',
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk },
};
const result = isWin
  ? spawnSync([quote(gradlew), ...gradleArgs.map(quote)].join(' '), { ...spawnOptions, shell: true })
  : spawnSync(gradlew, gradleArgs, spawnOptions);
if (result.status !== 0) process.exit(result.status ?? 1);

// 复制 APK 到 apps/android/release/
const outputs = path.join(androidDir, 'app', 'build', 'outputs', 'apk');
const releaseDir = path.join(androidDir, 'release');
if (exists(outputs)) {
  const apks = [];
  for (const type of fs.readdirSync(outputs)) {
    const dir = path.join(outputs, type);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) if (file.endsWith('.apk')) apks.push({ type, file: path.join(dir, file) });
  }
  if (apks.length) {
    fs.mkdirSync(releaseDir, { recursive: true });
    const gradleFile = fs.readFileSync(path.join(androidDir, 'app', 'build.gradle.kts'), 'utf8');
    const version = /versionName\s*=\s*"([^"]+)"/.exec(gradleFile)?.[1] ?? '0.0.0';
    for (const { type, file } of apks) {
      const target = path.join(releaseDir, `CloudSSH-${version}-${type}.apk`);
      fs.copyFileSync(file, target);
      console.log(`[android] APK → ${path.relative(repoRoot, target)}`);
    }
  }
}
