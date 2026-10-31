/**
 * CloudSSH 入口网关：把几个号上原样部署的 CloudSSH（节点）合成一个入口，不改它们的代码。
 *
 * Cloudflare 免费额度按账号算，SSH 会话开着就一直占 Durable Object 时长，一个号一天大约够所有标签页开 29 个小时。
 * 网关只做两件事：把新会话分到各个节点，以及让节点之间的数据互相同步。客户端、浏览器、命令行、MCP 都只连网关，
 * 用法和直接连 CloudSSH 一样。
 *
 * - 节点（NODES，见 wrangler.gateway.toml）：和网关同一个号的那个用服务绑定直接调（local），别的号经各自的代理
 *   （agent.js）调。网关用各节点数据库的内部接口替自己签发节点会话，所以不依赖你在哪个节点登录过
 * - 登录：网关自己管，用单管理员密码（ADMIN_PASSWORD_HASH，和节点上的同一种格式，可以就用同一个）；浏览器登录 7 天，
 *   给命令行 / 远程 MCP 用的长期令牌由管理接口签发。过渡期也认本号节点（单管理员密码模式）原来的登录
 * - 数据接口（服务器列表、增删改、命令片段、AI 设置……）原样转给主节点（HOME），带上主节点的会话。主节点暂停了
 *   （额度用完、连不上）就从别的节点读，服务器 / 命令片段的编号换回主节点的，这时只能查看和连接、不能改
 * - 新会话（POST /api/servers/:id/connect）：按 POLICY 挑节点（fill 按 ORDER 顺序用，主节点默认排最后；even 挑今天用得最少的），
 *   在那个节点上签一次性连接令牌，返回的连接地址仍是网关自己（带 node 参数）
 * - WebSocket（/api/ssh、/api/ssh/sftp）原样转给节点（返回的 101 由运行时直接接上，消息不经过网关代码），带上节点会话；
 *   断线恢复和 SFTP 附加看不出在哪个节点，按“新会话会放的”顺序挨个试（带着 node / via 提示的先试那个）
 * - SFTP 附加地址：节点按自己收到请求的地址生成（wss://<节点>/api/ssh/sftp?…），别的号上的节点给的是它自己的域名，
 *   客户端直接连过去会因为不同源、没登录而失败。网关不改 WebSocket 里的消息，由客户端把它换回网关的地址并带上
 *   via=<原来的主机>（本仓库的客户端、命令行、MCP 都这样做；网关转出的网页里插一小段脚本，浏览器直接打开也一样）
 * - 主机指纹的增删同时写到所有节点（经过跳板的记录里带着服务器编号，换成各节点自己的）
 * - 双向同步：每个节点都和主节点同步服务器（连同凭据、跳板关系）、命令片段、AI 设置，规则见 sync.js；定时（Cron）
 *   以及经网关改了数据之后马上一次。刚改过、还没同步到某节点的服务器，新会话固定放主节点
 * - 少占额度：网关自己不用 Durable Object，状态在 D1；节点的用量用只读统计令牌看，缓存 3 分钟
 * - 状态：GET /api/__gateway/status（要登录）返回各节点今天的用量、暂停情况、新会话会放哪个、最近一次同步、当前设置
 * - 管理（要浏览器 / 客户端的登录，长期令牌不行；客户端的实例管理里点）：分流策略、顺序、上限存在 D1，覆盖 wrangler 变量
 *   （PUT /api/__gateway/settings，DELETE 恢复默认）；立即同步（POST /api/__gateway/sync）；手动暂停 / 恢复节点
 *   （POST / DELETE /api/__gateway/pause?node=）；签发、列出、吊销长期令牌（/api/__gateway/tokens）
 *
 * 不同步：Agent 的工作记录和知识（留在会话所在的节点）、主机指纹的自动记录（各节点第一次连时自己记下）、分享（在主节点）。
 */
import { runOps, userDb } from './ops.js';
import {
  chooseNode,
  deletesLookSafe,
  jumpDepth,
  needsCredential,
  nextUtcMidnight,
  planServers,
  planSnippets,
  serverBody,
  snippetBody,
  translateHostIdentity,
} from './sync.js';

const USAGE_TTL_MS = 3 * 60_000;
const DOWN_MS = 10 * 60_000;
const NODE_SESSION_TTL_MS = 7 * 24 * 3600_000;
/** 节点会话剩不到一天就换新的 */
const NODE_SESSION_REFRESH_MS = 24 * 3600_000;
const BROWSER_SESSION_TTL_MS = 7 * 24 * 3600_000;
const AUTH_CACHE_MS = 2 * 60_000;
const CONFIG_CACHE_MS = 5 * 60_000;
const SYNC_LOCK_MS = 2 * 60_000;
/** Durable Object 按 128 MB 计费；免费额度每天 13,000 GB-s */
const DO_GB = 0.125;
const FREE_GBS = 13_000;
/** 代理每次最多几个操作（与 agent.js 的 MAX_OPS 一致） */
const AGENT_BATCH = 200;
const WS_FORWARD_HEADERS = ['upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'user-agent'];
/** 网关返回给页面的用户（单管理员） */
const GATEWAY_USER = { id: 1, github_id: -1, username: 'admin', avatar_url: null };
/** 不用登录就能访问的接口 */
const PUBLIC_API = new Set(['/api/health', '/api/version', '/api/verify', '/api/share/claim']);

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const describe = (error) => (error instanceof Error ? error.message : String(error));
const opError = (result) => result?.data?.error ?? `HTTP ${result?.status}`;
const encoder = new TextEncoder();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlBytes(text) {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

// ---------- 配置：节点 ----------

let nodesCache = null;

/**
 * NODES：[{ name, local?, origin?, agent?, routeKey, userId, auth: 'github' | 'password', limit? }]。
 * 运行时设置（loadSettings 读到的）优先：order 节点顺序、limit 默认上限、limits 各节点上限
 */
function nodesOf(env) {
  const settings = settingsCache.value;
  const raw = `${env.NODES}\n${JSON.stringify(settings)}`;
  if (nodesCache?.raw === raw) return nodesCache.value;
  const list = JSON.parse(env.NODES ?? '[]').map((node) => ({
    name: String(node.name),
    local: node.local === true,
    origin: node.origin ? new URL(node.origin).origin : null,
    agent: node.agent ?? null,
    routeKey: String(node.routeKey),
    userId: Number(node.userId ?? 1),
    auth: node.auth === 'password' ? 'password' : 'github',
    limit: Number(settings.limits?.[node.name] ?? node.limit ?? defaultLimit(env)),
  }));
  if (list.length === 0) throw new Error('没有配置节点（NODES）');
  const home = list.find((node) => node.name === env.HOME) ?? list.find((node) => node.local) ?? list[0];
  const names = Array.isArray(settings.order) && settings.order.length ? settings.order : env.ORDER ? env.ORDER.split(',') : null;
  const order = names
    ? names.map((name) => list.find((node) => node.name === String(name).trim())).filter(Boolean)
    : [...list.filter((node) => node !== home), home];
  for (const node of list) if (!order.includes(node)) order.push(node);
  const value = { list, home, order, byName: new Map(list.map((node) => [node.name, node])) };
  nodesCache = { raw, value };
  return value;
}

/** 没给节点单独设上限时用的：运行时设置 > LIMIT 变量 > 90% */
const defaultLimit = (env) => Number(settingsCache.value.limit ?? env.LIMIT ?? env.A_LIMIT ?? 0.9);

// ---------- 运行时设置（客户端的实例管理里改，存在 D1 的 kv 'settings'；没设的用 wrangler 变量） ----------

const SETTINGS_TTL_MS = 10_000;
let settingsCache = { value: {}, at: 0 };

/** 每个请求、每次定时任务开始时调用：同一个实例 10 秒内只读一次 D1 */
async function loadSettings(env) {
  if (Date.now() - settingsCache.at < SETTINGS_TTL_MS) return;
  try {
    const value = await kvGet(env, 'settings');
    settingsCache = { value: value && typeof value === 'object' ? value : {}, at: Date.now() };
  } catch {
    settingsCache = { value: settingsCache.value, at: Date.now() };
  }
}

/** 校验客户端发来的设置，只留认得的项 */
function cleanSettings(env, body) {
  const { byName } = nodesOf(env);
  const ratio = (value) => (typeof value === 'number' && value >= 0.05 && value <= 1 ? Math.round(value * 100) / 100 : null);
  const next = {};
  if (body?.policy === 'fill' || body?.policy === 'even') next.policy = body.policy;
  if (Array.isArray(body?.order)) {
    const names = body.order.map(String).filter((name) => byName.has(name));
    if (names.length && new Set(names).size === names.length) next.order = names;
  }
  if (ratio(body?.limit) != null) next.limit = ratio(body.limit);
  if (body?.limits && typeof body.limits === 'object') {
    const limits = {};
    for (const [name, value] of Object.entries(body.limits)) if (byName.has(name) && ratio(value) != null) limits[name] = ratio(value);
    if (Object.keys(limits).length) next.limits = limits;
  }
  return next;
}

// ---------- D1：会话、对照表与小状态 ----------

let schemaReady = null;
function ensureSchema(env) {
  schemaReady ??= (async () => {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS nodemap (node TEXT NOT NULL, kind TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, ua TEXT NOT NULL, ub TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (node, kind, b))'
      ),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT \'\', created INTEGER NOT NULL, expires INTEGER NOT NULL)'),
    ]);
    // 第一版只有 A ↔ B 两个号的对照表（map：a 是 A 的编号，b 是 B 的）：并进 nodemap，记在节点 A 名下
    const old = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'map'").first();
    if (old) {
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO nodemap (node, kind, a, b, ua, ub, stale) SELECT 'A', kind, a, b, ua, ub, stale FROM map"),
        env.DB.prepare('DROP TABLE map'),
      ]);
    }
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function kvGet(env, key) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(key).first();
  return row ? JSON.parse(row.v) : null;
}

