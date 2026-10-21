/**
 * cloudssh mcp http：远程 MCP 服务器（Streamable HTTP），给云端的 AI 用（例如 Meta Muse 的自定义连接器：公网 HTTPS 地址 + OAuth）。
 * 放在反向代理（Caddy 等，负责 HTTPS）后面，默认只监听 127.0.0.1。工具与规则见 mcp.ts 的远程模式。
 *
 * 认证：内置一个只认一个人的 OAuth 2.1 授权服务器（MCP 授权规范）：
 * - 发现：/.well-known/oauth-protected-resource（RFC 9728）、/.well-known/oauth-authorization-server（RFC 8414，
 *   /.well-known/openid-configuration 同一份）；/mcp 没带或带了无效令牌时回 401 + WWW-Authenticate: Bearer resource_metadata=…
 * - 客户端：动态注册 /register（RFC 7591，回调地址要是 https，或本机的 http://localhost / 127.0.0.1）；也认 Client ID
 *   Metadata Document（client_id 本身是 https 地址：抓它的元数据，只连公网地址、5 秒、64KB、不跟随跳转）
 * - 授权：/authorize 显示确认页，输入部署时设的口令（只存 scrypt 哈希：CLOUDSSH_MCP_PASSWORD_HASH，用
 *   cloudssh mcp http --hash-password 生成）后发授权码；只支持 PKCE S256，授权码 10 分钟、只能用一次
 * - 令牌：/token（authorization_code、refresh_token；刷新令牌每用一次就换新的），访问令牌 1 小时、刷新令牌 30 天；/revoke 吊销
 * - 固定令牌（给只能填固定 Bearer、不会走 OAuth 的客户端）：环境变量 CLOUDSSH_MCP_STATIC_TOKENS 里只存令牌的 SHA-256，
 *   可带名字（名字:哈希，逗号隔开），用 cloudssh mcp http --new-token 生成；不过期，删掉那一项重启即吊销
 * - 口令连续输错 5 次后按指数退避锁定（1 分钟起，最长 15 分钟）；注册每小时最多 30 个客户端
 * - 状态文件 <CLOUDSSH_HOME>/mcp-http.json（权限 600）只存客户端与令牌的 SHA-256，不存令牌本身
 * MCP：POST /mcp 收 JSON-RPC（单条或批量），回 application/json；只有通知时回 202。不推送服务器消息（GET 回 405）、
 * 不用会话。客户端断开时取消还在执行的调用（关掉用到的服务器的后台会话，远端命令随之结束）。
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { CLIENT_VERSION } from '@cloudssh/core';
import { homeDir, UsageError } from './config';
import { McpServer, type RemoteAccess } from './mcp';
import { activeInstance } from './targets';

export interface HttpOptions {
  instance?: string;
  /** 监听地址：host:port（port 为 0 时由系统分配） */
  listen: string;
  /** 对外地址（https://mcp.example.com），用于令牌受众与发现文档 */
  publicUrl: string;
  passwordHash: string;
  access: RemoteAccess;
  /** 不提供的服务器（主机 ID 编号） */
  exclude: Set<number>;
  /** 固定令牌：SHA-256 → 名字（parseStaticTokens） */
  staticTokens?: Map<string, string>;
}

const ACCESS_TTL = 3600_000;
const REFRESH_TTL = 30 * 24 * 3600_000;
const CODE_TTL = 10 * 60_000;
const PENDING_TTL = 10 * 60_000;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_CLIENTS = 200;
const REGISTER_PER_HOUR = 30;
const METADATA_TTL = 3600_000;
const SCOPE = 'cloudssh';

type Json = Record<string, unknown>;

const log = (text: string) => process.stderr.write(`[${new Date().toISOString()}] cloudssh mcp http: ${text}\n`);
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// ---------- 口令 ----------

