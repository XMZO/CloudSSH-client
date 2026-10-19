/**
 * 把 cloudssh 的 MCP 服务器（cloudssh mcp）登记给不支持 skill 的应用：Claude Desktop、Cursor、VS Code、Windsurf、Codex。
 * - 只在用户明确要求时写：cloudssh install --mcp …、cloudssh mcp add …、桌面客户端“命令行与 Skill”设置页里的开关；
 *   之后重新安装（客户端换了位置、程序换了）只更新已经登记过的那几个
 * - 写之前把原文件备份成 <文件>.cloudssh-backup-<时间>；只动名为 cloudssh 的那一项，其他内容原样保留
 *   （VS Code 的 mcp.json 允许注释，写回时注释保留不了，原样留在备份里）
 * - 登记的直接是“运行时 + 程序 + mcp”，不经 cloudssh.cmd：Windows 上很多应用不经 shell 启动程序，起不了 .cmd；
 *   运行时是 CloudSSH 客户端（Electron 当 Node 用）时带上 ELECTRON_RUN_AS_NODE=1
 * - 用户在登记项里自己加的参数（mcp 之后的 --instance …）与环境变量（CLOUDSSH_INSTANCE 等）更新时保留
 * Claude Code 用 skill（cloudssh install 已装），不在这里登记。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './config';

/** MCP 客户端启动服务器的方式 */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpClientTarget {
  id: string;
  name: string;
  /** 配置文件 */
  path: string;
  /** 这台电脑上有这个应用（配置文件所在的目录在） */
  present: boolean;
  /** 已登记（名为 cloudssh 的服务器是 cloudssh mcp） */
  registered: boolean;
  /** 登记的就是现在这个程序与运行时 */
  current: boolean;
  /** 配置文件读不了（例如写坏了）时的原因 */
  error?: string;
}

type Format = 'mcpServers' | 'servers' | 'toml';

interface ClientDef {
  id: string;
  name: string;
  file(): string;
  format: Format;
}

const SERVER_NAME = 'cloudssh';
const ELECTRON_ENV = 'ELECTRON_RUN_AS_NODE';
const TOML_MARK = '# cloudssh-mcp：由 cloudssh 登记，cloudssh uninstall 或 cloudssh mcp remove codex 会删除';

/** 各系统放应用配置的目录：Windows %APPDATA%，macOS ~/Library/Application Support，其他 ~/.config */
function appConfigDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export const MCP_CLIENTS: readonly ClientDef[] = [
  { id: 'claude-desktop', name: 'Claude Desktop', file: () => path.join(appConfigDir(), 'Claude', 'claude_desktop_config.json'), format: 'mcpServers' },
  { id: 'cursor', name: 'Cursor', file: () => path.join(os.homedir(), '.cursor', 'mcp.json'), format: 'mcpServers' },
  { id: 'vscode', name: 'VS Code', file: () => path.join(appConfigDir(), 'Code', 'User', 'mcp.json'), format: 'servers' },
  { id: 'windsurf', name: 'Windsurf', file: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'), format: 'mcpServers' },
  { id: 'codex', name: 'Codex', file: () => path.join(os.homedir(), '.codex', 'config.toml'), format: 'toml' },
];

/** 运行时 + 程序 → 登记项 */
export function launchFor(runtime: string, program: string, electron: boolean): McpLaunch {
  return { command: runtime, args: [program, 'mcp'], env: electron ? { [ELECTRON_ENV]: '1' } : {} };
}

/** "claude-desktop,codex" / "all"（这台电脑上有的）→ 客户端；不认识的报用法错误 */
export function parseMcpClients(spec: string): ClientDef[] {
  const ids = spec
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length) throw new UsageError(`要指定 MCP 客户端：${MCP_CLIENTS.map((item) => item.id).join('、')} 或 all`);
  if (ids.includes('all')) {
    const present = MCP_CLIENTS.filter((client) => fs.existsSync(path.dirname(client.file())));
    if (!present.length) throw new UsageError('这台电脑上没有找到支持的 MCP 客户端');
    return present;
  }
  return ids.map((id) => {
    const client = MCP_CLIENTS.find((item) => item.id === id || item.name.toLowerCase() === id);
    if (!client) throw new UsageError(`不认识的 MCP 客户端 ${id}（可选：${MCP_CLIENTS.map((item) => item.id).join('、')}、all）`);
    return client;
  });
}