async function kvSet(env, key, value) {
  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(key, JSON.stringify(value)).run();
}

/** 某节点与主节点的对照：a 是节点的编号，b 是主节点的 */
async function mapRows(env, node, kind) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare('SELECT a, b, ua, ub, stale FROM nodemap WHERE node = ? AND kind = ?').bind(node, kind).all();
  return results;
}

async function replaceMap(env, node, kind, rows) {
  const statements = [env.DB.prepare('DELETE FROM nodemap WHERE node = ? AND kind = ?').bind(node, kind)];
  for (const row of rows) {
    statements.push(
      env.DB.prepare('INSERT INTO nodemap (node, kind, a, b, ua, ub, stale) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(node, kind, row.a, row.b, row.ua, row.ub, row.stale ? 1 : 0)
    );
  }
  await env.DB.batch(statements);
}

// ---------- 节点上的数据库操作 ----------

async function agentOps(env, node, ops) {
  const token = env[`${node.name}_AGENT_TOKEN`] ?? env.AGENT_TOKEN;
  const results = [];
  for (let index = 0; index < ops.length; index += AGENT_BATCH) {
    const response = await fetch(new URL('/rpc', node.agent), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: ops.slice(index, index + AGENT_BATCH) }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.results)) throw new Error(`${node.name} 号代理：${body?.error ?? `HTTP ${response.status}`}`);
    results.push(...body.results);
  }
  return results;
}

/** 在节点的数据库上执行一批操作：本号直接调，别的号经代理 */
function nodeOps(env, node, ops) {
  if (node.local) return runOps(userDb(env.LOCAL_DB, node.routeKey), node.userId, ops);
  return agentOps(env, node, ops);
}

/** 节点会话（转发数据接口与 WebSocket 时带上）：存在 D1，剩不到一天时签新的 */
async function nodeSession(env, node, renew = false) {
  const key = `session:${node.name}`;
  const cached = renew ? null : await kvGet(env, key);
  if (cached?.token && cached.expires - Date.now() > NODE_SESSION_REFRESH_MS) return cached.token;
  const op = { op: 'createSession' };
  if (node.auth === 'password') {
    // 单管理员密码模式：令牌是 -1:<密码哈希指纹>:<随机>，节点按自己的 ADMIN_PASSWORD_HASH 核对指纹
    const hash = (env[`${node.name}_PASSWORD_HASH`] ?? env.ADMIN_PASSWORD_HASH ?? '').trim();
    if (!hash) throw new Error(`${node.name} 节点是单管理员密码模式，网关没有它的密码哈希`);
    op.token = `${node.routeKey}:${(await sha256Hex(hash)).slice(0, 8)}:${randomToken(24)}`;
  }
  const [result] = await nodeOps(env, node, [op]);
  if (!result?.ok || typeof result.data?.token !== 'string') throw new Error(`签发 ${node.name} 节点会话失败：${opError(result)}`);
  await kvSet(env, key, { token: result.data.token, expires: Date.now() + NODE_SESSION_TTL_MS });
  return result.data.token;
}

// ---------- 用量与节点暂停 ----------

