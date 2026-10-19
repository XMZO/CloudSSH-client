/**
 * 安装、卸载与状态：把 cloudssh 装成命令，并装上 skill（Claude Code、Codex 等支持 Agent Skills 的工具）。
 * - 程序：默认复制到 %LOCALAPPDATA%\cloudssh-cli\cloudssh.mjs（其他系统 ~/.local/share/cloudssh/cloudssh.mjs）；
 *   --in-place 不复制、直接指向正在运行的这个文件（桌面客户端用：指向安装包里的 resources/cli/cloudssh.mjs，
 *   客户端更新时命令跟着更新）
 * - 运行时：当前这个 node；在桌面客户端里运行时（Electron 当 Node 用）是 CloudSSH.exe，启动脚本带上
 *   ELECTRON_RUN_AS_NODE=1，不需要另装 Node
 * - 命令：在 ~/.local/bin（可用 --bin-dir 换）写 cloudssh、cssh：Windows 上是启动器 .exe + 同名 .shim 配置
 *   （PowerShell / cmd 用，见 packages/cli/shim）和不带扩展名的 sh 脚本（Git Bash 用）。不用 .cmd：PowerShell 调
 *   批处理时不转义参数里的双引号，带引号的命令会被拆开；找不到启动器时才退回 .cmd。
 *   这些文件里都有 cloudssh-shim 标记，卸载时只删带标记的
 * - skill（--no-skill 不装）：SKILL.md 是通用的 Agent Skills 格式（name + description 的 frontmatter），装到
 *   ~/.claude/skills/cloudssh（Claude Code，总装）、~/.codex/skills/cloudssh（Codex，装了 Codex 才装）、
 *   ~/.agents/skills/cloudssh（多个工具共用的目录，有这个目录才装）。其他 agent 只要能执行命令，cloudssh 一样能用。
 *   config.json 的 skills 可以单独关掉某个 agent（关掉的会删掉）；完全权限、默认超时与给 AI 的补充说明会写进 skill，
 *   改了设置后 cloudssh skill sync 重写一遍（桌面客户端改设置时自动做）
 * - MCP（--mcp claude-desktop,codex 之类，用户明确要求才登记）：把 cloudssh mcp 写进这些应用的 MCP 配置（mcp-clients.ts），
 *   指向与命令相同的程序与运行时；重新安装时更新已登记的，卸载时移除
 */
import { CLIENT_VERSION } from '@cloudssh/core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import skillText from '../skill/SKILL.md';
import { homeDir, loadConfig, type CliConfig } from './config';
import { launchFor, mcpTargets, parseMcpClients, refreshMcp, registerMcp, unregisterMcp, type McpClientTarget, type McpLaunch } from './mcp-clients';

const MARK = 'cloudssh-shim';
const NAMES = ['cloudssh', 'cssh'];
const windows = process.platform === 'win32';
/** Windows 启动器：构建时放在程序旁边（dist/、安装包的 resources/cli/），复制安装时一起复制 */
const LAUNCHER = 'cloudssh-shim.exe';

export type Launcher = 'exe' | 'cmd' | 'sh';

export interface InstallOptions {
  binDir?: string;
  skill: boolean;
  /** 不复制程序，命令直接指向正在运行的这个文件 */
  inPlace?: boolean;
  /** 同时把 MCP 服务器登记给这些应用（claude-desktop,codex,… 或 all）；不给就只更新已经登记过的 */
  mcp?: string;
}

export interface InstallStatus {
  /** 命令脚本在不在 */
  installed: boolean;
  /** 命令指向的程序与运行时（读脚本得到）；不存在时 exists 为 false */
  program: string | null;
  runtime: string | null;
  exists: boolean;
  /** 运行时是 CloudSSH 客户端（Electron 当 Node 用） */
  appRuntime: boolean;
  /** 命令的启动方式：Windows 上 exe 是现在的，cmd 是旧版装的（重新安装即换成 exe） */
  launcher: Launcher | null;
  binDir: string;
  onPath: boolean;
  /** Claude Code 的 skill 装了没有 */
  skill: boolean;
  /** 所有装了的 skill 都与这个版本内置的一致 */
  skillCurrent: boolean;
  skillPath: string;
  /** 各个 agent 的 skill（这台电脑上有的） */
  skills: SkillTarget[];
  /** 各个 MCP 客户端的登记状态 */
  mcp: McpClientTarget[];
  version: string;
}

