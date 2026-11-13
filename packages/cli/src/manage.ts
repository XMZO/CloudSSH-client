/**
 * 管理 CloudSSH 本身（MCP 的 add_server / update_server / delete_server / snippets / server_notes，以及 list_servers 的详细信息）：
 * 调 CloudSSH 的数据接口，与网页版、客户端改的是同一份数据。实例是入口网关时由网关转给主节点、再同步到各节点。
 * - 服务器：凭据（密码、私钥、Access 密钥）只写不读，接口不会返回；修改时不给凭据就保留原来的，换认证方式要同时给新凭据
 * - 命令片段：网页版终端旁的“命令片段”，名称 ≤ 50 字、命令 ≤ 2000 字、每人最多 100 条
 * - 服务器笔记：CloudSSH 内置 AI 助手按服务器记的“知识”（凭据、配置、规则、备注）与“工作历程”，这里读写的是同一份
 */
import type { ServerConfig } from '@cloudssh/core';
import { UsageError } from './config';
import { api } from './net';
import { hostId, routeOf } from './targets';

/** Durable Object 的区域（与 CloudSSH 的 ALLOWED_LOCATION_HINTS 一致）；auto 表示按地址自动推断 */
export const REGIONS = ['auto', 'wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'] as const;

export interface ServerInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  auth?: 'password' | 'key' | 'none';
  password?: string;
  privateKey?: string;
  /** 整个替换 */
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  /** 跳板机的服务器 id；null 表示不用跳板 */
  jumpId?: number | null;
  /** Cloudflare 隧道域名；空串表示改回直连 */
  tunnelHost?: string;
  accessClientId?: string;
  accessClientSecret?: string;
  region?: (typeof REGIONS)[number];
}

/** 带密码的私钥（PEM 的 ENCRYPTED、PKCS#8 加密、OpenSSH 新格式的 bcrypt）：CloudSSH 只收解开的 */
export function isEncryptedKey(key: string): boolean {
  if (/ENCRYPTED/.test(key)) return true;
  const pem = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----([\s\S]+?)-----END \1PRIVATE KEY-----/.exec(key);
  if (pem?.[1] !== 'OPENSSH ') return false;
  const body = pem[2];
  const bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  // openssh-key-v1\0 之后是 ciphername（string）：不是 none 就是加了密
  const magic = 'openssh-key-v1\0';
  if (bytes.subarray(0, magic.length).toString('latin1') !== magic) return false;
  const length = bytes.readUInt32BE(magic.length);
  return bytes.subarray(magic.length + 4, magic.length + 4 + length).toString('latin1') !== 'none';
}

const cleanTags = (tags: string[]) => [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 10);

/** 拼接口要的字段：只放给了的；current 有值时是修改（标签增减按现有的算） */
export function serverBody(input: ServerInput, current?: ServerConfig): Record<string, unknown> {
  if (input.password !== undefined && input.privateKey !== undefined) throw new UsageError('Give either password or private_key, not both');
  const auth = input.auth ?? (input.privateKey !== undefined ? 'key' : input.password !== undefined ? 'password' : undefined);
  if (auth === 'key' && input.password !== undefined) throw new UsageError('auth key takes private_key, not password');
  if (auth === 'password' && input.privateKey !== undefined) throw new UsageError('auth password takes password, not private_key');
  if (auth === 'none' && (input.password !== undefined || input.privateKey !== undefined)) throw new UsageError('auth none takes no credentials');
  const nextAuth = auth ?? current?.auth_method;
  const switching = !!auth && (auth === 'key' ? 'publickey' : auth) !== current?.auth_method;
  if (switching && auth === 'key' && input.privateKey === undefined) throw new UsageError('Key login requires private_key (the full private key text)');
  if (switching && auth === 'password' && input.password === undefined) throw new UsageError('Password login requires password (an empty string is allowed)');
  if (input.privateKey !== undefined) {
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(input.privateKey)) throw new UsageError('private_key must be the full private key text, starting with -----BEGIN … PRIVATE KEY-----');
    if (isEncryptedKey(input.privateKey)) {
      throw new UsageError('This private key is passphrase-protected and CloudSSH stores only unencrypted keys: remove the passphrase locally first (ssh-keygen -p -N "" -f FILE), or have the user import it in the server settings of the CloudSSH web app (it is decrypted in the browser)');
    }
  }

  const body: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new UsageError('name must not be empty');
    body.name = name;
  }
  if (input.host !== undefined) {
    const host = input.host.trim();
    if (!host) throw new UsageError('host must not be empty');
    body.host = host;
  }
  if (input.port !== undefined) body.port = input.port;
  if (input.username !== undefined) {
    if (!input.username.trim()) throw new UsageError('username must not be empty');
    body.username = input.username.trim();
  }
  if (auth) body.auth_method = auth === 'key' ? 'publickey' : auth;
  if (input.password !== undefined) body.credential = input.password;
  if (input.privateKey !== undefined) body.credential = `${input.privateKey.replace(/\r\n/g, '\n').trim()}\n`;
  if (nextAuth === 'none' && auth === 'none') body.credential = '';

  let tags = input.tags !== undefined ? cleanTags(input.tags) : current ? [...(current.tags ?? [])] : undefined;
  if (input.addTags?.length || input.removeTags?.length) {
    const remove = new Set((input.removeTags ?? []).map((tag) => tag.trim()));
    tags = cleanTags([...(tags ?? []).filter((tag) => !remove.has(tag)), ...(input.addTags ?? [])]);
  }
  if (tags !== undefined && (input.tags !== undefined || input.addTags?.length || input.removeTags?.length)) body.tags = tags;

  if (input.tunnelHost !== undefined) {
    const tunnel = input.tunnelHost.trim().replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '');
    if (tunnel) {
      if (input.jumpId) throw new UsageError('A Cloudflare tunnel connection cannot use a jump host');
      body.transport_type = 'cf_tunnel';
      body.cf_tunnel_host = tunnel;
      body.jump_server_id = null;
      if (!current && body.host === undefined) body.host = tunnel;
    } else {
      body.transport_type = 'direct';
    }
  }
  if (input.jumpId !== undefined) {
    if (input.jumpId !== null && (body.transport_type ?? current?.transport_type) === 'cf_tunnel') {
      throw new UsageError('This server connects through a Cloudflare tunnel and cannot use a jump host: set tunnel_host to "" first to switch it to direct');
    }
    body.jump_server_id = input.jumpId;
  }
  if (input.accessClientId !== undefined) body.cf_access_client_id = input.accessClientId.trim();
  if (input.accessClientSecret !== undefined) body.cf_access_client_secret = input.accessClientSecret.trim();
  if (input.region !== undefined) body.region = input.region === 'auto' ? '' : input.region;
  return body;
}