async function accountUsage(token, account) {
  const query = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){p:durableObjectsPeriodicGroups(limit:10000,filter:{date_geq:$d}){sum{activeTime}}}}}`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { a: account, d: new Date().toISOString().slice(0, 10) } }),
  });
  const body = await response.json().catch(() => null);
  const groups = body?.data?.viewer?.accounts?.[0]?.p;
  if (!Array.isArray(groups)) throw new Error(body?.errors?.[0]?.message ?? `HTTP ${response.status}`);
  const gbs = (groups.reduce((sum, group) => sum + (group.sum?.activeTime ?? 0), 0) / 1e6) * DO_GB;
  return { gbs: Math.round(gbs), ratio: gbs / FREE_GBS };
}

/** 各节点今天（UTC）的 Durable Object 时长，缓存 3 分钟；没配统计令牌（<节点名>_ACCOUNT_ID / _ANALYTICS_TOKEN）的不填 */
async function getUsage(env, force = false) {
  const cached = await kvGet(env, 'usage');
  if (!force && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached;
  const result = { at: Date.now() };
  await Promise.all(
    nodesOf(env).list.map(async (node) => {
      const token = env[`${node.name}_ANALYTICS_TOKEN`];
      const account = env[`${node.name}_ACCOUNT_ID`];
      if (!token || !account) return;
      try {
        result[node.name] = await accountUsage(token, account);
      } catch (error) {
        result[node.name] = { error: describe(error) };
      }
    })
  );
  await kvSet(env, 'usage', result);
  return result;
}

async function downOf(env, node) {
  const down = await kvGet(env, `down:${node.name}`);
  return down && down.until > Date.now() ? down : null;
}

/** 节点出错：额度用完（报错里有 exceed）停到下一个 UTC 0 点，其他错误停 10 分钟；能读到它时会解除 */
async function markDown(env, node, reason) {
  const until = /exceed/i.test(reason) ? nextUtcMidnight() : Date.now() + DOWN_MS;
  await kvSet(env, `down:${node.name}`, { until, reason: String(reason).slice(0, 300), at: Date.now() });
}

/** 读到了 / 连上了：解除出错造成的暂停（手动暂停的不动，到时间自己恢复） */
async function clearDown(env, node) {
  const down = await downOf(env, node);
  if (down && !down.manual) await kvSet(env, `down:${node.name}`, null);
}

/** 按 ORDER 排好、带上用量和暂停情况，chooseNode 用 */
async function nodeStates(env) {
  const { order } = nodesOf(env);
  const usage = await getUsage(env).catch(() => null);
  return Promise.all(
    order.map(async (node) => ({ node, name: node.name, ratio: usage?.[node.name]?.ratio ?? null, gbs: usage?.[node.name]?.gbs ?? null, limit: node.limit, down: await downOf(env, node) }))
  );
}

// ---------- 登录 ----------

const authCache = new Map();

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function credentialOf(request) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  return cookieValue(request.headers.get('Cookie'), 'session') ?? bearer ?? null;
}

/**
 * 网关自己的会话（gw. 开头，浏览器 7 天、长期令牌按签发时定）；过渡期也认本号节点（单管理员密码模式）原来的登录。
 * 返回会话种类：'browser'（网页、客户端登录）、'api'（长期令牌）、'legacy'（本号节点原来的登录），没登录返回 false
 */
async function authed(request, env) {
  const token = credentialOf(request);
  if (!token) return false;
  const hit = authCache.get(token);
  if (hit && hit.until > Date.now()) return hit.kind;
  let kind = false;
  if (token.startsWith('gw.')) {
    await ensureSchema(env);
    const row = await env.DB.prepare('SELECT kind, expires FROM sessions WHERE hash = ?').bind(await sha256Hex(token)).first();
    if (row && (row.expires === 0 || row.expires > Date.now())) kind = row.kind === 'api' ? 'api' : 'browser';
  } else {
    const local = nodesOf(env).list.find((node) => node.local);
    if (local) {
      const response = await env.LOCAL_APP.fetch(new Request(new URL('/api/auth/me', request.url), { headers: { Cookie: `session=${token}` } }));
      if (response.ok) kind = 'legacy';
    }
  }
  if (kind) {
    if (authCache.size > 200) authCache.clear();
    authCache.set(token, { until: Date.now() + AUTH_CACHE_MS, kind });
  }
  return kind;
}

async function createSession(env, kind, label, ttlMs) {
  await ensureSchema(env);
  const token = `gw.${randomToken(32)}`;
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (hash, kind, label, created, expires) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), kind, label, now, ttlMs ? now + ttlMs : 0)
    .run();
  return token;
}

function parseHash(raw) {
  const match = /^pbkdf2\$sha256\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec((raw ?? '').trim());
  if (!match) return null;
  const verifier = b64urlBytes(match[3]);
  return verifier?.length === 32 ? { iterations: Number(match[1]), salt: match[2], verifier } : null;
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `session=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

/** 单管理员密码登录：和 CloudSSH 一样，浏览器按 /api/config 的盐和次数预拉伸，这里只做一次 SHA-256 恒时比对 */
async function handleLogin(request, env) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden origin' }, 403);
  const hash = parseHash(env.ADMIN_PASSWORD_HASH);
  if (!hash) return json({ error: 'Admin password hash is invalid' }, 500);
  const throttle = (await kvGet(env, 'login_fail')) ?? { count: 0, until: 0 };
  if (throttle.until > Date.now()) {
    const retryAfterSec = Math.ceil((throttle.until - Date.now()) / 1000);
    return json({ error: 'Too many failed attempts', retryAfterSec }, 429, { 'Retry-After': String(retryAfterSec) });
  }
  const body = await request.json().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key : '';
  const bytes = /^[A-Za-z0-9_-]{43,64}$/.test(key) ? b64urlBytes(key) : null;
  if (!bytes || bytes.length !== 32) return json({ error: 'Invalid key format' }, 400);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (!sameBytes(digest, hash.verifier)) {
    const count = throttle.count + 1;
    // 连续错 5 次后锁定，60 秒起翻倍，最长 15 分钟
    const until = count >= 5 ? Date.now() + Math.min(60_000 * 2 ** (count - 5), 15 * 60_000) : 0;
    await kvSet(env, 'login_fail', { count, until });
    return json({ error: 'Invalid password' }, 401);
  }
  await kvSet(env, 'login_fail', { count: 0, until: 0 });
  const token = await createSession(env, 'browser', '', BROWSER_SESSION_TTL_MS);
  return json(GATEWAY_USER, 200, { 'Set-Cookie': sessionCookie(request, token, BROWSER_SESSION_TTL_MS / 1000) });
}

