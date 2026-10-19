/**
 * 平台适配层：在实例管理里一键安装命令行 cloudssh 与 Claude Code skill。
 *
 * 安装包里带着打好的命令行（resources/cli/cloudssh.mjs，开发时用 packages/cli/dist）。安装、卸载、查状态都交给
 * 命令行自己做（cloudssh install --in-place / uninstall / install --status），这里只用客户端自己当 Node 运行它
 * （ELECTRON_RUN_AS_NODE=1）：用户不需要另装 Node，命令也直接指向安装包里的程序，客户端更新时跟着更新。
 * 启动时如果命令是这个客户端装的，就悄悄重装一次：客户端搬了位置也能修好，skill 跟上新版本。
 *
 * 设置（实例管理 → 命令行与 AI）：直接读写命令行的 ~/.cloudssh/config.json（与命令行共用 packages/cli/src/config.ts），
 * 改了写进 skill 的项（完全权限、超时、并发、别名、补充说明、各 agent 的开关）后让命令行 cloudssh skill sync 重写 skill。
 * MCP 开关（Claude Desktop、Cursor 等不支持 skill 的应用）交给命令行 cloudssh mcp add / remove：只在用户打开开关时
 * 写那个应用的配置（先备份），关掉即移除；重新安装命令时命令行会顺带更新已登记的。
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { originOf } from '@cloudssh/core';
import {
  type CliConfig,
  loadConfig,
  loadCredentials,
  MAX_SKILL_NOTES,
  normalizeOrigin,
  rememberInstance,
  saveConfig,
} from '../../../../../packages/cli/src/config';
import { MCP_CLIENTS } from '../../../../../packages/cli/src/mcp-clients';
import { configStore } from '../config/store';
import { createLogger } from '../logger';

const log = createLogger('cli-install');

export interface CliStatus {
  available: boolean;
  installed: boolean;
  program: string | null;
  exists: boolean;
  appRuntime: boolean;
  /** 命令指向的是这个客户端带的程序 */
  managed: boolean;
  binDir: string;
  onPath: boolean;
  skill: boolean;
  skillCurrent: boolean;
  skillPath: string;
  skills?: { id: string; name: string; path: string; enabled?: boolean; installed: boolean; current: boolean }[];
  /** 各 MCP 客户端的登记（旧版命令行没有） */
  mcp?: { id: string; name: string; path: string; present: boolean; registered: boolean; current: boolean; error?: string }[];
  version: string;
  error?: string;
}

export interface CliSettings {
  status: CliStatus;
  config: Pick<CliConfig, 'confirm' | 'concurrency' | 'timeout' | 'aliases' | 'skills' | 'skillNotes' | 'defaultInstance'>;
  /** 可选的默认实例：命令行登记过的 + 客户端里的 */
  instances: { name: string; url: string; signedIn: boolean }[];
}

export type CliSettingsPatch = Partial<CliSettings['config']>;

/** 客户端带的命令行程序 */
export function bundledCli(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'cli', 'cloudssh.mjs')
    : path.resolve(app.getAppPath(), '..', '..', 'packages', 'cli', 'dist', 'cloudssh.mjs');
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundledCli(), ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function runJson(args: string[]): Promise<CliStatus> {
  const program = bundledCli();
  const base = { available: fs.existsSync(program) } as const;
  if (!base.available) {
    return {
      ...base,
      installed: false,
      program: null,
      exists: false,
      appRuntime: false,
      managed: false,
      binDir: '',
      onPath: false,
      skill: false,
      skillCurrent: false,
      skillPath: '',
      version: '',
      error: '这个客户端没有带命令行程序',
    };
  }
  const result = await runCli([...args, '--json']);
  let status: Omit<CliStatus, 'available' | 'managed'>;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    throw new Error(result.stderr.trim().replace(/^cloudssh: /, '') || `命令行退出码 ${result.code}`);
  }
  const managed = !!status.program && path.resolve(status.program).toLowerCase() === path.resolve(program).toLowerCase();
  return { ...base, ...status, managed };
}

export function cliStatus(): Promise<CliStatus> {
  return runJson(['install', '--status']);
}

export function installCli(): Promise<CliStatus> {
  return runJson(['install', '--in-place']);
}

export function uninstallCli(): Promise<CliStatus> {
  return runJson(['uninstall']);
}