export interface SkillTarget {
  id: string;
  name: string;
  path: string;
  /** 设置里开着（没设置过的算开） */
  enabled: boolean;
  installed: boolean;
  /** 装着的与按现在设置生成的一致 */
  current: boolean;
}

/**
 * 写给 AI 的用户设置与补充说明（skill 与 MCP 的 instructions 共用）；yes 是“确认危险操作”在那边的写法
 * （skill 是 `--yes`，MCP 是 `confirm: true`）
 */
export function userGuidance(config: CliConfig, yes = '`--yes`'): string {
  const settings: string[] = [];
  if (config.confirm === 'never') {
    settings.push(
      `- Full access is on: risky commands run without ${yes} and \`copy\` overwrites without asking. Still tell the user before deleting data, stopping services or rebooting. Catastrophic commands are still refused.`
    );
  }
  if (config.timeout !== 60) settings.push(`- The default timeout is ${config.timeout} s.`);
  if (config.concurrency !== 6) settings.push(`- Batch commands run on up to ${config.concurrency} servers at a time.`);
  const aliases = Object.entries(config.aliases);
  if (aliases.length) settings.push(`- Aliases: ${aliases.map(([name, target]) => `\`${name}\` → \`${target}\``).join(', ')}.`);
  let text = '';
  if (settings.length) text += `\n## The user's settings\n\n${settings.join('\n')}\n`;
  const notes = config.skillNotes.trim();
  if (notes) text += `\n## Notes from the user\n\nFollow these unless they conflict with the rules above:\n\n${notes}\n`;
  return text;
}

/** 按设置生成的 skill：内置说明 + 用户的设置（完全权限、默认超时）+ 给 AI 的补充说明 */
export function skillContent(config: CliConfig = loadConfig()): string {
  return skillText + userGuidance(config);
}

/** 支持 Agent Skills 的工具：Claude Code 总装，其他的要这台电脑上有它的目录 */
const AGENTS = [
  { id: 'claude', name: 'Claude Code', home: '.claude', always: true },
  { id: 'codex', name: 'Codex', home: '.codex', always: false },
  { id: 'agents', name: '通用目录 ~/.agents', home: '.agents', always: false },
] as const;

function skillFile(home: string): string {
  return path.join(os.homedir(), home, 'skills', 'cloudssh', 'SKILL.md');
}

export function skillPath(): string {
  return skillFile('.claude');
}

function readSkill(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 这台电脑上能装 skill 的 agent（以及已经装过的） */
export function skillTargets(config: CliConfig = loadConfig()): SkillTarget[] {
  const content = skillContent(config);
  return AGENTS.flatMap((agent) => {
    const file = skillFile(agent.home);
    const text = readSkill(file);
    if (!agent.always && text === null && !fs.existsSync(path.join(os.homedir(), agent.home))) return [];
    const enabled = config.skills[agent.id] !== false;
    return [{ id: agent.id, name: agent.name, path: file, enabled, installed: text !== null, current: text === content }];
  });
}

const ours = (file: string) => /^name:\s*cloudssh\s*$/m.test(readSkill(file) ?? '');

/** 按设置装上开着的、删掉关掉的（只删我们装的） */
export function syncSkills(config: CliConfig = loadConfig()): string[] {
  const content = skillContent(config);
  const lines: string[] = [];
  for (const target of skillTargets(config)) {
    if (target.enabled) {
      if (target.current) continue;
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      fs.writeFileSync(target.path, content, 'utf8');
      lines.push(`${target.name} skill：${target.path}`);
    } else if (target.installed && ours(target.path)) {
      fs.rmSync(path.dirname(target.path), { recursive: true, force: true });
      lines.push(`已删除 ${target.name} skill（设置里关掉了）`);
    }
  }
  return lines;
}

function defaultBinDir(binDir?: string): string {
  return path.resolve(binDir ?? path.join(os.homedir(), '.local', 'bin'));
}

function copyDir(): string {
  return windows
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'cloudssh-cli')
    : path.join(os.homedir(), '.local', 'share', 'cloudssh');
}