async function handleLogout(request, env) {
  const token = credentialOf(request);
  if (token?.startsWith('gw.')) {
    await ensureSchema(env);
    await env.DB.prepare("DELETE FROM sessions WHERE hash = ? AND kind = 'browser'").bind(await sha256Hex(token)).run();
    authCache.delete(token);
  }
  return json({ success: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
}

let configCache = null;

/** /api/config：主节点的功能开关，登录方式换成网关自己的单管理员密码 */
async function handleConfig(request, env) {
  if (!configCache || configCache.expires < Date.now()) {
    let base = {};
    try {
      const response = await toNode(env, nodesOf(env).home, request, { session: false });
      if (response.ok) base = await response.json();
    } catch {
      // 主节点读不到：用默认值
    }
    configCache = { base, expires: Date.now() + CONFIG_CACHE_MS };
  }
  const hash = parseHash(env.ADMIN_PASSWORD_HASH);
  return json({
    ...configCache.base,
    turnstileEnabled: false,
    sitekey: '',
    githubAuthEnabled: false,
    githubAuthRequired: true,
    authMode: 'password',
    cfAccessEmail: null,
    passwordAuth: hash ? { kdf: 'pbkdf2-sha256', iterations: hash.iterations, salt: hash.salt } : null,
    passwordHashInvalid: !hash,
  });
}

// ---------- 转发 ----------

/**
 * HTTP 请求转给节点：本号节点经服务绑定（地址仍是网关自己的，节点按它校验同源、生成链接），别的号的节点走公网，
 * 地址与来源换成它的。带上节点会话（session: false 时不带，例如公开接口）；节点回的 Set-Cookie 不转给客户端
 */
async function toNode(env, node, request, { path, body, session = true } = {}) {
  const url = new URL(request.url);
  const target = `${node.local ? url.origin : node.origin}${path ?? url.pathname + url.search}`;
  const headers = new Headers(request.headers);
  headers.delete('Cookie');
  headers.delete('Authorization');
  if (session) headers.set('Cookie', `session=${await nodeSession(env, node)}`);
  if (headers.has('Origin') || (request.method !== 'GET' && request.method !== 'HEAD')) headers.set('Origin', node.local ? url.origin : node.origin);
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = body !== undefined ? body : request.body;
  const outgoing = new Request(target, init);
  let response = node.local ? await env.LOCAL_APP.fetch(outgoing) : await fetch(outgoing);
  if (response.status === 401 && session) {
    // 节点会话被清掉了（换了密码、过期）：签个新的再试一次（请求体已经读过的不重试）
    if (init.body === undefined || typeof init.body === 'string') {
      headers.set('Cookie', `session=${await nodeSession(env, node, true)}`);
      response = node.local ? await env.LOCAL_APP.fetch(new Request(target, init)) : await fetch(new Request(target, init));
    }
  }
  const out = new Response(response.body, response);
  out.headers.delete('Set-Cookie');
  const location = out.headers.get('Location');
  if (location && !node.local && location.startsWith(node.origin)) out.headers.set('Location', url.origin + location.slice(node.origin.length));
  return out;
}

/** WebSocket 转给节点：只带握手需要的头和节点会话，返回的 101 原样交回（不能包一层 Response） */
async function wsToNode(env, node, request, renew = false) {
  const url = new URL(request.url);
  url.searchParams.delete('node');
  url.searchParams.delete('via');
  const headers = new Headers();
  for (const name of WS_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Origin', node.local ? url.origin : node.origin);
  headers.set('Cookie', `session=${await nodeSession(env, node, renew)}`);
  const target = `${node.local ? url.origin : node.origin}${url.pathname}${url.search}`;
  const response = node.local ? await env.LOCAL_APP.fetch(new Request(target, { headers })) : await fetch(new Request(target, { headers }));
  if (response.status === 401 && !renew) return wsToNode(env, node, request, true);
  return response;
}

/**
 * WebSocket 该先试哪个节点：连接地址里的 node（网关签发的）；SFTP 附加地址里的 via（客户端换地址时记下的原主机，
 * 对上某个节点的域名）；SFTP 附加地址本来就是网关的（没有 via）说明是本号节点生成的
 */
function wsHint(env, url, path) {
  const { list, byName } = nodesOf(env);
  const named = byName.get(url.searchParams.get('node') ?? '');
  if (named) return named;
  const via = url.searchParams.get('via');
  if (via) return list.find((node) => node.origin && new URL(node.origin).host === via) ?? null;
  return path === '/api/ssh/sftp' ? (list.find((node) => node.local) ?? null) : null;
}

/**
 * 断线恢复、SFTP 附加：看不出在哪个节点，先试 hint，再按新会话的优先顺序挨个试，第一个回 101 的就是。
 * 暂停的节点放最后也试：暂停只是不再放新会话，已经开着的会话还在它上面
 */
async function wsAny(env, request, hint = null) {
  const states = await nodeStates(env);
  const preferred = chooseNode(states, policyOf(env));
  const rank = (state) => (state.node === hint ? 0 : state.name === preferred ? 1 : state.down ? 3 : 2);
  const order = [...states].sort((x, y) => rank(x) - rank(y));
  let last = null;
  for (const { node } of order) {
    try {
      const response = await wsToNode(env, node, request);
      if (response.status === 101) return response;
      last = response;
    } catch (error) {
      last = json({ error: describe(error) }, 502);
    }
  }
  return last ?? json({ error: 'no node available' }, 502);
}

const policyOf = (env) => ((settingsCache.value.policy ?? env.POLICY) === 'even' ? 'even' : 'fill');

// ---------- 新会话 ----------

async function handleConnect(request, env, ctx, homeId) {
  const self = new URL(request.url);
  const wsBase = `${self.protocol === 'https:' ? 'wss:' : 'ws:'}//${self.host}`;
  const { home } = nodesOf(env);
  const states = await nodeStates(env);
  const tried = new Set();
  // 挑到的节点出错就暂停它、换下一个
  for (let attempt = 0; attempt < states.length; attempt++) {
    const candidates = states.filter((state) => !tried.has(state.name));
    const name = chooseNode(candidates, policyOf(env));
    const state = candidates.find((item) => item.name === name);
    if (!state) break;
    tried.add(name);
    const node = state.node;
    let id = homeId;
    if (node !== home) {
      await ensureSchema(env);
      const row = await env.DB.prepare("SELECT a, stale FROM nodemap WHERE node = ? AND kind = 'server' AND b = ?").bind(node.name, homeId).first();
      // 还没同步过去、或主节点上刚改过：这个节点上没有（或是旧的），换一个
      if (!row || row.stale) continue;
      id = row.a;
    }
    try {
      const [result] = await nodeOps(env, node, [{ op: 'connect', id }]);
      if (result?.ok && typeof result.data?.token === 'string') {
        // WebSocket 马上就来，先把节点会话备好
        await nodeSession(env, node);
        await clearDown(env, node);
        // 主节点的列表按最近连接排序：在主节点上也记一下（签的令牌没人用，60 秒后作废）
        if (node !== home) ctx.waitUntil(nodeOps(env, home, [{ op: 'connect', id: homeId }]).catch(() => {}));
        return json({ wsUrl: `${wsBase}/api/ssh?token=${result.data.token}&node=${encodeURIComponent(node.name)}`, backend: node.name });
      }
      if (result?.status === 404) {
        if (node === home) return json({ error: 'Server not found' }, 404);
        continue;
      }
      if (result?.status === 403 && node === home) return json({ error: 'Forbidden' }, 403);
      await markDown(env, node, opError(result));
    } catch (error) {
      await markDown(env, node, describe(error));
    }
  }
  return json({ error: '所有节点都不可用，稍后再试' }, 503);
}

// ---------- 数据接口：主节点，暂停时从别的节点读 ----------

/** 主节点暂停时从别的节点读：路径里的服务器编号换成那个节点的，列表里的编号换回主节点的 */
async function readFromNode(env, node, request) {
  const url = new URL(request.url);
  const [servers, snippets] = await Promise.all([mapRows(env, node.name, 'server'), mapRows(env, node.name, 'snippet')]);
  const toNodeId = new Map(servers.map((row) => [row.b, row.a]));
  const toHomeServer = new Map(servers.map((row) => [row.a, row.b]));
  const toHomeSnippet = new Map(snippets.map((row) => [row.a, row.b]));
  let path = url.pathname;
  const match = /^\/api\/servers\/(\d+)(\/.*)?$/.exec(path);
  if (match) {
    const id = toNodeId.get(Number(match[1]));
    if (id == null) return json({ error: 'Server not found' }, 404);
    path = `/api/servers/${id}${match[2] ?? ''}`;
  }
  const response = await toNode(env, node, request, { path: path + url.search });
  if (!response.ok || (url.pathname !== '/api/servers' && url.pathname !== '/api/snippets')) return response;
  const list = await response.json();
  if (!Array.isArray(list)) return json(list);
  const mapped =
    url.pathname === '/api/servers'
      ? list
          .filter((server) => toHomeServer.has(server.id))
          .map((server) => ({ ...server, id: toHomeServer.get(server.id), jump_server_id: server.jump_server_id == null ? null : (toHomeServer.get(server.jump_server_id) ?? null) }))
      : list.filter((snippet) => toHomeSnippet.has(snippet.id)).map((snippet) => ({ ...snippet, id: toHomeSnippet.get(snippet.id) }));
  return json(mapped);
}

async function proxyData(request, env, text) {
  const { home, order } = nodesOf(env);
  // 数据接口的请求体都很小：先读出来，节点会话失效时可以换个会话重发
  const body = text !== undefined || request.method === 'GET' || request.method === 'HEAD' ? text : await request.text();
  if (!(await downOf(env, home))) {
    try {
      const response = await toNode(env, home, request, { body });
      if (response.status < 500) return response;
      const text = await response.clone().text();
      // 只有额度用完、Durable Object 出错才算主节点暂停；普通的 500 原样交回
      if (!/exceed|durable object/i.test(text)) return response;
      await markDown(env, home, text.slice(0, 200));
    } catch (error) {
      await markDown(env, home, describe(error));
    }
  }
  if (request.method !== 'GET') return json({ error: '主节点暂时不可用：现在只能查看和连接，改动等它恢复后再做' }, 503);
  for (const node of order) {
    if (node === home || (await downOf(env, node))) continue;
    try {
      return await readFromNode(env, node, request);
    } catch {
      // 换下一个
    }
  }
  return json({ error: '所有节点都不可用，稍后再试' }, 503);
}

// ---------- 网页 ----------

/**
 * 插到网页最前面：页面要连别的节点生成的 SFTP 附加地址（主机不是当前页面）时，换回网关的地址并带上 via。
 * 和 packages/ui-web/overrides/shared/gateway-attach.ts、ai-remote/session.ts 的做法一致
 */
const ATTACH_FIX = `<script>(()=>{const W=window.WebSocket;if(!W||W.__gwAttach)return;const fix=(u)=>{try{const x=new URL(String(u),location.href);if(x.pathname!=='/api/ssh/sftp'||x.host===location.host)return u;const y=new URL(x.pathname+x.search,location.href);y.protocol=location.protocol==='https:'?'wss:':'ws:';y.searchParams.set('via',x.host);return y.toString()}catch{return u}};class G extends W{constructor(u,p){super(fix(u),p)}}G.__gwAttach=true;window.WebSocket=G})();</script>`;
/** 网页的协商缓存：ETag 加上这个后缀，免得浏览器拿没插脚本的旧缓存 */
const PAGE_TAG = '-gw1';

async function servePage(env, request) {
  const headers = new Headers(request.headers);
  const tag = headers.get('If-None-Match');
  if (tag) {
    // 只认插过脚本的版本：去掉后缀再问节点；没有后缀的旧缓存当作没有
    if (tag.includes(`${PAGE_TAG}"`)) headers.set('If-None-Match', tag.replaceAll(`${PAGE_TAG}"`, '"'));
    else headers.delete('If-None-Match');
  }
  const response = await toNode(env, nodesOf(env).home, new Request(request, { headers }), { session: false });
  const etag = response.headers.get('ETag');
  const tagged = (out) => {
    if (etag) out.headers.set('ETag', etag.endsWith('"') ? `${etag.slice(0, -1)}${PAGE_TAG}"` : `${etag}${PAGE_TAG}`);
    return out;
  };
  if (response.status === 304) return tagged(new Response(null, response));
  if (!/text\/html/i.test(response.headers.get('Content-Type') ?? '')) return response;
  const out = new HTMLRewriter().on('head', { element: (head) => head.prepend(ATTACH_FIX, { html: true }) }).transform(response);
  const page = new Response(out.body, out);
  page.headers.delete('Content-Length');
  return tagged(page);
}

// ---------- 主机指纹同时写到其他节点 ----------

async function mirrorKnownHost(env, method, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof body?.host !== 'string' || body.port == null) return;
  const { list, home } = nodesOf(env);
  await Promise.all(
    list
      .filter((node) => node !== home)
      .map(async (node) => {
        const rows = await mapRows(env, node.name, 'server');
        const toNodeId = new Map(rows.map((row) => [row.b, row.a]));
        const host = translateHostIdentity(body.host, (id) => toNodeId.get(id));
        if (host == null) return;
        const op =
          method === 'DELETE' ? { op: 'deleteKnownHost', host, port: body.port } : { op: 'upsertKnownHost', host, port: body.port, fingerprint: body.fingerprint };
        await nodeOps(env, node, [op]).catch(() => {});
      })
  );
}

// ---------- 双向同步（每个节点和主节点） ----------

async function readSecrets(run, ids, errors, label) {
  const secrets = new Map();
  if (ids.length === 0) return secrets;
  const results = await run(ids.map((id) => ({ op: 'readSecret', id })));
  results.forEach((result, index) => {
    if (result.ok) secrets.set(ids[index], result.data);
    else errors.push(`读 ${label} 节点服务器 #${ids[index]} 的凭据失败：${opError(result)}`);
  });
  return secrets;
}

/** pair：{ node（节点名，对照表按它存）, label: { A: 节点名, B: 主节点名 }, side: { A: 节点操作, B: 主节点操作 } } */
async function syncServers(env, pair, lists, dry, errors) {
  const { side, label } = pair;
  const [aList, bList] = lists;
  const rows = await mapRows(env, pair.node, 'server');
  if (rows.length > 0 && (aList.length === 0 || bList.length === 0)) throw new Error('有一边读回空的服务器列表，这一轮不同步');
  const plan = planServers(aList, bList, rows);
  if (!deletesLookSafe(plan.deletes, aList.length, bList.length)) {
    throw new Error(`这一轮要删 ${plan.deletes.length} 台服务器，像是读错了列表，不同步`);
  }
  const arrow = (from) => `${label[from]}→${label[from === 'A' ? 'B' : 'A']}`;
  const summary = {
    total: { [label.A]: aList.length, [label.B]: bList.length },
    unchanged: plan.keep.length,
    copies: plan.copies.map((copy) => `${arrow(copy.from)} ${copy.src.name}${(copy.from === 'A' ? copy.b : copy.a) == null ? '（新建）' : ''}`),
    deletes: plan.deletes.map((item) => `${label[item.side]} #${item.id}`),
  };
  const oldRows = new Map(rows.map((row) => [row.b, row]));
  if (dry) return summary;
  if (plan.copies.length === 0 && plan.deletes.length === 0) {
    // 没事可做：只把新配上的对照记下来（初次对照、或两边各自手动建了一样的）
    if (plan.keep.length !== rows.length || rows.some((row) => row.stale)) {
      await replaceMap(env, pair.node, 'server', plan.keep.map((entry) => ({ ...entry, stale: 0 })));
    }
    return summary;
  }

  const aToB = new Map();
  const bToA = new Map();
  const link = (a, b) => {
    aToB.set(a, b);
    bToA.set(b, a);
  };
  for (const entry of plan.keep) link(entry.a, entry.b);
  for (const copy of plan.copies) if (copy.a != null && copy.b != null) link(copy.a, copy.b);

  const secrets = {
    A: await readSecrets(side.A, plan.copies.filter((c) => c.from === 'A' && needsCredential(c.src)).map((c) => c.src.id), errors, label.A),
    B: await readSecrets(side.B, plan.copies.filter((c) => c.from === 'B' && needsCredential(c.src)).map((c) => c.src.id), errors, label.B),
  };
  const byId = { A: new Map(aList.map((s) => [s.id, s])), B: new Map(bList.map((s) => [s.id, s])) };
  const done = new Set();
  const failed = new Set();

  // 按跳板深度分批：同一批写完再写下一批，后面的才知道跳板在那边的新编号
  const depthOf = (copy) => jumpDepth(copy.src, byId[copy.from]);
  const levels = [...new Set(plan.copies.map(depthOf))].sort((x, y) => x - y);
  for (const level of levels) {
    const batch = { A: [], B: [] };
    for (const copy of plan.copies.filter((c) => depthOf(c) === level)) {
      const target = copy.from === 'A' ? 'B' : 'A';
      const targetId = target === 'A' ? copy.a : copy.b;
      let jump = null;
      if (copy.src.jump_server_id != null) {
        jump = (copy.from === 'A' ? aToB : bToA).get(copy.src.jump_server_id) ?? null;
        if (jump == null) {
          errors.push(`「${copy.src.name}」的跳板还没同步过去，下一轮再试`);
          failed.add(copy);
          continue;
        }
      }
      const credential = secrets[copy.from].get(copy.src.id);
      if (needsCredential(copy.src) && !credential) {
        failed.add(copy);
        continue;
      }
      const body = serverBody(copy.src, credential, jump, targetId != null ? byId[target].get(targetId) : undefined);
      batch[target].push({ copy, op: targetId == null ? { op: 'createServer', body } : { op: 'updateServer', id: targetId, body } });
    }
    for (const target of ['A', 'B']) {
      if (batch[target].length === 0) continue;
      const results = await side[target](batch[target].map((item) => item.op));
      results.forEach((result, index) => {
        const { copy, op } = batch[target][index];
        if (!result.ok) {
          errors.push(`写入 ${label[target]} 节点「${copy.src.name}」失败：${opError(result)}`);
          failed.add(copy);
          return;
        }
        if (op.op === 'createServer') {
          if (target === 'A') copy.a = result.data.id;
          else copy.b = result.data.id;
          link(copy.a, copy.b);
        }
        done.add(copy);
      });
    }
  }

  const deleted = new Set();
  for (const target of ['A', 'B']) {
    const items = plan.deletes.filter((item) => item.side === target);
    if (items.length === 0) continue;
    const results = await side[target](items.map((item) => ({ op: 'deleteServer', id: item.id })));
    results.forEach((result, index) => {
      if (result.ok || result.status === 404) deleted.add(`${target}:${items[index].id}`);
      else errors.push(`删除 ${label[target]} 节点服务器 #${items[index].id} 失败：${opError(result)}`);
    });
  }

  // 写过的重新读一遍，记下两边现在的 updated_at；没写成的保留旧对照（下一轮再试）
  const [freshA, freshB] = await Promise.all([side.A([{ op: 'listServers' }]), side.B([{ op: 'listServers' }])]);
  if (!freshA[0]?.ok || !freshB[0]?.ok) throw new Error('写完后重新读列表失败，对照表这一轮不更新');
  const nowA = new Map(freshA[0].data.map((s) => [s.id, s]));
  const nowB = new Map(freshB[0].data.map((s) => [s.id, s]));
  const next = plan.keep.map((entry) => ({ ...entry, stale: 0 }));
  for (const copy of done) {
    const a = nowA.get(copy.a);
    const b = nowB.get(copy.b);
    if (a && b) next.push({ a: a.id, b: b.id, ua: a.updated_at, ub: b.updated_at, stale: 0 });
  }
  for (const copy of failed) {
    const old = copy.b != null ? oldRows.get(copy.b) : null;
    // 主节点改过却没抄过去：这个节点上是旧的，新会话继续不放它
    if (old) next.push({ ...old, stale: copy.from === 'B' ? 1 : old.stale });
  }
  for (const item of plan.deletes) {
    if (deleted.has(`${item.side}:${item.id}`)) continue;
    const old = rows.find((row) => (item.side === 'A' ? row.a : row.b) === item.id);
    if (old) next.push(old);
  }
  await replaceMap(env, pair.node, 'server', next);
  return summary;
}

async function syncSnippets(env, pair, lists, dry, errors) {
  const { side, label } = pair;
  const [aList, bList] = lists;
  const rows = await mapRows(env, pair.node, 'snippet');
  const plan = planSnippets(aList, bList, rows);
  if (!deletesLookSafe(plan.deletes, aList.length, bList.length)) {
    throw new Error(`这一轮要删 ${plan.deletes.length} 条命令片段，像是读错了列表，不同步`);
  }
  const summary = {
    total: { [label.A]: aList.length, [label.B]: bList.length },
    unchanged: plan.keep.length,
    copies: plan.copies.map((copy) => `${label[copy.from]}→${label[copy.from === 'A' ? 'B' : 'A']} ${copy.src.name}`),
    deletes: plan.deletes.map((item) => `${label[item.side]} #${item.id}`),
  };
  if (dry) return summary;
  if (plan.copies.length === 0 && plan.deletes.length === 0) {
    if (plan.keep.length !== rows.length) await replaceMap(env, pair.node, 'snippet', plan.keep);
    return summary;
  }
  const done = [];
  for (const target of ['A', 'B']) {
    const copies = plan.copies.filter((copy) => (copy.from === 'A' ? 'B' : 'A') === target);
    const deletes = plan.deletes.filter((item) => item.side === target);
    const ops = [
      ...copies.map((copy) => {
        const id = target === 'A' ? copy.a : copy.b;
        return id == null ? { op: 'createSnippet', body: snippetBody(copy.src) } : { op: 'updateSnippet', id, body: snippetBody(copy.src) };
      }),
      ...deletes.map((item) => ({ op: 'deleteSnippet', id: item.id })),
    ];
    if (ops.length === 0) continue;
    const results = await side[target](ops);
    copies.forEach((copy, index) => {
      const result = results[index];
      if (!result.ok) return errors.push(`写入 ${label[target]} 节点命令片段「${copy.src.name}」失败：${opError(result)}`);
      if (target === 'A' && copy.a == null) copy.a = result.data.id;
      if (target === 'B' && copy.b == null) copy.b = result.data.id;
      done.push(copy);
    });
    deletes.forEach((item, index) => {
      const result = results[copies.length + index];
      if (!result.ok && result.status !== 404) errors.push(`删除 ${label[target]} 节点命令片段 #${item.id} 失败：${opError(result)}`);
    });
  }
  const [freshA, freshB] = await Promise.all([side.A([{ op: 'listSnippets' }]), side.B([{ op: 'listSnippets' }])]);
  if (!freshA[0]?.ok || !freshB[0]?.ok) throw new Error('写完后重新读命令片段失败，对照表这一轮不更新');
  const nowA = new Map(freshA[0].data.map((s) => [s.id, s]));
  const nowB = new Map(freshB[0].data.map((s) => [s.id, s]));
  const next = [...plan.keep];
  for (const copy of done) {
    const a = nowA.get(copy.a);
    const b = nowB.get(copy.b);
    if (a && b) next.push({ a: a.id, b: b.id, ua: a.updated_at, ub: b.updated_at });
  }
  await replaceMap(env, pair.node, 'snippet', next);
  return summary;
}

async function syncAi(env, pair, metas, dry, errors) {
  const { side, label } = pair;
  const [a, b] = metas;
  const key = `ai_sync:${pair.node}`;
  // 第一版只有 A ↔ B，记在 ai_sync 下
  const state = (await kvGet(env, key)) ?? (pair.node === 'A' ? await kvGet(env, 'ai_sync') : null);
  if (!a.configured && !b.configured) return 'both-empty';
  let from = null;
  if (!a.configured) from = 'B';
  else if (!b.configured) from = 'A';
  else if (!state) {
    // 第一次：两边一样就只记下，不一样以新的为准
    if (a.base_url !== b.base_url || a.model !== b.model || a.api_key_last4 !== b.api_key_last4) from = b.updated_at >= a.updated_at ? 'B' : 'A';
  } else {
    const changedA = a.updated_at !== state.ua;
    const changedB = b.updated_at !== state.ub;
    if (changedB && (!changedA || b.updated_at >= a.updated_at)) from = 'B';
    else if (changedA) from = 'A';
  }
  const arrow = from ? `${label[from]}→${label[from === 'A' ? 'B' : 'A']}` : 'unchanged';
  if (dry) return arrow;
  if (from) {
    const [secret] = await side[from]([{ op: 'aiConfigSecret' }]);
    if (!secret.ok) {
      errors.push(`读 ${label[from]} 节点 AI 设置失败：${opError(secret)}`);
      return 'failed';
    }
    const [result] = await side[from === 'A' ? 'B' : 'A']([{ op: 'putAiConfig', body: secret.data }]);
    if (!result.ok) {
      errors.push(`写入 AI 设置失败：${opError(result)}`);
      return 'failed';
    }
  }
  const [[freshA], [freshB]] = from ? await Promise.all([side.A([{ op: 'aiConfig' }]), side.B([{ op: 'aiConfig' }])]) : [[{ ok: true, data: a }], [{ ok: true, data: b }]];
  if (freshA.ok && freshB.ok) await kvSet(env, key, { ua: freshA.data.updated_at ?? null, ub: freshB.data.updated_at ?? null });
  return arrow;
}

const LIST_OPS = [{ op: 'listServers' }, { op: 'listSnippets' }, { op: 'aiConfig' }];

async function syncNode(env, node, home, homeLists, dry) {
  const report = { servers: null, snippets: null, ai: null, errors: [] };
  const pair = { node: node.name, label: { A: node.name, B: home.name }, side: { A: (ops) => nodeOps(env, node, ops), B: (ops) => nodeOps(env, home, ops) } };
  try {
    // 节点只调一次就拿到三样；读不了（额度用完、代理不通）就跳过这个节点
    const [servers, snippets, ai] = await pair.side.A(LIST_OPS);
    for (const [name, result] of Object.entries({ 服务器: servers, 命令片段: snippets, 'AI 设置': ai })) {
      if (!result?.ok) throw new Error(`读 ${node.name} 节点${name}失败：${opError(result)}`);
    }
    // 又能读了（额度刚重置时可能还报几分钟“超出”，那时会被暂停到第二天）：解除暂停
    await clearDown(env, node);
    report.servers = await syncServers(env, pair, [servers.data, homeLists[0]], dry, report.errors);
    report.snippets = await syncSnippets(env, pair, [snippets.data, homeLists[1]], dry, report.errors);
    report.ai = await syncAi(env, pair, [ai.data, homeLists[2]], dry, report.errors);
  } catch (error) {
    report.errors.push(describe(error));
    if (/exceed/i.test(describe(error))) await markDown(env, node, describe(error));
  }
  return report;
}

async function runSync(env, { dry = false, followUp = false } = {}) {
  await ensureSchema(env);
  const now = Date.now();
  const lock = await kvGet(env, 'sync_lock');
  if (!dry && lock && lock > now) {
    // 正在同步：记下来，那一轮做完再补一轮（否则这次改动要等下一次定时同步）
    await kvSet(env, 'sync_again', true);
    return { skipped: 'another sync is running; queued another pass' };
  }
  if (!dry) await kvSet(env, 'sync_lock', now + SYNC_LOCK_MS);
  const report = { at: now, dry, nodes: {}, errors: [] };
  const { list, home } = nodesOf(env);
  try {
    const homeResults = await nodeOps(env, home, LIST_OPS);
    homeResults.forEach((result, index) => {
      if (!result?.ok) throw new Error(`读主节点 ${home.name} 的${['服务器', '命令片段', 'AI 设置'][index]}失败：${opError(result)}`);
    });
    await clearDown(env, home);
    let homeLists = homeResults.map((result) => result.data);
    for (const node of list) {
      if (node === home) continue;
      report.nodes[node.name] = await syncNode(env, node, home, homeLists, dry);
      report.errors.push(...report.nodes[node.name].errors.map((error) => `${node.name}：${error}`));
      // 前一个节点可能往主节点抄了东西：下一个节点要看到最新的
      if (!dry && list.length > 2 && report.nodes[node.name].servers?.copies?.length) {
        homeLists = (await nodeOps(env, home, LIST_OPS)).map((result) => result.data);
      }
    }
  } catch (error) {
    report.errors.push(describe(error));
    if (/exceed/i.test(describe(error))) await markDown(env, home, describe(error));
  } finally {
    if (!dry) {
      await kvSet(env, 'last_sync', { ...report, errors: report.errors.slice(0, 20), finished: Date.now() });
      await kvSet(env, 'sync_lock', 0);
    }
  }
  if (!dry && (await kvGet(env, 'sync_again'))) {
    await kvSet(env, 'sync_again', false);
    if (!followUp) return runSync(env, { followUp: true });
  }
  return report;
}

/** 经网关改了数据后马上同步一次（经自身的服务绑定另起一次调用，不占这次请求的 CPU 时间） */
function triggerSync(env, ctx) {
  if (!env.SELF || !env.ADMIN_TOKEN) return;
  ctx.waitUntil(
    env.SELF.fetch(new Request('https://gateway.internal/__gateway/sync', { method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } })).catch(() => {})
  );
}

async function adminAuthorized(request, env) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match || typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.length < 32) return false;
  const [given, wanted] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1].trim())),
    crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(given, wanted);
}