// ---------- JSON（允许注释与尾逗号）----------

/** 去掉 // 与 /* *\/ 注释、对象与数组末尾多余的逗号（字符串里的不动） */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += char;
      i++;
    }
  }
  // 尾逗号：字符串外的逗号后面只有空白就到 } 或 ]
  let result = '';
  let inString = false;
  for (let k = 0; k < out.length; k++) {
    const char = out[k];
    if (inString) {
      result += char;
      if (char === '\\') result += out[++k] ?? '';
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ',') {
      let next = k + 1;
      while (next < out.length && /\s/.test(out[next])) next++;
      if (out[next] === '}' || out[next] === ']') continue;
    }
    result += char;
  }
  return result;
}

interface JsonFile {
  data: Record<string, unknown>;
  /** 原文件里有注释（写回时保留不了） */
  hadComments: boolean;
}

function readJsonFile(file: string): JsonFile | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!text.trim()) return { data: {}, hadComments: false };
  const stripped = stripJsonc(text);
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch (error) {
    throw new Error(`${file} 不是有效的 JSON，没有改动：${(error as Error).message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} 的内容不是 JSON 对象，没有改动`);
  return { data: data as Record<string, unknown>, hadComments: /\/\/|\/\*/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""')) };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 登记项是不是 cloudssh mcp（args 里有 cloudssh 的程序与 mcp） */
function isOurEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const command = typeof entry.command === 'string' ? entry.command : '';
  const mcpAt = args.indexOf('mcp');
  if (mcpAt < 0) return false;
  return args.slice(0, mcpAt).some((arg) => /cloudssh\.mjs$/i.test(arg)) || /(^|[\\/])c(loud)?ssh(\.cmd|\.exe)?$/i.test(command);
}

/** 登记项与要登记的一致：程序、运行时、ELECTRON_RUN_AS_NODE 一样（用户加的参数与环境变量不管） */
function sameLaunch(command: string, args: string[], env: Record<string, unknown>, launch: McpLaunch): boolean {
  const norm = (value: string) => path.normalize(value).toLowerCase();
  const mcpAt = args.indexOf('mcp');
  return (
    norm(command) === norm(launch.command) &&
    mcpAt === launch.args.length - 1 &&
    args.slice(0, mcpAt).every((arg, index) => norm(arg) === norm(launch.args[index])) &&
    (env[ELECTRON_ENV] === '1') === (launch.env[ELECTRON_ENV] === '1')
  );
}

/** 新的登记项：保留用户在 mcp 之后加的参数与自己加的环境变量 */
function mergeEntry(existing: unknown, launch: McpLaunch, format: Format): Record<string, unknown> {
  const old = isOurEntry(existing) ? (existing as Record<string, unknown>) : {};
  const oldArgs = Array.isArray(old.args) ? old.args.map(String) : [];
  const extraArgs = oldArgs.includes('mcp') ? oldArgs.slice(oldArgs.indexOf('mcp') + 1) : [];
  const env: Record<string, string> = {};
  if (isObject(old.env)) {
    for (const [key, value] of Object.entries(old.env)) if (key !== ELECTRON_ENV && typeof value === 'string') env[key] = value;
  }
  Object.assign(env, launch.env);
  const entry: Record<string, unknown> = { ...old };
  delete entry.type;
  delete entry.command;
  delete entry.args;
  delete entry.env;
  return {
    ...(format === 'servers' ? { type: 'stdio' } : {}),
    command: launch.command,
    args: [...launch.args, ...extraArgs],
    ...(Object.keys(env).length ? { env } : {}),
    ...entry,
  };
}

// ---------- Codex 的 config.toml ----------

const TOML_HEADER = /^\s*\[\[?\s*([A-Za-z0-9_\-."' ]+?)\s*\]\]?\s*(?:#.*)?$/;

function tomlTableName(line: string): string | null {
  const match = TOML_HEADER.exec(line);
  return match ? match[1].replace(/\s*\.\s*/g, '.').replace(/"([^"]*)"|'([^']*)'/g, '$1$2') : null;
}

/** [mcp_servers.cloudssh] 与它的子表所在的行（[起, 止)），以及紧挨着的我们的标记行 */
function tomlSection(lines: string[]): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const name = tomlTableName(lines[i]);
    if (name === null) continue;
    const ours = name === `mcp_servers.${SERVER_NAME}` || name.startsWith(`mcp_servers.${SERVER_NAME}.`);
    if (start < 0 && ours) start = i;
    else if (start >= 0 && !ours) return { start: lines[start - 1] === TOML_MARK ? start - 1 : start, end: i };
  }
  if (start < 0) return null;
  return { start: lines[start - 1] === TOML_MARK ? start - 1 : start, end: lines.length };
}

/** TOML 基本字符串（JSON 的字符串转义 TOML 都认） */
const tomlString = (value: string) => JSON.stringify(value);

function tomlBlock(launch: McpLaunch, extraArgs: string[], extraEnv: Record<string, string>): string[] {
  const env = { ...extraEnv, ...launch.env };
  return [
    TOML_MARK,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${[...launch.args, ...extraArgs].map(tomlString).join(', ')}]`,
    ...(Object.keys(env).length
      ? [`env = { ${Object.entries(env).map(([key, value]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)} = ${tomlString(value)}`).join(', ')} }`]
      : []),
  ];
}

/** 从我们写的那种一行一个值的段里读出 command、args、env（读不出来的当作不一致） */
function readTomlSection(text: string): { command: string; args: string[]; env: Record<string, string> } | null {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text)?.[1];
  try {
    const command = value('command');
    const args = value('args');
    if (!command || !args) return null;
    const env: Record<string, string> = {};
    const envText = value('env');
    if (envText) {
      for (const match of envText.matchAll(/([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")/g)) {
        env[match[1].startsWith('"') ? JSON.parse(match[1]) : match[1]] = JSON.parse(match[2]);
      }
    }
    return { command: JSON.parse(command), args: JSON.parse(args), env };
  } catch {
    return null;
  }
}

// ---------- 读写 ----------

function backup(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const copy = `${file}.cloudssh-backup-${stamp}`;
  fs.copyFileSync(file, copy);
  return copy;
}

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 一个客户端的登记状态 */
function inspect(client: ClientDef, launch: McpLaunch): McpClientTarget {
  const file = client.file();
  const base = { id: client.id, name: client.name, path: file, present: fs.existsSync(path.dirname(file)), registered: false, current: false };
  try {
    if (client.format === 'toml') {
      const text = readText(file);
      if (text === null) return base;
      const lines = text.split(/\r?\n/);
      const section = tomlSection(lines);
      if (!section) return base;
      const body = lines.slice(section.start, section.end).join('\n');
      const parsed = readTomlSection(body);
      const registered = /cloudssh\.mjs/i.test(body) && /"mcp"/.test(body);
      return { ...base, registered, current: registered && !!parsed && sameLaunch(parsed.command, parsed.args, parsed.env, launch) };
    }
    const json = readJsonFile(file);
    const entry = json && isObject(json.data[client.format]) ? (json.data[client.format] as Record<string, unknown>)[SERVER_NAME] : undefined;
    if (!isOurEntry(entry)) return base;
    const value = entry as Record<string, unknown>;
    const current = sameLaunch(String(value.command), (value.args as unknown[]).map(String), isObject(value.env) ? value.env : {}, launch);
    return { ...base, registered: true, current };
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }
}

export function mcpTargets(launch: McpLaunch): McpClientTarget[] {
  return MCP_CLIENTS.map((client) => inspect(client, launch));
}

/** 登记（或更新）一个客户端；返回给用户看的说明 */
function register(client: ClientDef, launch: McpLaunch): string {
  const file = client.file();
  if (client.format === 'toml') {
    const text = readText(file) ?? '';
    const lines = text ? text.split(/\r?\n/) : [];
    const section = tomlSection(lines);
    let extraArgs: string[] = [];
    let extraEnv: Record<string, string> = {};
    if (section) {
      const parsed = readTomlSection(lines.slice(section.start, section.end).join('\n'));
      if (parsed && parsed.args.includes('mcp')) {
        extraArgs = parsed.args.slice(parsed.args.indexOf('mcp') + 1);
        extraEnv = Object.fromEntries(Object.entries(parsed.env).filter(([key]) => key !== ELECTRON_ENV));
      }
      lines.splice(section.start, section.end - section.start);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const next = [...lines, ...(lines.length ? [''] : []), ...tomlBlock(launch, extraArgs, extraEnv), ''].join(text.includes('\r\n') ? '\r\n' : '\n');
    const saved = text ? backup(file) : null;
    writeFile(file, next);
    return `${client.name}：已登记 MCP 服务器 cloudssh（${file}${saved ? `，原文件备份为 ${path.basename(saved)}` : ''}）`;
  }
  const json = readJsonFile(file);
  const data = json?.data ?? {};
  const servers = isObject(data[client.format]) ? { ...(data[client.format] as Record<string, unknown>) } : {};
  const replaced = SERVER_NAME in servers && !isOurEntry(servers[SERVER_NAME]);
  servers[SERVER_NAME] = mergeEntry(servers[SERVER_NAME], launch, client.format);
  const saved = json ? backup(file) : null;
  writeFile(file, `${JSON.stringify({ ...data, [client.format]: servers }, null, 2)}\n`);
  const notes = [
    saved ? `原文件备份为 ${path.basename(saved)}` : '',
    replaced ? '替换了原来同名的 cloudssh 项' : '',
    json?.hadComments ? '原文件里的注释没能保留（在备份里）' : '',
  ].filter(Boolean);
  return `${client.name}：已登记 MCP 服务器 cloudssh（${file}${notes.length ? `，${notes.join('，')}` : ''}）`;
}

/** 删掉我们登记的那一项（别人的同名项不动）；没登记就返回 null */
function unregister(client: ClientDef): string | null {
  const file = client.file();
  if (client.format === 'toml') {
    const text = readText(file);
    if (text === null) return null;
    const lines = text.split(/\r?\n/);
    const section = tomlSection(lines);
    if (!section) return null;
    const body = lines.slice(section.start, section.end).join('\n');
    if (!/cloudssh\.mjs/i.test(body) || !/"mcp"/.test(body)) return null;
    lines.splice(section.start, section.end - section.start);
    // 去掉删除后留在末尾的空行（登记时在前面补过一个空行）
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = lines.length ? `${lines.join(eol)}${eol}` : '';
    const saved = backup(file);
    writeFile(file, next);
    return `${client.name}：已移除 MCP 服务器 cloudssh（原文件备份为 ${path.basename(saved)}）`;
  }
  const json = readJsonFile(file);
  if (!json || !isObject(json.data[client.format])) return null;
  const servers = { ...(json.data[client.format] as Record<string, unknown>) };
  if (!isOurEntry(servers[SERVER_NAME])) return null;
  delete servers[SERVER_NAME];
  const saved = backup(file);
  writeFile(file, `${JSON.stringify({ ...json.data, [client.format]: servers }, null, 2)}\n`);
  return `${client.name}：已移除 MCP 服务器 cloudssh（原文件备份为 ${path.basename(saved)}${json.hadComments ? '，原文件里的注释没能保留' : ''}）`;
}

/** 登记给这些客户端（已是最新的跳过） */
export function registerMcp(clients: ClientDef[], launch: McpLaunch): string[] {
  const lines: string[] = [];
  for (const client of clients) {
    const state = inspect(client, launch);
    if (state.error) throw new Error(state.error);
    lines.push(state.current ? `${client.name}：MCP 服务器 cloudssh 已登记（${state.path}）` : register(client, launch));
  }
  if (lines.length) lines.push('重启这些应用（或在应用里重新加载 MCP 服务器）后生效');
  return lines;
}

/** 已经登记过、但指向的不是现在这个程序的，更新一遍（重新安装时用；没登记的不碰） */
export function refreshMcp(launch: McpLaunch): string[] {
  return MCP_CLIENTS.flatMap((client) => {
    const state = inspect(client, launch);
    if (!state.registered || state.current || state.error) return [];
    try {
      return [register(client, launch)];
    } catch (error) {
      return [`${client.name}：更新 MCP 登记失败：${(error as Error).message}`];
    }
  });
}

/** 从这些客户端（不给就是全部）移除登记 */
export function unregisterMcp(clients: readonly ClientDef[] = MCP_CLIENTS): string[] {
  return clients.flatMap((client) => {
    try {
      const line = unregister(client);
      return line ? [line] : [];
    } catch (error) {
      return [`${client.name}：移除 MCP 登记失败：${(error as Error).message}`];
    }
  });
}