function onPath(dir: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((item) => item && path.resolve(item).toLowerCase() === dir.toLowerCase());
}

/** 装上所有开着的 skill（已经是最新的也重写一遍） */
export function installSkills(): string[] {
  const config = loadConfig();
  const content = skillContent(config);
  return skillTargets(config).flatMap((target) => {
    if (!target.enabled) return [];
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, content, 'utf8');
    return [`${target.name} skill：${target.path}`];
  });
}

/** 程序旁边的 Windows 启动器（dist/、安装包的 resources/cli/、复制安装的目录）；没有就是 null */
function launcherNextTo(program: string): string | null {
  const file = path.join(path.dirname(program), LAUNCHER);
  return fs.existsSync(file) ? file : null;
}

/**
 * 放启动器：内容一样就不动。正在运行的 exe 不能覆盖（经 cloudssh.exe 运行 cloudssh install 时就是这样），
 * 但能改名：挪成 .old-时间 再写新的，旧的下次安装或卸载时删
 */
function placeLauncher(source: string, target: string): void {
  const bytes = fs.readFileSync(source);
  try {
    if (fs.readFileSync(target).equals(bytes)) return;
  } catch {
    // 还没有
  }
  try {
    fs.writeFileSync(target, bytes);
  } catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    fs.renameSync(target, `${target}.old-${Date.now()}`);
    fs.writeFileSync(target, bytes);
  }
}

/** 挪开的旧启动器（cloudssh.exe.old-时间）：删得掉就删 */
function staleLaunchers(binDir: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(binDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^c(loud)?ssh\.exe\.old-\d+$/i.test(name))
    .map((name) => path.join(binDir, name))
    .filter(isOurs);
}

function removeStaleLaunchers(binDir: string): void {
  for (const file of staleLaunchers(binDir)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 还在运行，下次再删
    }
  }
}

/**
 * 正在用的启动脚本或启动器（经 .cmd 运行时 cmd 还要接着读那个文件；经 .exe 运行时它被锁着）：退出后再删。
 * 启动器的作业允许子进程脱离，这个 cmd 不会随它一起被结束
 */