async function status(env) {
  const { home, list } = nodesOf(env);
  const states = await nodeStates(env);
  const usage = await getUsage(env).catch(() => null);
  const lastSync = await kvGet(env, 'last_sync');
  const mapped = {};
  for (const node of list) {
    if (node === home) continue;
    const rows = await mapRows(env, node.name, 'server');
    mapped[node.name] = { servers: rows.length, stale: rows.filter((row) => row.stale).length };
  }
  const nodeA = states.find((state) => state.name === 'A');
  return {
    gateway: true,
    version: 2,
    policy: policyOf(env),
    // 当前生效的设置（custom：客户端里改过，不再是 wrangler 变量的默认值）
    settings: {
      policy: policyOf(env),
      order: nodesOf(env).order.map((node) => node.name),
      limit: defaultLimit(env),
      limits: Object.fromEntries(list.map((node) => [node.name, node.limit])),
      custom: Object.keys(settingsCache.value).length > 0,
    },
    home: home.name,
    next: chooseNode(states, policyOf(env)),
    nodes: states.map((state) => ({ name: state.name, home: state.node === home, ratio: state.ratio, gbs: state.gbs, limit: state.limit, down: state.down, mapped: mapped[state.name] ?? null })),
    lastSync,
    // 第一版客户端读这几项
    usage,
    aDown: nodeA?.down ?? null,
    mapped: { servers: Object.values(mapped).reduce((sum, item) => Math.max(sum, item.servers), 0), stale: Object.values(mapped).reduce((sum, item) => sum + item.stale, 0) },
  };
}

