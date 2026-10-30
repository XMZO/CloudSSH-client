/**
 * CloudSSH 入口网关的 A 号代理：部署在另一个号（和那个号的 CloudSSH Worker 同一个 Cloudflare 账号），不改 CloudSSH 本身。
 *
 * 网关（gateway.js，部署在 B 号）能直接绑定 B 号的 CloudSSH，却碰不到另一个号的 Durable Object。这个代理用
 * Durable Object 跨脚本绑定直接调用本号 CloudSSH 用户数据库现有的内部接口（见 ops.js），替网关：
 * - 双向同步时列出、读写服务器和命令片段、AI 配置（读服务器凭据会把那台的“最近连接时间”改成现在）
 * - 把新会话放到本号时签发一次性连接令牌
 * - 签发本号的登录会话：本号开着“要求登录”时，网关转发 WebSocket 要带它
 *
 * 接口：POST /rpc，请求头 Authorization: Bearer <AGENT_TOKEN>，请求体 { "ops": [ { "op": "listServers" }, … ] }，
 * 返回 { "results": [ { ok, status, data }, … ] }（顺序与 ops 一致）。
 *
 * 配置（部署方法见 wrangler.agent.toml）：
 * - 绑定 USER_DB：本号 CloudSSH 的 UserDBDO（script_name 为本号 CloudSSH Worker 的名字）
 * - 变量 ROUTE_KEY：本号用户的路由键（/api/auth/me 里的 github_id；单管理员密码模式为 -1）
 * - 变量 USER_ID：本号用户的 id（/api/auth/me 里的 id）
 * - Secret AGENT_TOKEN：至少 32 个字符，网关里填同一串
 * 它能读出本号全部服务器凭据、能签发登录会话：AGENT_TOKEN 只放在这里和网关里，泄露了马上换。
 */
import { runOps, userDb } from './ops.js';

/** 每次最多几个操作：读凭据一个操作要调两次数据库，留在每次调用 1000 个内部子请求以内 */
const MAX_OPS = 200;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/rpc') return json({ error: 'Not Found' }, 404);
    if (typeof env.AGENT_TOKEN !== 'string' || env.AGENT_TOKEN.length < 32) {
      return json({ error: 'AGENT_TOKEN 没有设置或少于 32 个字符' }, 500);
    }
    if (!env.USER_DB || !env.ROUTE_KEY || !env.USER_ID) return json({ error: '缺少 USER_DB 绑定或 ROUTE_KEY / USER_ID 变量' }, 500);
    if (!(await tokenMatches(request.headers.get('Authorization'), env.AGENT_TOKEN))) return json({ error: 'Unauthorized' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求体不是 JSON' }, 400);
    }
    const ops = Array.isArray(body?.ops) ? body.ops : null;
    if (!ops || ops.length === 0 || ops.length > MAX_OPS) return json({ error: `ops 要 1～${MAX_OPS} 个` }, 400);

    const results = await runOps(userDb(env.USER_DB, env.ROUTE_KEY), Number(env.USER_ID), ops);
    return json({ results });
  },
};

/** 比较前先各自取 SHA-256，长度固定，再用恒时比较 */
async function tokenMatches(header, expected) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  const encoder = new TextEncoder();
  const [given, wanted] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1].trim())),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(given, wanted);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