function deleteAfterExit(files: string[]): void {
  if (!files.length) return;
  // 原样传给 cmd（不让 Node 转义引号）：命令行以 ping 开头，cmd /c 不会去掉路径两边的引号
  const list = files.map((file) => `"${file}"`).join(' ');
  spawn('cmd.exe', ['/d', '/c', `ping -n 2 127.0.0.1 >nul & del /f /q ${list}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
}

export function install(options: InstallOptions): string[] {
  const lines: string[] = [];
  // 先认客户端名字：写错了什么都不装
  const mcpClients = options.mcp ? parseMcpClients(options.mcp) : [];
  const self = fileURLToPath(import.meta.url);
  const launcher = windows ? launcherNextTo(self) : null;
  let program = self;
  if (!options.inPlace) {
    program = path.join(copyDir(), 'cloudssh.mjs');
    fs.mkdirSync(path.dirname(program), { recursive: true });
    if (path.resolve(self) !== path.resolve(program)) {
      fs.copyFileSync(self, program);
      // 启动器也放一份：以后从这份程序重新安装（cloudssh install）时还找得到
      if (launcher) fs.copyFileSync(launcher, path.join(path.dirname(program), LAUNCHER));
    }
  }
  lines.push(`程序：${program}`);

  const binDir = defaultBinDir(options.binDir);
  fs.mkdirSync(binDir, { recursive: true });
  removeStaleLaunchers(binDir);
  const runtime = process.execPath;
  const electron = !!process.versions.electron;
  const posix = (value: string) => (windows ? value.replace(/\\/g, '/') : value);
  const deferred: string[] = [];
  for (const name of NAMES) {
    // Git Bash（MSYS）调用 Windows 程序时会把 /tmp/x 这类参数改写成 Windows 路径，远程路径会被改坏：关掉
    // （本机路径由命令行自己用 cygpath 换）
    const env = [
      ...(windows ? ['export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"'] : []),
      ...(electron ? ['export ELECTRON_RUN_AS_NODE=1'] : []),
    ];
    fs.writeFileSync(
      path.join(binDir, name),
      `#!/bin/sh\n# ${MARK} ${CLIENT_VERSION}\n${env.map((line) => `${line}\n`).join('')}exec "${posix(runtime)}" "${posix(program)}" "$@"\n`,
      { mode: 0o755 }
    );
    if (windows && launcher) {
      fs.writeFileSync(
        path.join(binDir, `${name}.shim`),
        `# ${MARK} ${CLIENT_VERSION}\r\nruntime=${runtime}\r\nprogram=${program}\r\n${electron ? 'env=ELECTRON_RUN_AS_NODE=1\r\n' : ''}`
      );
      placeLauncher(launcher, path.join(binDir, `${name}.exe`));
      // 旧版装的 .cmd 删掉（.exe 在 PATHEXT 里排在前面，留着也用不到）
      const legacy = path.join(binDir, `${name}.cmd`);
      if (isOurs(legacy)) {
        if (process.env.CLOUDSSH_SHIM === 'cmd') deferred.push(legacy);
        else fs.rmSync(legacy, { force: true });
      }
    } else if (windows) {
      // 找不到启动器：退回 .cmd，以前装的 .exe 要拿掉（.exe 排在 .cmd 前面，留着会指向旧程序）
      for (const file of [path.join(binDir, `${name}.exe`), path.join(binDir, `${name}.shim`)]) {
        if (!isOurs(file)) continue;
        if (file.endsWith('.exe') && process.env.CLOUDSSH_SHIM === 'exe') deferred.push(file);
        else fs.rmSync(file, { force: true });
      }
      fs.writeFileSync(
        path.join(binDir, `${name}.cmd`),
        `@echo off\r\nrem ${MARK} ${CLIENT_VERSION}\r\nsetlocal\r\nset CLOUDSSH_SHIM=cmd\r\n${electron ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}"${runtime}" "${program}" %*\r\nexit /b %ERRORLEVEL%\r\n`
      );
    }
  }
  deleteAfterExit(deferred);
  const command = windows ? (launcher ? 'cloudssh.exe' : 'cloudssh.cmd') : 'cloudssh';
  lines.push(`命令：${path.join(binDir, command)}（以及 cssh）${electron ? '，用 CloudSSH 客户端运行' : ''}`);
  if (windows && !launcher) {
    lines.push(`注意：程序旁边没有 ${LAUNCHER}，命令装成了 .cmd；在 PowerShell 里带双引号的参数会被拆开，复杂命令请用 --stdin`);
  }
  if (!onPath(binDir)) lines.push(`注意：${binDir} 不在 PATH 里，请把它加进 PATH，或用 --bin-dir 指定一个在 PATH 里的目录`);
  if (options.skill) lines.push(...installSkills());
  const launch = launchFor(runtime, program, electron);
  lines.push(...refreshMcp(launch));
  if (mcpClients.length) lines.push(...registerMcp(mcpClients, launch));
  return lines;
}

function isOurs(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(MARK);
  } catch {
    return false;
  }
}