/** 口令哈希：scrypt$N$r$p$salt$hash（base64url） */
export function hashPassword(password: string): string {
  if (password.length < 12) throw new UsageError('口令至少 12 个字符');
  const salt = crypto.randomBytes(16);
  const N = 32768;
  const hash = crypto.scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function parsePasswordHash(value: string): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } {
  const match = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(value.trim());
  if (!match) throw new UsageError('口令哈希格式不对：用 cloudssh mcp http --hash-password 生成');
  const [, N, r, p, salt, hash] = match;
  return { N: Number(N), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') };
}

function verifyPassword(password: string, stored: ReturnType<typeof parsePasswordHash>): Promise<boolean> {
  return new Promise((resolve) => {
    crypto.scrypt(password, stored.salt, stored.hash.length, { N: stored.N, r: stored.r, p: stored.p, maxmem: 256 * 1024 * 1024 }, (error, derived) => {
      resolve(!error && crypto.timingSafeEqual(derived, stored.hash));
    });
  });
}

// ---------- 固定令牌 ----------

/** 新的固定令牌：32 字节随机数（256 位），前缀便于认出来 */
export function newStaticToken(): string {
  return `cssh_mcp_${randomToken(32)}`;
}

/** 写进 CLOUDSSH_MCP_STATIC_TOKENS 的一项：名字:SHA-256（只存哈希） */
export function staticTokenEntry(token: string, label?: string): string {
  return `${label ? `${label}:` : ''}${sha256(token)}`;
}

/** 解析 CLOUDSSH_MCP_STATIC_TOKENS：逗号隔开的 名字:SHA-256（名字可省）；格式不对就不启动 */
export function parseStaticTokens(value: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const item of (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = /^(?:([\w.-]{1,40}):)?([0-9a-f]{64})$/i.exec(item);
    if (!match) throw new UsageError(`固定令牌格式不对：${item.slice(0, 16)}…（应为 名字:SHA-256，用 cloudssh mcp http --new-token 生成）`);
    tokens.set(match[2].toLowerCase(), match[1] ?? 'token');
  }
  return tokens;
}

// ---------- 状态 ----------

interface ClientRecord {
  redirectUris: string[];
  name: string;
  /** 只存哈希；没有则是公开客户端（只靠 PKCE） */
  secretHash?: string;
  createdAt: number;
  usedAt: number;
}

interface TokenRecord {
  type: 'access' | 'refresh';
  clientId: string;
  family: string;
  expiresAt: number;
}

interface State {
  version: 1;
  clients: Record<string, ClientRecord>;
  tokens: Record<string, TokenRecord>;
}

class Store {
  private readonly file = path.join(homeDir(), 'mcp-http.json');
  state: State = { version: 1, clients: {}, tokens: {} };

  load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State;
      if (data?.version === 1 && data.clients && data.tokens) this.state = data;
    } catch {
      // 第一次运行或文件坏了：从空的开始（已发的令牌失效，客户端重新授权即可）
    }
    this.prune();
  }

  save(): void {
    this.prune();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, token] of Object.entries(this.state.tokens)) if (token.expiresAt <= now) delete this.state.tokens[key];
    const clients = Object.entries(this.state.clients);
    if (clients.length > MAX_CLIENTS) {
      clients.sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [id] of clients.slice(0, clients.length - MAX_CLIENTS)) delete this.state.clients[id];
    }
  }

  issue(clientId: string, family = randomToken(12)): Json {
    const access = randomToken();
    const refresh = randomToken();
    const now = Date.now();
    this.state.tokens[sha256(access)] = { type: 'access', clientId, family, expiresAt: now + ACCESS_TTL };
    this.state.tokens[sha256(refresh)] = { type: 'refresh', clientId, family, expiresAt: now + REFRESH_TTL };
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: SCOPE };
  }

  revokeFamily(family: string): void {
    for (const [key, token] of Object.entries(this.state.tokens)) if (token.family === family) delete this.state.tokens[key];
    this.save();
  }
}