export async function createServer(input: ServerInput): Promise<ServerConfig> {
  if (!input.name?.trim()) throw new UsageError('Missing name (display name)');
  if (!input.host?.trim() && !input.tunnelHost?.trim()) throw new UsageError('Missing host (IP or domain; for a Cloudflare tunnel give tunnel_host)');
  const auth = input.auth ?? (input.privateKey !== undefined ? 'key' : input.password !== undefined ? 'password' : undefined);
  if (!auth) throw new UsageError('Credentials required: password (password login) or private_key (key login); for a server without authentication pass auth: none');
  const body = serverBody({ ...input, auth });
  body.port ??= 22;
  body.username ??= 'root';
  body.tags ??= [];
  if (body.credential === undefined) body.credential = '';
  return api<ServerConfig>('/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function updateServer(server: ServerConfig, input: ServerInput): Promise<void> {
  const body = serverBody(input, server);
  if (!Object.keys(body).length) throw new UsageError('Nothing to change: give the fields to change (name, host, port, username, password, private_key, tags, …)');
  await api(`/api/servers/${server.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function deleteServer(server: ServerConfig): Promise<void> {
  await api(`/api/servers/${server.id}`, { method: 'DELETE' });
}

const AUTH_NAMES: Record<string, string> = { password: 'password', publickey: 'key', none: 'none' };

/** 一台服务器的详细信息（不含任何凭据） */
export function describeServer(server: ServerConfig, servers: ServerConfig[]): string {
  const route = routeOf(server, servers);
  const address = server.transport_type === 'cf_tunnel' ? `${server.cf_tunnel_host ?? server.host} (Cloudflare tunnel)` : `${server.host}:${server.port}`;
  const region = server.region ? server.region : server.inferred_hint ? `auto (${server.inferred_hint})` : 'auto';
  const access = server.cf_access_client_id ? `, Access ${server.cf_access_client_id}${server.has_cf_access_client_secret ? ' + secret' : ''}` : '';
  const last = server.last_connected_at ? `${new Date(server.last_connected_at).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'never';
  return (
    `${hostId(server).padEnd(9)} ${server.name}\n` +
    `          ${server.username}@${address}  ${AUTH_NAMES[server.auth_method] ?? server.auth_method}  ${route}${access}\n` +
    `          tags [${(server.tags ?? []).join(', ') || '-'}]  OS ${server.os ?? '?'}  region ${region}  last connected ${last}`
  );
}

// ---------- 命令片段 ----------

export interface Snippet {
  id: string | number;
  name: string;
  command: string;
  category?: string | null;
}

export async function listSnippets(): Promise<Snippet[]> {
  const list = await api<Snippet[]>('/api/snippets');
  return Array.isArray(list) ? list : [];
}

export async function saveSnippet(input: { id?: string; name: string; command: string; category?: string }): Promise<Snippet> {
  const name = input.name.trim();
  if (!name) throw new UsageError('name must not be empty');
  if ([...name].length > 50) throw new UsageError('name must be at most 50 characters');
  if (!input.command.trim()) throw new UsageError('command must not be empty');
  if ([...input.command].length > 2000) throw new UsageError('command must be at most 2000 characters');
  const body = JSON.stringify({ name, command: input.command, category: input.category?.trim() ?? '' });
  const init = { headers: { 'Content-Type': 'application/json' }, body };
  return input.id
    ? api<Snippet>(`/api/snippets/${encodeURIComponent(input.id)}`, { method: 'PUT', ...init })
    : api<Snippet>('/api/snippets', { method: 'POST', ...init });
}

export async function deleteSnippet(id: string): Promise<void> {
  await api(`/api/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function formatSnippet(snippet: Snippet): string {
  const command = snippet.command.length > 300 ? `${snippet.command.slice(0, 300)}…[${snippet.command.length} chars in total]` : snippet.command;
  return `#${snippet.id}  ${snippet.name}${snippet.category ? `  [${snippet.category}]` : ''}\n    ${command.replace(/\n/g, '\n    ')}`;
}

// ---------- 服务器笔记（内置 AI 助手的知识与工作历程） ----------

export const NOTE_CATEGORIES = ['credential', 'config', 'rule', 'note'] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

interface KnowledgeItem {
  id: number;
  category: NoteCategory;
  key: string;
  value: string;
  updated_at?: number;
}

interface WorkLog {
  id: number;
  title: string;
  summary: string;
  updated_at?: number;
  created_at?: number;
}

export interface ServerNotes {
  knowledge: KnowledgeItem[];
  workLogs: WorkLog[];
}

export async function readNotes(server: ServerConfig): Promise<ServerNotes> {
  const memory = await api<{ knowledge?: KnowledgeItem[]; workLogs?: WorkLog[] }>(`/api/servers/${server.id}/memory`);
  return { knowledge: Array.isArray(memory?.knowledge) ? memory.knowledge : [], workLogs: Array.isArray(memory?.workLogs) ? memory.workLogs : [] };
}

const time = (ms?: number) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '?');

export function formatNotes(server: ServerConfig, notes: ServerNotes): string {
  const lines = [`Notes for ${hostId(server)} ${server.name} (shared with CloudSSH's built-in AI assistant)`];
  lines.push(`== knowledge (${notes.knowledge.length})`);
  if (!notes.knowledge.length) lines.push('(none)');
  for (const item of notes.knowledge) {
    lines.push(`[${item.category}] ${item.key} = ${item.value.replace(/\n/g, '\n    ')}`);
  }
  lines.push(`== work log (latest ${notes.workLogs.length}, UTC)`);
  if (!notes.workLogs.length) lines.push('(none)');
  for (const log of notes.workLogs) lines.push(`${time(log.updated_at ?? log.created_at)}  ${log.title}: ${log.summary}`);
  return lines.join('\n');
}

/** CloudSSH 存知识时规范键名：去首尾空白、小写、空白与连字符换成下划线（同名即同一条） */
export function noteKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** 记下一条知识，返回实际存成的键名 */
export async function setNote(server: ServerConfig, category: NoteCategory, key: string, value: string): Promise<string> {
  const normalized = noteKey(key);
  if (!normalized) throw new UsageError('key must not be empty');
  if ([...normalized].length > 64) throw new UsageError('key must be at most 64 characters');
  if ([...value].length > 16384) throw new UsageError('value must be at most 16384 characters');
  await api(`/api/servers/${server.id}/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, key: normalized, value }),
  });
  return normalized;
}

/** 按键名删一条知识（键名按 CloudSSH 的规则规范后再找），返回删掉的键名 */
export async function deleteNote(server: ServerConfig, key: string): Promise<string> {
  const normalized = noteKey(key);
  const notes = await readNotes(server);
  const item = notes.knowledge.find((entry) => entry.key === normalized);
  if (!item) throw new UsageError(`${hostId(server)} ${server.name} has no note "${normalized}" (server_notes action: read lists the keys)`);
  await api(`/api/servers/${server.id}/knowledge/${item.id}`, { method: 'DELETE' });
  return normalized;
}

export async function addWorkLog(server: ServerConfig, title: string, summary: string): Promise<void> {
  if (!title.trim()) throw new UsageError('title must not be empty');
  if ([...title.trim()].length > 64) throw new UsageError('title must be at most 64 characters');
  if (!summary.trim()) throw new UsageError('summary must not be empty');
  if ([...summary.trim()].length > 300) throw new UsageError('summary must be at most 300 characters');
  await api(`/api/servers/${server.id}/work-logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim(), summary: summary.trim(), mode: 'create' }),
  });
}