/** 读命令脚本：装了没有、指向的运行时与程序、启动方式（Windows 上先认启动器的 .shim，再认旧版的 .cmd） */
function readShim(binDir: string): { installed: boolean; runtime: string | null; program: string | null; appRuntime: boolean; launcher: Launcher | null } {
  const config = path.join(binDir, 'cloudssh.shim');
  if (windows && isOurs(config) && isOurs(path.join(binDir, 'cloudssh.exe'))) {
    const text = fs.readFileSync(config, 'utf8');
    const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() || null;
    return { installed: true, runtime: value('runtime'), program: value('program'), appRuntime: /^env=ELECTRON_RUN_AS_NODE=/m.test(text), launcher: 'exe' };
  }
  const script = path.join(binDir, windows ? 'cloudssh.cmd' : 'cloudssh');
  if (!isOurs(script)) return { installed: false, runtime: null, program: null, appRuntime: false, launcher: null };
  const text = fs.readFileSync(script, 'utf8');
  const match = /"([^"\r\n]+)" "([^"\r\n]+)" (?:%\*|"\$@")/.exec(text);
  return {
    installed: true,
    runtime: match?.[1] ?? null,
    program: match?.[2] ?? null,
    appRuntime: /ELECTRON_RUN_AS_NODE/.test(text),
    launcher: windows ? 'cmd' : 'sh',
  };
}

/**
 * MCP 客户端该怎么启动 cloudssh mcp：装了命令就跟命令指向同一个程序与运行时（重新安装时一起更新），
 * 没装就用正在运行的这个（桌面客户端里是安装包带的程序，用客户端当 Node 运行）
 */
export function mcpLaunch(binDirOption?: string): McpLaunch {
  const shim = readShim(defaultBinDir(binDirOption));
  if (shim.runtime && shim.program && fs.existsSync(shim.runtime) && fs.existsSync(shim.program)) {
    return launchFor(shim.runtime, shim.program, shim.appRuntime);
  }
  return launchFor(process.execPath, fileURLToPath(import.meta.url), !!process.versions.electron);
}

export function installStatus(binDirOption?: string): InstallStatus {
  const binDir = defaultBinDir(binDirOption);
  const { installed, runtime, program, appRuntime, launcher } = readShim(binDir);
  const skills = skillTargets();
  const file = skillPath();
  const skill = skills.some((item) => item.id === 'claude' && item.installed);
  // 开着的都装了且是最新的、关掉的都没装
  const skillCurrent = skills.every((item) => (item.enabled ? item.installed && item.current : !item.installed));
  return {
    installed,
    program,
    runtime,
    exists: !!program && !!runtime && fs.existsSync(program) && fs.existsSync(runtime),
    appRuntime,
    launcher,
    binDir,
    onPath: onPath(binDir),
    skill,
    skillCurrent,
    skillPath: file,
    skills,
    mcp: mcpTargets(mcpLaunch(binDirOption)),
    version: CLIENT_VERSION,
  };
}

/** 卸载：删带标记的命令脚本、复制过去的程序、skill；purge 时连 ~/.cloudssh（配置与登录）一起删 */
export function uninstall(options: { binDir?: string; keepSkill?: boolean; purge?: boolean }): string[] {
  const lines: string[] = [];
  const binDir = defaultBinDir(options.binDir);
  // 这些命令指向的程序：是复制过去的那份才一起删（别的目录里装的命令可能还指着它）
  const program = installStatus(options.binDir).program;
  lines.push(...unregisterMcp());
  const deferred: string[] = [];
  for (const name of NAMES) {
    const files = ['', '.cmd', '.exe', '.shim'].map((ext) => path.join(binDir, `${name}${ext}`));
    for (const file of files) {
      if (!isOurs(file)) continue;
      // 正在经 .cmd 运行时 cmd 还要接着读这个文件（不然报“找不到批处理文件”），经 .exe 运行时它被锁着：退出后再删
      const busy = (file.endsWith('.cmd') && process.env.CLOUDSSH_SHIM === 'cmd') || (file.endsWith('.exe') && process.env.CLOUDSSH_SHIM === 'exe');
      if (busy) deferred.push(file);
      else fs.rmSync(file, { force: true });
      lines.push(`已删除 ${file}`);
    }
  }
  for (const file of staleLaunchers(binDir)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      deferred.push(file);
    }
  }
  deleteAfterExit(deferred);
  const copy = path.join(copyDir(), 'cloudssh.mjs');
  if (program && path.resolve(program).toLowerCase() === path.resolve(copy).toLowerCase() && fs.existsSync(copy)) {
    fs.rmSync(copyDir(), { recursive: true, force: true });
    lines.push(`已删除 ${copyDir()}`);
  }
  if (!options.keepSkill) {
    for (const target of skillTargets()) {
      // 只删我们装的（frontmatter 里 name 是 cloudssh）
      if (!target.installed || !ours(target.path)) continue;
      fs.rmSync(path.dirname(target.path), { recursive: true, force: true });
      lines.push(`已删除 ${target.name} skill ${path.dirname(target.path)}`);
    }
  }
  if (options.purge && fs.existsSync(homeDir())) {
    fs.rmSync(homeDir(), { recursive: true, force: true });
    lines.push(`已删除配置与登录 ${homeDir()}`);
  }
  if (!lines.length) lines.push('没有找到已安装的 cloudssh');
  return lines;
}
