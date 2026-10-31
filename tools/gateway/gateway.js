/**
 * CloudSSH 入口网关：部署在 B 号（和 B 号的 CloudSSH Worker 同一个 Cloudflare 账号），不改两边的 CloudSSH。
 *
 * Cloudflare 免费额度按账号算，SSH 会话开着就一直占 Durable Object 时长，一个号一天大约够所有标签页开 29 个小时。
 * 网关把两个号合成一个入口：客户端（或浏览器、命令行）只连它，用法和直接连 CloudSSH 一样。
 *
 * - 普通接口（登录、服务器列表、增删改、命令片段、AI 设置……）原样转给 B 号的 CloudSSH，登录也是 B 号的登录
 * - 新会话放哪边（POST /api/servers/:id/connect）：B 号存着数据，它的额度用完整个入口就用不了了，所以默认先用 A 号，
 *   A 今天用到 A_LIMIT（默认 90%）或最近出过错就放 B（POLICY=even 时放今天用得少的那边）。放 A 时由 A 号代理
 *   （agent.js）签发 A 的一次性连接令牌，返回的连接地址仍是网关自己
 * - WebSocket（/api/ssh）：连接令牌以路由键开头（B 号单管理员密码模式是 -1，A 号是 GitHub ID），按它转给对应那边，
 *   原样转发、不经过网关的代码；转给 A 时带上 A 号代理签发的登录会话（A 开着“要求登录”）。断线恢复和 SFTP 附加
 *   从请求里看不出在哪边，按“新会话会放的那边”先试，不行再试另一边
 * - 主机指纹的增删同时写到 A（经过跳板的记录里带着服务器 ID，换成 A 那边的），免得确认新指纹后连到 A 又报不符
 * - 双向同步（每 5 分钟、以及经网关改动服务器 / 命令片段 / AI 设置之后）：服务器（连同凭据、跳板关系）、命令片段、
 *   AI 设置，规则见 sync.js。刚在网关里改过、还没同步到 A 的服务器，新会话固定放 B
 * - 状态：GET /api/__gateway/status（要登录）返回两边今天的用量、新会话会放哪边、最近一次同步
 *
 * 不同步：Agent 的工作记录和知识（各自留在会话所在那边）、主机指纹的自动记录（各自第一次连时记下）、分享。
 *
 * 绑定与配置见 wrangler.gateway.toml。D1 里存对照表、A 号登录会话、用量缓存和最近一次同步结果。
 */