// ---------- 客户端元数据文档（client_id 是 https 地址） ----------

/** 只允许公网地址（防止借这里去访问本机或内网） */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(Number(address.split('.')[2]))))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && address.split('.')[2] === '100'))) return false;
    if (a === 203 && b === 0 && address.split('.')[2] === '113') return false;
    return true;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return false;
    if (/^(fc|fd|fe[89ab]|ff)/.test(lower)) return false;
    if (lower.startsWith('2001:db8') || lower.startsWith('64:ff9b:')) return false;
    return /^[23]/.test(lower);
  }
  return false;
}

function safeLookup(hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((item) => !isPublicAddress(item.address));
    if (!list.length || bad) return callback(new Error(`不连非公网地址：${bad?.address ?? hostname}`));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

function fetchClientMetadata(url: string): Promise<Json> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: safeLookup as never, timeout: 5000, headers: { Accept: 'application/json', 'User-Agent': `cloudssh-mcp/${CLIENT_VERSION}` } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) request.destroy(new Error('元数据超过 64KB'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('不是 JSON 对象');
          resolve(data as Json);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('超时')));
    request.on('error', reject);
  });
}

// ---------- 工具函数 ----------

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/** 本机回调去掉端口后的样子；不是本机 http 回调时为 null */
function loopbackWithoutPort(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(url.hostname) || url.username || url.password || url.hash) return null;
    url.port = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * 回调地址是否是注册过的：一般要完全一致；本机 http 回调按 RFC 8252 §7.3 不比端口（主机、路径、参数照样要一致）——
 * 本机应用每次登录临时挑一个端口，例如 Claude Code 的元数据写的是 http://localhost/callback，实际来的是 http://localhost:62951/callback
 */
function redirectAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const target = loopbackWithoutPort(requested);
  return !!target && registered.some((uri) => loopbackWithoutPort(uri) === target);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function readBody(req: http.IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求太大'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 表单或 JSON 请求体 → 字段 */
function parseFields(body: string, contentType: string | undefined): Record<string, string> {
  if ((contentType ?? '').includes('application/json')) {
    try {
      const data = JSON.parse(body);
      if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      // 落到表单解析
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

const oauthError = (res: http.ServerResponse, status: number, error: string, description: string, headers: Record<string, string> = {}) =>
  send(res, status, { error, error_description: description }, headers);

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:440px;margin:48px auto;padding:0 16px;color:#1b1f24;background:#f6f7f9}
@media(prefers-color-scheme:dark){body{color:#e6e8eb;background:#14171a}.card{background:#1d2125!important;border-color:#2c3238!important}input{background:#14171a;color:inherit;border-color:#3a4148!important}}
.card{background:#fff;border:1px solid #dde1e6;border-radius:12px;padding:24px}h1{font-size:19px;margin:0 0 12px}p{margin:8px 0}.muted{opacity:.7;font-size:13px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c9ced4;border-radius:8px;font-size:15px;margin:12px 0}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer}.error{color:#d93025}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

// ---------- 服务器 ----------

interface PendingAuthorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

export async function serveHttp(options: HttpOptions): Promise<void> {
  const publicUrl = options.publicUrl.replace(/\/+$/, '');
  const issuer = publicUrl;
  const resource = `${publicUrl}/mcp`;
  const password = parsePasswordHash(options.passwordHash);
  const store = new Store();
  store.load();
  const staticTokens = options.staticTokens ?? new Map<string, string>();
  /** 已经用过的固定令牌（每个只在第一次用时记一行） */
  const staticSeen = new Set<string>();

  // 进程里只有一个 MCP 服务器：服务器列表缓存、后台会话在各个请求之间共用；进度通知在 HTTP 上不推送
  const mcp = new McpServer(options.instance, () => undefined, {
    access: options.access,
    exclude: options.exclude,
    audit: (line) => log(line),
  });

  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, CodeRecord>();
  const metadataCache = new Map<string, { at: number; redirectUris: string[]; name: string }>();
  let failures = 0;
  let lockedUntil = 0;
  const registrations: number[] = [];

  const resourceMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`;
  const unauthorized = (res: http.ServerResponse, description: string) =>
    oauthError(res, 401, 'invalid_token', description, {
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", scope="${SCOPE}"`,
    });

  /** 找客户端：注册过的，或者 client_id 是元数据文档地址 */
  async function findClient(clientId: string): Promise<{ redirectUris: string[]; name: string; secretHash?: string } | null> {
    const registered = store.state.clients[clientId];
    if (registered) return registered;
    if (!/^https:\/\//.test(clientId)) return null;
    const cached = metadataCache.get(clientId);
    if (cached && Date.now() - cached.at < METADATA_TTL) return cached;
    try {
      const url = new URL(clientId);
      if (url.hash || url.username || url.password) return null;
      const data = await fetchClientMetadata(clientId);
      if (data.client_id !== clientId) return null;
      const redirectUris = Array.isArray(data.redirect_uris) ? data.redirect_uris.filter(validRedirectUri) : [];
      if (!redirectUris.length) return null;
      const name = typeof data.client_name === 'string' ? data.client_name.slice(0, 100) : url.host;
      const entry = { at: Date.now(), redirectUris, name };
      metadataCache.set(clientId, entry);
      return entry;
    } catch (error) {
      log(`读取客户端元数据失败 ${clientId}：${(error as Error).message}`);
      return null;
    }
  }

  function authorizationServerMetadata(): Json {
    return {
      issuer,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      registration_endpoint: `${publicUrl}/register`,
      revocation_endpoint: `${publicUrl}/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: 'https://github.com/XMZO/CloudSSH-client',
    };
  }

  // ----- /authorize -----

  async function authorizeGet(url: URL, res: http.ServerResponse): Promise<void> {
    const params = url.searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const client = clientId ? await findClient(clientId) : null;
    // 认不出客户端或回调地址时不能跳回去（可能被拿来做开放跳转），直接显示错误
    if (!client) return sendHtml(res, 400, page('无法授权', '<h1>无法授权</h1><p class="error">不认识这个客户端（client_id）。</p>'));
    const redirect = redirectUri || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
    if (!redirect || !redirectAllowed(client.redirectUris, redirect)) {
      return sendHtml(res, 400, page('无法授权', '<h1>无法授权</h1><p class="error">回调地址（redirect_uri）与注册的不一致。</p>'));
    }
    const back = (error: string, description: string) => {
      const target = new URL(redirect);
      target.searchParams.set('error', error);
      target.searchParams.set('error_description', description);
      if (params.get('state')) target.searchParams.set('state', params.get('state')!);
      target.searchParams.set('iss', issuer);
      res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
      res.end();
    };
    if (params.get('response_type') !== 'code') return back('unsupported_response_type', 'only code is supported');
    const challenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !/^[\w-]{43,128}$/.test(challenge)) {
      return back('invalid_request', 'PKCE with S256 is required');
    }
    const requested = params.get('resource');
    if (requested && requested.replace(/\/+$/, '') !== resource && requested.replace(/\/+$/, '') !== publicUrl) {
      return back('invalid_target', `unknown resource ${requested}`);
    }
    const id = randomToken(24);
    pending.set(id, {
      clientId,
      clientName: client.name,
      redirectUri: redirect,
      state: params.get('state') ?? undefined,
      codeChallenge: challenge,
      scope: SCOPE,
      expiresAt: Date.now() + PENDING_TTL,
    });
    sendHtml(res, 200, consentPage(id, client.name, redirect));
  }

  function consentPage(id: string, name: string, redirect: string, error = ''): string {
    const host = new URL(redirect).host;
    return page(
      '授权访问 CloudSSH',
      `<h1>授权访问 CloudSSH</h1>
<p><b>${escapeHtml(name)}</b> 请求使用这台机器上的 CloudSSH：查看服务器列表、在服务器上执行命令${options.access === 'read-only' ? '（只读）' : options.access === 'full' ? '（完全权限）' : ''}。</p>
<p class="muted">授权后会回到 ${escapeHtml(host)}。不认识这个请求就关掉这个页面。</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize"><input type="hidden" name="request" value="${escapeHtml(id)}">
<input type="password" name="password" placeholder="部署时设的口令" autocomplete="current-password" autofocus required>
<button type="submit">授权</button></form>`
    );
  }

  async function authorizePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fields = parseFields(await readBody(req, 16 * 1024), req.headers['content-type']);
    const request = pending.get(fields.request ?? '');
    if (!request || request.expiresAt < Date.now()) {
      if (request) pending.delete(fields.request);
      return sendHtml(res, 400, page('无法授权', '<h1>无法授权</h1><p class="error">授权请求已过期，请回到应用里重新连接。</p>'));
    }
    const now = Date.now();
    if (now < lockedUntil) {
      return sendHtml(res, 429, consentPage(fields.request, request.clientName, request.redirectUri, `口令错误次数太多，请 ${Math.ceil((lockedUntil - now) / 1000)} 秒后再试`));
    }
    if (!(await verifyPassword(fields.password ?? '', password))) {
      failures++;
      if (failures >= 5) lockedUntil = Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** (failures - 5));
      log(`授权口令错误（第 ${failures} 次）`);
      return sendHtml(res, 401, consentPage(fields.request, request.clientName, request.redirectUri, '口令不对'));
    }
    failures = 0;
    lockedUntil = 0;
    pending.delete(fields.request);
    const code = randomToken();
    codes.set(sha256(code), { clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, expiresAt: Date.now() + CODE_TTL });
    const client = store.state.clients[request.clientId];
    if (client) {
      client.usedAt = Date.now();
      store.save();
    }
    log(`已授权客户端 ${request.clientName}`);
    const target = new URL(request.redirectUri);
    target.searchParams.set('code', code);
    if (request.state) target.searchParams.set('state', request.state);
    target.searchParams.set('iss', issuer);
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  // ----- /token、/revoke -----

  /** 客户端认证：有密钥的要对上密钥（client_secret_basic 或 client_secret_post），公开客户端只认 client_id */
  async function authenticateClient(req: http.IncomingMessage, fields: Record<string, string>): Promise<string | null> {
    let clientId = fields.client_id ?? '';
    let secret = fields.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const index = decoded.indexOf(':');
      if (index > 0) {
        clientId = decodeURIComponent(decoded.slice(0, index));
        secret = decodeURIComponent(decoded.slice(index + 1));
      }
    }
    if (!clientId) return null;
    const client = await findClient(clientId);
    if (!client) return null;
    if (client.secretHash) {
      if (!secret) return null;
      const given = Buffer.from(sha256(secret), 'hex');
      if (!crypto.timingSafeEqual(given, Buffer.from(client.secretHash, 'hex'))) return null;
    }
    return clientId;
  }

  async function token(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fields = parseFields(await readBody(req, 16 * 1024), req.headers['content-type']);
    const clientId = await authenticateClient(req, fields);
    if (!clientId) return oauthError(res, 401, 'invalid_client', 'unknown client or wrong secret');
    if (fields.resource && ![resource, publicUrl].includes(fields.resource.replace(/\/+$/, ''))) {
      return oauthError(res, 400, 'invalid_target', 'unknown resource');
    }
    if (fields.grant_type === 'authorization_code') {
      const key = sha256(fields.code ?? '');
      const code = codes.get(key);
      codes.delete(key);
      if (!code || code.expiresAt < Date.now() || code.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'invalid or expired code');
      if (fields.redirect_uri && fields.redirect_uri !== code.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
      const verifier = fields.code_verifier ?? '';
      const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!/^[\w.~-]{43,128}$/.test(verifier) || expected !== code.codeChallenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      return send(res, 200, store.issue(clientId));
    }
    if (fields.grant_type === 'refresh_token') {
      const key = sha256(fields.refresh_token ?? '');
      const record = store.state.tokens[key];
      if (!record || record.type !== 'refresh' || record.expiresAt < Date.now() || record.clientId !== clientId) {
        return oauthError(res, 400, 'invalid_grant', 'invalid or expired refresh token');
      }
      // 换新的一对，旧的同一系作废（刷新令牌只能用一次）
      store.revokeFamily(record.family);
      return send(res, 200, store.issue(clientId));
    }
    return oauthError(res, 400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  async function revoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fields = parseFields(await readBody(req, 16 * 1024), req.headers['content-type']);
    const clientId = await authenticateClient(req, fields);
    if (!clientId) return oauthError(res, 401, 'invalid_client', 'unknown client or wrong secret');
    const record = store.state.tokens[sha256(fields.token ?? '')];
    if (record && record.clientId === clientId) store.revokeFamily(record.family);
    send(res, 200, {});
  }

  // ----- /register -----

  async function register(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const now = Date.now();
    while (registrations.length && registrations[0] < now - 3600_000) registrations.shift();
    if (registrations.length >= REGISTER_PER_HOUR) return oauthError(res, 429, 'slow_down', 'too many registrations, try again later');
    let data: Json;
    try {
      data = JSON.parse(await readBody(req, 64 * 1024));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch {
      return oauthError(res, 400, 'invalid_client_metadata', 'body must be a JSON object');
    }
    const redirectUris = Array.isArray(data.redirect_uris) ? data.redirect_uris : [];
    if (!redirectUris.length || redirectUris.length > 10 || !redirectUris.every(validRedirectUri)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https (or http://localhost) URLs');
    }
    const method = typeof data.token_endpoint_auth_method === 'string' ? data.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      return oauthError(res, 400, 'invalid_client_metadata', 'unsupported token_endpoint_auth_method');
    }
    const grantTypes = Array.isArray(data.grant_types) ? data.grant_types : ['authorization_code', 'refresh_token'];
    if (!grantTypes.every((type) => type === 'authorization_code' || type === 'refresh_token')) {
      return oauthError(res, 400, 'invalid_client_metadata', 'unsupported grant_types');
    }
    registrations.push(now);
    const clientId = `cloudssh-${randomToken(16)}`;
    const secret = method === 'none' ? undefined : randomToken();
    const name = typeof data.client_name === 'string' && data.client_name.trim() ? data.client_name.trim().slice(0, 100) : '未命名的应用';
    store.state.clients[clientId] = { redirectUris: redirectUris as string[], name, secretHash: secret ? sha256(secret) : undefined, createdAt: now, usedAt: now };
    store.save();
    log(`注册客户端 ${name}（${new URL((redirectUris as string[])[0]).host}）`);
    send(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPE,
    });
  }

  // ----- /mcp -----

  async function mcpPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!auth) return unauthorized(res, 'missing bearer token');
    const digest = sha256(auth[1]);
    const record = store.state.tokens[digest];
    const staticLabel = staticTokens.get(digest);
    if (!staticLabel && (!record || record.type !== 'access' || record.expiresAt < Date.now())) return unauthorized(res, 'invalid or expired token');
    if (staticLabel && !staticSeen.has(staticLabel)) {
      staticSeen.add(staticLabel);
      log(`固定令牌 ${staticLabel} 开始使用`);
    }
    let message: unknown;
    try {
      message = JSON.parse(await readBody(req));
    } catch (error) {
      if ((error as { status?: number }).status === 413) return send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const items = Array.isArray(message) ? message : [message];
    const requestIds = items.filter((item) => item && typeof item === 'object' && 'method' in item && 'id' in item).map((item) => (item as Json).id);
    // 客户端断开：取消还在执行的调用
    let finished = false;
    res.on('close', () => {
      if (!finished) for (const id of requestIds) mcp.cancel(id as string | number);
    });
    const response = await mcp.respond(message);
    finished = true;
    if (res.destroyed) return;
    if (!response) {
      res.writeHead(202, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    send(res, 200, response);
  }

  // ----- 路由 -----

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 扫描器会发 //..%2f.env 这类路径：按协议相对地址解析会抛错，一律当本站路径解析，解析不了回 400
    let url: URL;
    try {
      const raw = req.url ?? '/';
      url = new URL(`http://localhost${raw.startsWith('/') ? raw : `/${raw}`}`);
    } catch {
      return send(res, 400, { error: 'bad_request' });
    }
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    // 发现文档与令牌接口允许跨域读取（浏览器里的 MCP 客户端会用到）；授权页不允许
    const cors = { 'Access-Control-Allow-Origin': '*' };
    switch (route) {
      case 'GET /':
      case 'GET /healthz':
        return send(res, 200, `CloudSSH MCP ${CLIENT_VERSION}：${resource}`);
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        return send(
          res,
          200,
          { resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'CloudSSH' },
          cors
        );
      case 'GET /.well-known/oauth-authorization-server':
      case 'GET /.well-known/oauth-authorization-server/mcp':
      case 'GET /.well-known/openid-configuration':
        return send(res, 200, authorizationServerMetadata(), cors);
      case 'POST /register':
        res.setHeader('Access-Control-Allow-Origin', '*');
        return register(req, res);
      case 'GET /authorize':
        return authorizeGet(url, res);
      case 'POST /authorize':
        return authorizePost(req, res);
      case 'POST /token':
        res.setHeader('Access-Control-Allow-Origin', '*');
        return token(req, res);
      case 'POST /revoke':
        res.setHeader('Access-Control-Allow-Origin', '*');
        return revoke(req, res);
      case 'POST /mcp':
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
        return mcpPost(req, res);
      case 'GET /mcp':
      case 'DELETE /mcp':
        return send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: use POST' } }, { Allow: 'POST' });
      default:
        return send(res, 404, { error: 'not_found' });
    }
  }

  // 定时清理过期的授权请求与授权码
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, item] of pending) if (item.expiresAt < now) pending.delete(key);
    for (const [key, item] of codes) if (item.expiresAt < now) codes.delete(key);
  }, 60_000);
  sweeper.unref();

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = (error as { status?: number }).status ?? 500;
      if (status === 500) log(`处理 ${req.method} ${req.url} 出错：${(error as Error)?.stack ?? String(error)}`);
      if (!res.headersSent) send(res, status, { error: status === 413 ? 'request_too_large' : 'server_error' });
      else res.end();
    });
  });
  // 长命令（最多 3600 秒）的请求不能被超时掐掉
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const match = /^(.*):(\d+)$/.exec(options.listen);
  if (!match) throw new UsageError(`监听地址要写成 主机:端口，例如 127.0.0.1:8790（现在是 ${options.listen}）`);
  const host = match[1].replace(/^\[|\]$/g, '');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(match[2]), host, () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  let who = '还没有登录 CloudSSH：先运行 cloudssh login';
  try {
    who = `CloudSSH 实例 ${activeInstance(options.instance).origin}`;
  } catch {
    // 工具调用时再报
  }
  log(`listening on http://${shown}:${address.port}（对外 ${resource}，权限 ${options.access}，${who}${options.exclude.size ? `，不提供 ${[...options.exclude].map((id) => `srv-${id}`).join(',')}` : ''}）`);
  if (staticTokens.size) log(`固定令牌 ${staticTokens.size} 个：${[...staticTokens.values()].join('、')}`);

  process.on('unhandledRejection', (error) => log(`未处理的异常：${(error as Error)?.stack ?? String(error)}`));
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