/** 手动暂停（维护、想先省着它）minutes 分钟后自动恢复；minutes 为 null 时解除暂停（不管是手动的还是出错造成的） */
async function setPause(env, node, minutes) {
  if (minutes == null) return kvSet(env, `down:${node.name}`, null);
  const span = Math.min(Math.max(Number(minutes) || 60, 1), 7 * 24 * 60);
  await kvSet(env, `down:${node.name}`, { until: Date.now() + span * 60_000, reason: '手动暂停', at: Date.now(), manual: true });
}

/** 客户端实例管理用的管理接口（/api/__gateway/…，要浏览器 / 客户端的登录） */
async function handleManage(request, env, url, path, method) {
  if (path === '/api/__gateway/settings' && (method === 'PUT' || method === 'DELETE')) {
    const next = method === 'PUT' ? cleanSettings(env, await request.json().catch(() => null)) : {};
    await kvSet(env, 'settings', next);
    settingsCache = { value: next, at: Date.now() };
    return json(await status(env));
  }
  if (path === '/api/__gateway/sync' && method === 'POST') {
    const report = await runSync(env);
    return json({ report, status: await status(env) });
  }
  if (path === '/api/__gateway/pause' && (method === 'POST' || method === 'DELETE')) {
    const node = nodesOf(env).byName.get(url.searchParams.get('node') ?? '');
    if (!node) return json({ error: 'unknown node' }, 400);
    await setPause(env, node, method === 'POST' ? Number(url.searchParams.get('minutes') ?? 60) : null);
    return json(await status(env));
  }
  if (path === '/api/__gateway/tokens') return handleTokens(request, env, url);
  return json({ error: 'Not Found' }, 404);
}