/** 把 MCP 服务器登记给某个应用（或移除） */
export function setCliMcp(id: string, on: boolean): Promise<CliStatus> {
  if (!MCP_CLIENTS.some((client) => client.id === id)) return Promise.reject(new Error(`不认识的 MCP 客户端 ${id}`));
  return runJson(['mcp', on ? 'add' : 'remove', id]);
}

export async function cliSettings(): Promise<CliSettings> {
  const status = await cliStatus();
  const config = loadConfig();
  const instances = new Map(config.instances.map((item) => [item.url, item.name]));
  for (const instance of configStore.instances) {
    const origin = originOf(instance.baseUrl);
    if (origin && !instances.has(origin)) instances.set(origin, instance.name);
  }
  let signedIn: Record<string, unknown> = {};
  try {
    signedIn = loadCredentials();
  } catch {
    // 读不到登录也照常显示
  }
  return {
    status,
    config: {
      confirm: config.confirm,
      concurrency: config.concurrency,
      timeout: config.timeout,
      aliases: config.aliases,
      skills: config.skills,
      skillNotes: config.skillNotes,
      defaultInstance: config.defaultInstance,
    },
    instances: [...instances].map(([url, name]) => ({ name, url, signedIn: url in signedIn })),
  };
}

const ALIAS_NAME = /^[\p{L}\p{N}_.-]{1,40}$/u;

/** 改设置：校验后写 config.json；skill 已经装过（或命令已装）就同步一次 */
export async function updateCliSettings(patch: CliSettingsPatch): Promise<CliSettings> {
  const config = loadConfig();
  if (patch.confirm === 'ask' || patch.confirm === 'never') config.confirm = patch.confirm;
  if (patch.concurrency !== undefined) {
    if (!Number.isInteger(patch.concurrency) || patch.concurrency < 1 || patch.concurrency > 32) throw new Error('批量并发要在 1～32 之间');
    config.concurrency = patch.concurrency;
  }
  if (patch.timeout !== undefined) {
    if (!Number.isInteger(patch.timeout) || patch.timeout < 1 || patch.timeout > 3600) throw new Error('默认超时要在 1～3600 秒之间');
    config.timeout = patch.timeout;
  }
  if (patch.skillNotes !== undefined) config.skillNotes = String(patch.skillNotes).slice(0, MAX_SKILL_NOTES);
  if (patch.skills && typeof patch.skills === 'object') {
    for (const [id, on] of Object.entries(patch.skills)) {
      if (['claude', 'codex', 'agents'].includes(id) && typeof on === 'boolean') config.skills[id] = on;
    }
  }
  if (patch.aliases && typeof patch.aliases === 'object') {
    const next: Record<string, string> = {};
    for (const [name, target] of Object.entries(patch.aliases)) {
      const value = String(target).trim();
      if (!ALIAS_NAME.test(name) || /^(all|srv-\d+|\d+)$/i.test(name)) throw new Error(`别名“${name}”不行：只能用字母、数字、_ . -，不能是 all 或主机 ID`);
      if (!value || value.length > 200) throw new Error(`别名“${name}”的目标不能为空`);
      next[name] = value;
    }
    config.aliases = next;
  }
  if (typeof patch.defaultInstance === 'string' && patch.defaultInstance) {
    const origin = normalizeOrigin(patch.defaultInstance);
    const desktop = configStore.instances.find((instance) => originOf(instance.baseUrl) === origin);
    rememberInstance(config, origin, desktop?.name);
    config.defaultInstance = origin;
  }
  saveConfig(config);
  const before = await cliStatus();
  if (before.available && (before.installed || before.skills?.some((item) => item.installed))) {
    const result = await runCli(['skill', 'sync']);
    if (result.code !== 0) log.warn('同步 skill 失败', result.stderr.trim());
  }
  return cliSettings();
}

/** 启动时：命令是这个客户端装的（或指向的程序已经不在了）就重装一次，跟上客户端的位置、skill 版本与 MCP 登记 */
export async function refreshCliInstall(): Promise<void> {
  try {
    const status = await cliStatus();
    if (!status.available || !status.installed) return;
    const ours = status.managed || (status.appRuntime && !status.exists);
    const mcpCurrent = (status.mcp ?? []).every((item) => !item.registered || item.current);
    if (!ours || (status.exists && status.skillCurrent && mcpCurrent && status.managed)) return;
    await installCli();
    log.info('已更新命令行 cloudssh 的安装');
  } catch (error) {
    log.warn('检查命令行安装失败', (error as Error).message);
  }
}