import { runOps, userDb } from './ops.js';
import {
  chooseBackend,
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
const A_DOWN_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 3600_000;
/** A 号登录会话剩不到一天就换新的 */
const SESSION_REFRESH_MS = 24 * 3600_000;
const AUTH_CACHE_MS = 2 * 60_000;
const SYNC_LOCK_MS = 2 * 60_000;
/** Durable Object 按 128 MB 计费；免费额度每天 13,000 GB-s */
const DO_GB = 0.125;
const FREE_GBS = 13_000;
/** A 号代理每次最多几个操作（与 agent.js 的 MAX_OPS 一致） */
const AGENT_BATCH = 200;
const WS_FORWARD_HEADERS = ['upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'user-agent'];

function config(env) {
  return {
    aOrigin: new URL(env.A_ORIGIN).origin,
    bRouteKey: String(env.B_ROUTE_KEY ?? '-1'),
    bUserId: Number(env.B_USER_ID ?? 1),
    policy: env.POLICY === 'even' ? 'even' : 'fill',
    limit: Number(env.A_LIMIT ?? 0.9),
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const describe = (error) => (error instanceof Error ? error.message : String(error));

// ---------- D1：对照表与小状态 ----------

let schemaReady = null;
function ensureSchema(env) {
  schemaReady ??= env.DB.batch([
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS map (kind TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, ua TEXT NOT NULL, ub TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, b))'
    ),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
  ]).catch((error) => {
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

async function mapRows(env, kind) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare('SELECT a, b, ua, ub, stale FROM map WHERE kind = ?').bind(kind).all();
  return results;
}

async function replaceMap(env, kind, rows) {
  const statements = [env.DB.prepare('DELETE FROM map WHERE kind = ?').bind(kind)];
  for (const row of rows) {
    statements.push(
      env.DB.prepare('INSERT INTO map (kind, a, b, ua, ub, stale) VALUES (?, ?, ?, ?, ?, ?)').bind(kind, row.a, row.b, row.ua, row.ub, row.stale ? 1 : 0)
    );
  }
  await env.DB.batch(statements);
}

// ---------- 两边的数据库操作 ----------

/** 经 A 号代理执行一批操作；代理本身不通（网络、密钥不对）时抛错 */
async function agentOps(env, ops) {
  const results = [];
  for (let index = 0; index < ops.length; index += AGENT_BATCH) {
    const response = await fetch(new URL('/rpc', env.A_AGENT_URL), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AGENT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: ops.slice(index, index + AGENT_BATCH) }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.results)) throw new Error(`A 号代理：${body?.error ?? `HTTP ${response.status}`}`);
    results.push(...body.results);
  }
  return results;
}

function sides(env) {
  const cfg = config(env);
  const stub = userDb(env.B_DB, cfg.bRouteKey);
  return { A: (ops) => agentOps(env, ops), B: (ops) => runOps(stub, cfg.bUserId, ops) };
}

const opError = (result) => result?.data?.error ?? `HTTP ${result?.status}`;

// ---------- 用量与 A 号可用性 ----------

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

/** 两边今天（UTC）的 Durable Object 时长，缓存 3 分钟；没配统计令牌的那边不填 */
async function getUsage(env, force = false) {
  const cached = await kvGet(env, 'usage');
  if (!force && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached;
  const result = { at: Date.now() };
  await Promise.all(
    ['A', 'B'].map(async (side) => {
      const token = env[`${side}_ANALYTICS_TOKEN`];
      const account = env[`${side}_ACCOUNT_ID`];
      if (!token || !account) return;
      try {
        result[side] = await accountUsage(token, account);
      } catch (error) {
        result[side] = { error: describe(error) };
      }
    })
  );
  await kvSet(env, 'usage', result);
  return result;
}

async function aDownUntil(env) {
  const down = await kvGet(env, 'a_down');
  return down && down.until > Date.now() ? down : null;
}

/** A 出错：额度用完（报错里有 exceeded）停到下一个 UTC 0 点，其他错误停 10 分钟 */
async function markADown(env, reason) {
  const until = /exceed/i.test(reason) ? nextUtcMidnight() : Date.now() + A_DOWN_MS;
  await kvSet(env, 'a_down', { until, reason: String(reason).slice(0, 300), at: Date.now() });
}

async function decide(env) {
  const cfg = config(env);
  const [usage, down] = await Promise.all([getUsage(env).catch(() => null), aDownUntil(env)]);
  return { backend: chooseBackend({ policy: cfg.policy, limit: cfg.limit, usage, aDown: !!down }), usage, down };
}

/** A 号登录会话（网关转发到 A 的 WebSocket 要带）：存在 D1，剩不到一天时请代理签新的 */
async function aSession(env, renew = false) {
  const cached = renew ? null : await kvGet(env, 'a_session');
  if (cached?.token && cached.expires - Date.now() > SESSION_REFRESH_MS) return cached.token;
  const [result] = await agentOps(env, [{ op: 'createSession' }]);
  if (!result?.ok || typeof result.data?.token !== 'string') throw new Error(`签发 A 号会话失败：${opError(result)}`);
  await kvSet(env, 'a_session', { token: result.data.token, expires: Date.now() + SESSION_TTL_MS });
  return result.data.token;
}

// ---------- 登录校验 ----------

const authCache = new Map();

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** 网关自己的功能（把会话放到 A、看状态）要先确认是 B 号登录着的用户：问 B 的 /api/auth/me，结果缓存 2 分钟 */
async function verifyUser(request, env) {
  const session = cookieValue(request.headers.get('Cookie'), 'session');
  if (!session) return false;
  const hit = authCache.get(session);
  if (hit && hit > Date.now()) return true;
  const response = await env.B_APP.fetch(new Request(new URL('/api/auth/me', request.url), { headers: { Cookie: `session=${session}` } }));
  if (!response.ok) return false;
  if (authCache.size > 100) authCache.clear();
  authCache.set(session, Date.now() + AUTH_CACHE_MS);
  return true;
}

// ---------- 转发 ----------

/**
 * 转给 B：原样转发，地址仍是网关自己的（服务绑定只认绑定、不看地址）。B 照常按这个地址校验同源、生成连接地址和
 * 分享链接，链接也就是网关的域名。body 是已经读出来的请求体（主机指纹要读两次）
 */
function forwardToB(request, env, body) {
  if (body === undefined) return env.B_APP.fetch(request);
  return env.B_APP.fetch(new Request(request.url, { method: request.method, headers: request.headers, body }));
}

/** WebSocket 转给 B：返回的 101 由运行时直接接上，消息不经过网关代码 */
function wsToB(request, env) {
  return env.B_APP.fetch(request);
}

/** WebSocket 转给 A：带上 A 号登录会话；A 说没登录（会话被清掉了）就换个新会话再试一次 */
async function wsToA(request, env, retry = true) {
  const cfg = config(env);
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of WS_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Origin', cfg.aOrigin);
  headers.set('Cookie', `session=${await aSession(env, !retry)}`);
  const response = await fetch(new Request(`${cfg.aOrigin}${url.pathname}${url.search}`, { headers }));
  if (response.status === 401 && retry) return wsToA(request, env, false);
  return response;
}

/** 断线恢复、SFTP 附加：看不出会话在哪边，先试新会话会放的那边，不是 101 再试另一边 */
async function wsEither(request, env) {
  const { backend, down } = await decide(env);
  const order = down ? ['B'] : backend === 'A' ? ['A', 'B'] : ['B', 'A'];
  let last = null;
  for (const side of order) {
    try {
      const response = side === 'A' ? await wsToA(request, env) : await wsToB(request, env);
      if (response.status === 101) return response;
      last = response;
    } catch (error) {
      last = json({ error: describe(error) }, 502);
    }
  }
  return last;
}

// ---------- 新会话 ----------

async function handleConnect(request, env, ctx, bId) {
  if (!(await verifyUser(request, env))) return forwardToB(request, env);
  const self = new URL(request.url);
  const wsBase = `${self.protocol === 'https:' ? 'wss:' : 'ws:'}//${self.host}`;
  const { backend } = await decide(env);
  if (backend === 'A') {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT a, stale FROM map WHERE kind = 'server' AND b = ?").bind(bId).first();
    if (row && !row.stale) {
      try {
        const [result] = await agentOps(env, [{ op: 'connect', id: row.a }]);
        if (result?.ok && typeof result.data?.token === 'string') {
          // WebSocket 马上就来，先把 A 号登录会话备好
          await aSession(env);
          // B 的列表按最近连接排序：在 B 上也记一下这次连接（B 签的令牌没人用，60 秒后作废）
          ctx.waitUntil(sides(env).B([{ op: 'connect', id: bId }]).catch(() => {}));
          return json({ wsUrl: `${wsBase}/api/ssh?token=${result.data.token}`, backend: 'A' });
        }
        if (result?.status >= 500) await markADown(env, opError(result));
      } catch (error) {
        await markADown(env, describe(error));
      }
    }
  }
  const response = await forwardToB(request, env);
  if (!response.ok) return response;
  const data = await response.json();
  if (typeof data.wsUrl === 'string') {
    const wsUrl = new URL(data.wsUrl);
    data.wsUrl = `${wsBase}${wsUrl.pathname}${wsUrl.search}`;
  }
  return json({ ...data, backend: 'B' });
}

// ---------- 主机指纹同时写到 A ----------

async function mirrorKnownHost(env, method, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof body?.host !== 'string' || body.port == null) return;
  const rows = await mapRows(env, 'server');
  const toA = new Map(rows.map((row) => [row.b, row.a]));
  const host = translateHostIdentity(body.host, (id) => toA.get(id));
  if (host == null) return;
  const op =
    method === 'DELETE'
      ? { op: 'deleteKnownHost', host, port: body.port }
      : { op: 'upsertKnownHost', host, port: body.port, fingerprint: body.fingerprint };
  await agentOps(env, [op]);
}

// ---------- 双向同步 ----------

async function readSecrets(run, ids, errors, side) {
  const secrets = new Map();
  if (ids.length === 0) return secrets;
  const results = await run(ids.map((id) => ({ op: 'readSecret', id })));
  results.forEach((result, index) => {
    if (result.ok) secrets.set(ids[index], result.data);
    else errors.push(`读 ${side} 号服务器 #${ids[index]} 的凭据失败：${opError(result)}`);
  });
  return secrets;
}

async function syncServers(env, side, lists, dry, errors) {
  const [aList, bList] = lists;
  const rows = await mapRows(env, 'server');
  if (rows.length > 0 && (aList.length === 0 || bList.length === 0)) throw new Error('有一边读回空的服务器列表，这一轮不同步');
  const plan = planServers(aList, bList, rows);
  if (!deletesLookSafe(plan.deletes, aList.length, bList.length)) {
    throw new Error(`这一轮要删 ${plan.deletes.length} 台服务器，像是读错了列表，不同步`);
  }
  const summary = {
    total: { A: aList.length, B: bList.length },
    unchanged: plan.keep.length,
    copies: plan.copies.map((copy) => `${copy.from}→${copy.from === 'A' ? 'B' : 'A'} ${copy.src.name}${(copy.from === 'A' ? copy.b : copy.a) == null ? '（新建）' : ''}`),
    deletes: plan.deletes.map((item) => `${item.side} #${item.id}`),
  };
  const oldRows = new Map(rows.map((row) => [row.b, row]));
  if (dry) return summary;
  if (plan.copies.length === 0 && plan.deletes.length === 0) {
    // 没事可做：只把新配上的对照记下来（初次对照、或两边各自手动建了一样的）
    if (plan.keep.length !== rows.length || rows.some((row) => row.stale)) {
      await replaceMap(env, 'server', plan.keep.map((entry) => ({ ...entry, stale: 0 })));
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
    A: await readSecrets(side.A, plan.copies.filter((c) => c.from === 'A' && needsCredential(c.src)).map((c) => c.src.id), errors, 'A'),
    B: await readSecrets(side.B, plan.copies.filter((c) => c.from === 'B' && needsCredential(c.src)).map((c) => c.src.id), errors, 'B'),
  };
  const byId = { A: new Map(aList.map((s) => [s.id, s])), B: new Map(bList.map((s) => [s.id, s])) };
  const done = new Set();
  const failed = new Set();

  // 按跳板深度分批：同一批写完再写下一批，后面的才知道跳板在那边的新 ID
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
          errors.push(`写入${target}号「${copy.src.name}」失败：${opError(result)}`);
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
      else errors.push(`删除${target}号服务器 #${items[index].id} 失败：${opError(result)}`);
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
    // B 改过却没抄到 A：A 上是旧的，新会话继续放 B
    if (old) next.push({ ...old, stale: copy.from === 'B' ? 1 : old.stale });
  }
  for (const item of plan.deletes) {
    if (deleted.has(`${item.side}:${item.id}`)) continue;
    const old = rows.find((row) => (item.side === 'A' ? row.a : row.b) === item.id);
    if (old) next.push(old);
  }
  await replaceMap(env, 'server', next);
  return summary;
}

async function syncSnippets(env, side, lists, dry, errors) {
  const [aList, bList] = lists;
  const rows = await mapRows(env, 'snippet');
  const plan = planSnippets(aList, bList, rows);
  if (!deletesLookSafe(plan.deletes, aList.length, bList.length)) {
    throw new Error(`这一轮要删 ${plan.deletes.length} 条命令片段，像是读错了列表，不同步`);
  }
  const summary = {
    total: { A: aList.length, B: bList.length },
    unchanged: plan.keep.length,
    copies: plan.copies.map((copy) => `${copy.from}→${copy.from === 'A' ? 'B' : 'A'} ${copy.src.name}`),
    deletes: plan.deletes.map((item) => `${item.side} #${item.id}`),
  };
  if (dry) return summary;
  if (plan.copies.length === 0 && plan.deletes.length === 0) {
    if (plan.keep.length !== rows.length) await replaceMap(env, 'snippet', plan.keep);
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
      if (!result.ok) return errors.push(`写入${target}号命令片段「${copy.src.name}」失败：${opError(result)}`);
      if (target === 'A' && copy.a == null) copy.a = result.data.id;
      if (target === 'B' && copy.b == null) copy.b = result.data.id;
      done.push(copy);
    });
    deletes.forEach((item, index) => {
      const result = results[copies.length + index];
      if (!result.ok && result.status !== 404) errors.push(`删除${target}号命令片段 #${item.id} 失败：${opError(result)}`);
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
  await replaceMap(env, 'snippet', next);
  return summary;
}

async function syncAi(env, side, metas, dry, errors) {
  const [a, b] = metas;
  const state = await kvGet(env, 'ai_sync');
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
  if (dry) return from ? `${from}→${from === 'A' ? 'B' : 'A'}` : 'unchanged';
  if (from) {
    const [secret] = await side[from]([{ op: 'aiConfigSecret' }]);
    if (!secret.ok) {
      errors.push(`读 ${from} 号 AI 设置失败：${opError(secret)}`);
      return 'failed';
    }
    const [result] = await side[from === 'A' ? 'B' : 'A']([{ op: 'putAiConfig', body: secret.data }]);
    if (!result.ok) {
      errors.push(`写入 AI 设置失败：${opError(result)}`);
      return 'failed';
    }
  }
  const [[freshA], [freshB]] = from ? await Promise.all([side.A([{ op: 'aiConfig' }]), side.B([{ op: 'aiConfig' }])]) : [[{ ok: true, data: a }], [{ ok: true, data: b }]];
  if (freshA.ok && freshB.ok) await kvSet(env, 'ai_sync', { ua: freshA.data.updated_at ?? null, ub: freshB.data.updated_at ?? null });
  return from ? `${from}→${from === 'A' ? 'B' : 'A'}` : 'unchanged';
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
  const report = { at: now, dry, servers: null, snippets: null, ai: null, errors: [] };
  const side = sides(env);
  try {
    // A 号只调一次代理就拿到三样；A 读不了（额度用完、代理不通）就整轮跳过
    const [aServers, aSnippets, aAi] = await side.A([{ op: 'listServers' }, { op: 'listSnippets' }, { op: 'aiConfig' }]);
    const [bServers, bSnippets, bAi] = await side.B([{ op: 'listServers' }, { op: 'listSnippets' }, { op: 'aiConfig' }]);
    for (const [name, result] of Object.entries({ 'A 服务器': aServers, 'A 命令片段': aSnippets, 'A AI 设置': aAi, 'B 服务器': bServers, 'B 命令片段': bSnippets, 'B AI 设置': bAi })) {
      if (!result?.ok) throw new Error(`读${name}失败：${opError(result)}`);
    }
    // A 又能读了（额度刚重置时可能还报几分钟“超出”，那时会被暂停到第二天）：清掉暂停，新会话回到 A
    if (await aDownUntil(env)) await kvSet(env, 'a_down', null);
    report.servers = await syncServers(env, side, [aServers.data, bServers.data], dry, report.errors);
    report.snippets = await syncSnippets(env, side, [aSnippets.data, bSnippets.data], dry, report.errors);
    report.ai = await syncAi(env, side, [aAi.data, bAi.data], dry, report.errors);
  } catch (error) {
    report.errors.push(describe(error));
    if (/exceed/i.test(describe(error))) await markADown(env, describe(error));
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
  const encoder = new TextEncoder();
  const [given, wanted] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1].trim())),
    crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(given, wanted);
}

async function status(env) {
  const cfg = config(env);
  const { backend, usage, down } = await decide(env);
  const [lastSync, servers] = await Promise.all([kvGet(env, 'last_sync'), mapRows(env, 'server')]);
  return {
    gateway: true,
    policy: cfg.policy,
    limit: cfg.limit,
    next: backend,
    usage,
    aDown: down,
    mapped: { servers: servers.length, stale: servers.filter((row) => row.stale).length },
    lastSync,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/__gateway/sync' && method === 'POST') {
      if (!(await adminAuthorized(request, env))) return json({ error: 'Not Found' }, 404);
      return json(await runSync(env, { dry: url.searchParams.get('dry') === '1' }));
    }
    // 管理：A 恢复了（比如换了号、额度提前恢复）不想等暂停到期时，清掉暂停标记
    if (path === '/__gateway/a-down' && method === 'DELETE') {
      if (!(await adminAuthorized(request, env))) return json({ error: 'Not Found' }, 404);
      await kvSet(env, 'a_down', null);
      return json({ ok: true });
    }
    if (path === '/api/__gateway/status' && method === 'GET') {
      if (!(await verifyUser(request, env)) && !(await adminAuthorized(request, env))) return json({ error: 'Authentication required' }, 401);
      return json(await status(env));
    }

    if (path === '/api/ssh' || path === '/api/ssh/sftp') {
      // 与 CloudSSH 一样只接受网关自己页面发来的 WebSocket（转发时会把来源换成后端自己的，后端就查不出来了）
      if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    }
    if (path === '/api/ssh') {
      const token = url.searchParams.get('token');
      if (token) return token.split(':')[0] === config(env).bRouteKey ? wsToB(request, env) : wsToA(request, env);
      if (url.searchParams.get('session') && url.searchParams.get('resume_token')) return wsEither(request, env);
      return wsToB(request, env);
    }
    if (path === '/api/ssh/sftp') return wsEither(request, env);

    const connect = /^\/api\/servers\/(\d+)\/connect$/.exec(path);
    if (connect && method === 'POST') return handleConnect(request, env, ctx, Number(connect[1]));

    if (path === '/api/known-hosts' && (method === 'POST' || method === 'DELETE')) {
      const text = await request.text();
      const response = await forwardToB(request, env, text);
      // 确认新指纹后客户端马上重新连接，可能被放到 A：先写好 A 再回应
      if (response.ok && (await verifyUser(request, env))) await mirrorKnownHost(env, method, text).catch(() => {});
      return response;
    }

    const writes = method === 'POST' || method === 'PUT' || method === 'DELETE';
    const server = /^\/api\/servers(?:\/(\d+))?$/.exec(path);
    const response = await forwardToB(request, env);
    if (writes && response.ok && (server || /^\/api\/snippets(?:\/\d+)?$/.test(path) || path === '/api/ai/config')) {
      // 改过的服务器在同步到 A 之前，新会话固定放 B
      if (server?.[1]) {
        await ensureSchema(env);
        await env.DB.prepare("UPDATE map SET stale = 1 WHERE kind = 'server' AND b = ?").bind(Number(server[1])).run();
      }
      triggerSync(env, ctx);
    }
    return response;
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([runSync(env), getUsage(env, true).catch(() => null)]));
  },
};
