/**
 * CloudSSH 思考深度代理：一个独立的 Cloudflare Worker，放在 CloudSSH 与模型接口之间，不改 CloudSSH 本身。
 *
 * CloudSSH 的 Worker 调模型时只带 model / input / tools 等固定字段，不会带 reasoning.effort。
 * 客户端在每条消息末尾附一个标记 [cloudssh-reasoning:high]，这里转发前把所有标记删掉，
 * 按最后一个标记给请求加上 reasoning.effort（auto 表示不加，用服务商默认）。其余请求原样转发。
 *
 * 部署：Cloudflare Dashboard → Workers → 创建 → 粘贴本文件 → 部署；在“设置 → 变量”里加
 *   UPSTREAM = 原来在 CloudSSH 里填的 AI 接口地址（如 https://api.openai.com/v1）
 * 然后在 CloudSSH 的 AI 设置里把接口地址改成这个 Worker 的地址（如 https://xxx.workers.dev），并重新填一次 API 密钥。
 * 密钥只是经过这里转给 UPSTREAM，不保存、不记录；这里也只会转发到 UPSTREAM。
 */
const MARK = /\s*\[cloudssh-reasoning:(auto|none|minimal|low|medium|high|xhigh)\]/g;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'idempotency-key', 'openai-beta', 'openai-organization', 'openai-project'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 客户端检测：代理在不在、UPSTREAM 配了没有
    if (url.pathname.endsWith('/cloudssh-reasoning')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      return Response.json({ cloudsshReasoningProxy: 1, upstream: !!upstreamOf(env) }, { headers: CORS });
    }
    const upstream = upstreamOf(env);
    if (!upstream) return Response.json({ error: 'UPSTREAM is not set (https only)' }, { status: 500 });
    if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

    // 代理地址后面的路径接到 UPSTREAM 后面；两边都带 /v1 时只留一个
    const base = upstream.pathname.replace(/\/+$/, '');
    let path = url.pathname;
    if (base.endsWith('/v1') && (path === '/v1' || path.startsWith('/v1/'))) path = path.slice(3);
    const target = `${upstream.origin}${base}${path}${url.search}`;

    const headers = new Headers();
    for (const name of FORWARD_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let body;
    if (request.method === 'POST') {
      body = await request.text();
      if (/\/responses$/.test(path)) body = applyReasoning(body);
    }
    const response = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
    // 流式输出（SSE）原样往回传
    return new Response(response.body, response);
  },
};

function upstreamOf(env) {
  try {
    const url = new URL(String(env.UPSTREAM || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** 删掉请求里所有标记；最后一个标记决定 reasoning.effort */
function applyReasoning(text) {
  if (!text.includes('[cloudssh-reasoning:')) return text;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  let effort = null;
  const walk = (value) => {
    if (typeof value === 'string') {
      return value.replace(MARK, (_, level) => {
        effort = level;
        return '';
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = walk(value[key]);
    }
    return value;
  };
  payload.input = walk(payload.input);
  if (effort && effort !== 'auto') {
    const reasoning = payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning : {};
    payload.reasoning = { ...reasoning, effort };
  }
  return JSON.stringify(payload);
}