/** 管理：签发 / 列出 / 吊销给命令行、远程 MCP 用的长期令牌 */
async function handleTokens(request, env, url) {
  await ensureSchema(env);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare("SELECT label, kind, created, expires FROM sessions WHERE kind = 'api' ORDER BY created").all();
    return json(results);
  }
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const label = String(body.label ?? '').slice(0, 64) || 'token';
    const days = Number(body.days ?? 365);
    const token = await createSession(env, 'api', label, days > 0 ? days * 24 * 3600_000 : 0);
    return json({ label, token, expires: days > 0 ? Date.now() + days * 24 * 3600_000 : 0 });
  }
  if (request.method === 'DELETE') {
    const label = url.searchParams.get('label') ?? '';
    const { meta } = await env.DB.prepare("DELETE FROM sessions WHERE kind = 'api' AND label = ?").bind(label).run();
    authCache.clear();
    return json({ deleted: meta?.changes ?? 0 });
  }
  return json({ error: 'Method Not Allowed' }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    await loadSettings(env);

    // ---------- 管理接口（ADMIN_TOKEN） ----------
    if (path.startsWith('/__gateway/')) {
      if (!(await adminAuthorized(request, env))) return json({ error: 'Not Found' }, 404);
      if (path === '/__gateway/sync' && method === 'POST') return json(await runSync(env, { dry: url.searchParams.get('dry') === '1' }));
      if (path === '/__gateway/down' && (method === 'DELETE' || method === 'POST')) {
        const node = nodesOf(env).byName.get(url.searchParams.get('node') ?? '');
        if (!node) return json({ error: 'unknown node' }, 400);
        await setPause(env, node, method === 'POST' ? Number(url.searchParams.get('minutes') ?? 60) : null);
        return json({ ok: true });
      }
      // 第一版的管理接口
      if (path === '/__gateway/a-down' && method === 'DELETE') {
        await kvSet(env, 'down:A', null);
        return json({ ok: true });
      }
      if (path === '/__gateway/tokens') return handleTokens(request, env, url);
      return json({ error: 'Not Found' }, 404);
    }

    // ---------- 登录 ----------
    if (path === '/api/config' && method === 'GET') return handleConfig(request, env);
    if (path === '/api/auth/password/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
    if (path === '/api/auth/me' && method === 'GET') return (await authed(request, env)) ? json(GATEWAY_USER) : json({ error: 'Not authenticated' }, 401);
    if (path.startsWith('/api/auth/')) return json({ error: 'Not available through the gateway' }, 404);

    // ---------- 不用登录：网页、公开接口、分享 ----------
    const isApi = path === '/api' || path.startsWith('/api/');
    if (!isApi) return servePage(env, request);
    if (PUBLIC_API.has(path)) return toNode(env, nodesOf(env).home, request, { session: false });
    if (path === '/api/ssh' && (url.searchParams.has('share_ref') || url.searchParams.has('share_ticket'))) {
      if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
      return nodesOf(env).home.local ? env.LOCAL_APP.fetch(request) : wsToNode(env, nodesOf(env).home, request);
    }

    // ---------- 以下都要登录 ----------
    if (path === '/api/__gateway/status' && method === 'GET') {
      if (!(await authed(request, env)) && !(await adminAuthorized(request, env))) return json({ error: 'Authentication required' }, 401);
      return json(await status(env));
    }
    const kind = await authed(request, env);
    if (!kind) return json({ error: 'Authentication required' }, 401);
    // 浏览器发来的写操作与 WebSocket 只认网关自己的页面（命令行不带 Origin 时放行）
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
    if (path.startsWith('/api/__gateway/')) {
      // 改网关只认浏览器 / 客户端的登录：给命令行、远程 MCP 的长期令牌不能改设置、签新令牌
      if (kind === 'api') return json({ error: '长期令牌不能管理网关，请在客户端或网页里登录后操作' }, 403);
      return handleManage(request, env, url, path, method);
    }

    if (path === '/api/ssh' || path === '/api/ssh/sftp') {
      if (!origin) return new Response('Forbidden', { status: 403 });
      const node = wsHint(env, url, path);
      if (path === '/api/ssh' && url.searchParams.get('token') && node) return wsToNode(env, node, request);
      return wsAny(env, request, node);
    }

    const connect = /^\/api\/servers\/(\d+)\/connect$/.exec(path);
    if (connect && method === 'POST') return handleConnect(request, env, ctx, Number(connect[1]));

    if (path === '/api/known-hosts' && (method === 'POST' || method === 'DELETE')) {
      const text = await request.text();
      const response = await proxyData(request, env, text);
      // 确认新指纹后客户端马上重新连接，可能被放到别的节点：先写好再回应
      if (response.ok) await mirrorKnownHost(env, method, text).catch(() => {});
      return response;
    }

    const writes = method === 'POST' || method === 'PUT' || method === 'DELETE';
    const server = /^\/api\/servers(?:\/(\d+))?$/.exec(path);
    const response = await proxyData(request, env);
    if (writes && response.ok && (server || /^\/api\/snippets(?:\/\d+)?$/.test(path) || path === '/api/ai/config')) {
      // 改过的服务器在同步到各节点之前，新会话固定放主节点
      if (server?.[1]) {
        await ensureSchema(env);
        await env.DB.prepare("UPDATE nodemap SET stale = 1 WHERE kind = 'server' AND b = ?").bind(Number(server[1])).run();
      }
      triggerSync(env, ctx);
    }
    return response;
  },

  async scheduled(_event, env, ctx) {
    await loadSettings(env);
    ctx.waitUntil(Promise.all([runSync(env), getUsage(env, true).catch(() => null)]));
  },
};
