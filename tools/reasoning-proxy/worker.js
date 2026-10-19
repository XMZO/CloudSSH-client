/**
 * CloudSSH AI 增强代理：一个独立的 Cloudflare Worker，放在 CloudSSH 与模型接口之间，不改 CloudSSH 本身。
 *
 * CloudSSH 的 Worker 调模型时只带 model / input / tools 等固定字段。客户端在每条消息末尾附指令标签，
 * 这里转发前把所有标签删掉，按最后一个标签改写请求：
 * - <cloudssh_reasoning effort="high"/>：加上 reasoning.effort（auto 表示不加，用服务商默认）
 * - <cloudssh_web_search mode="on"/>：加上模型自己的原生联网搜索工具（off 表示不加）
 * 标签也可能出现在 Worker 整理上下文时嵌进去的 JSON 文本里（引号被转义成 \"），一并识别；
 * 旧版客户端（0.3.23）的 [cloudssh-reasoning:high] 写法同样识别。其余请求原样转发。
 *
 * 联网搜索：模型在接口那边搜索（内置工具），结果里会多出 web_search_call 这类条目；CloudSSH 的 Worker 只接受
 * 消息、函数调用和推理条目，所以这里把其他条目从最终结果里去掉（流式输出只改 response.completed 那一帧），
 * 带引用的回答照常保留。接口不支持搜索（400 / 422）时自动去掉搜索工具重发一次。搜索工具默认：
 * - UPSTREAM 是 OpenRouter：{"type":"openrouter:web_search","parameters":{"engine":"native"}}（优先用各家原生搜索）
 * - 其他：OpenAI Responses 的 {"type":"web_search"}（中转把它转成 Claude / Gemini 原生搜索要中转自己支持）
 * 可以用变量 WEB_SEARCH 改：off 表示不加；一个 JSON 对象表示所有模型都用它；也可以按模型名分开，例如
 *   {"claude":{"type":"web_search_20250305","name":"web_search","max_uses":5},"gemini":{"type":"google_search"},"default":{"type":"web_search"}}
 * （键是模型名里包含的字样，按顺序匹配，default 兜底）
 *
 * 部署：Cloudflare Dashboard → Workers → 创建 → 粘贴本文件 → 部署；在“设置 → 变量”里加
 *   UPSTREAM = 原来在 CloudSSH 里填的 AI 接口地址（如 https://api.openai.com/v1）
 * 然后在 CloudSSH 的 AI 设置里把接口地址改成这个 Worker 的地址，并重新填一次 API 密钥。
 * 注意：Cloudflare 不允许同一区域（zone）内的 Worker 互相请求（错误 1042 / 522），代理不要放在与 CloudSSH
 * 相同的域名下；建议用另一个域名或另一个 Cloudflare 账号。
 * 密钥只是经过这里转给 UPSTREAM，不保存、不记录；这里也只会转发到 UPSTREAM。
 *
 * 验证：每个 /responses 请求在 Worker 日志里记一行（只有档位、搜索、模型、状态码和接口回报的 token 用量，
 * 不含密钥与对话内容），在 Cloudflare 控制台这个 Worker 的“日志”里能看到，例如
 *   {"cloudsshReasoning":"high","applied":true,"webSearch":"on","searches":2,"model":"gpt-5","status":200,
 *    "reasoningTokens":812,"inputTokens":9120,"cachedTokens":7680,"cacheHit":"84%"}
 */
const VERSION = 3;
const LEVEL = '(auto|none|minimal|low|medium|high|xhigh)';
const REASONING_TAG = new RegExp(`\\s*(?:<cloudssh_reasoning\\s+effort=\\\\*"${LEVEL}\\\\*"\\s*/>|\\[cloudssh-reasoning:${LEVEL}\\])`, 'g');
const SEARCH_TAG = /\s*<cloudssh_web_search\s+mode=\\*"(on|off)\\*"\s*\/>/g;
/** CloudSSH 的 Worker 接受的结果条目；其他（搜索等内置工具）去掉 */
const KEPT_ITEMS = new Set(['message', 'function_call', 'reasoning']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'idempotency-key', 'openai-beta', 'openai-organization', 'openai-project'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 客户端检测：代理在不在、版本（2 起认正式标签，3 起支持联网搜索）、UPSTREAM 配了没有
    if (url.pathname.endsWith('/cloudssh-reasoning')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const search = searchSetting(env) !== 'off';
      return Response.json(
        { cloudsshReasoningProxy: VERSION, upstream: !!upstreamOf(env), features: search ? ['reasoning', 'web_search'] : ['reasoning'] },
        { headers: CORS }
      );
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
    if (request.method !== 'POST' || !/\/responses$/.test(path)) {
      const body = request.method === 'POST' ? await request.text() : undefined;
      const response = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
      return new Response(response.body, response);
    }

    const result = applyDirectives(await request.text(), env, upstream);
    const record = {
      cloudsshReasoning: result.effort ?? 'none',
      applied: result.applied,
      webSearch: result.search ? 'on' : result.searchMode === 'on' ? 'skipped' : 'off',
      searches: 0,
      model: result.model,
    };
    let response = await fetch(target, { method: 'POST', headers, body: result.body, redirect: 'manual' });
    // 接口不认搜索工具（或这个模型 / 档位不支持搜索）：去掉搜索工具重发一次
    if (result.search && (response.status === 400 || response.status === 422)) {
      void response.body?.cancel();
      record.webSearch = 'unsupported';
      response = await fetch(target, { method: 'POST', headers, body: result.bodyWithoutSearch, redirect: 'manual' });
    }
    let stream = response.body;
    let out = response;
    if (record.webSearch === 'on' && response.ok && stream) {
      // 把内置工具的条目从最终结果里去掉
      const sse = (response.headers.get('content-type') || '').includes('text/event-stream');
      stream = sse ? stripHostedSse(stream, record) : await stripHostedJson(response, record);
      const outHeaders = new Headers(response.headers);
      outHeaders.delete('content-length');
      outHeaders.delete('content-encoding');
      out = { status: response.status, statusText: response.statusText, headers: outHeaders };
    }
    // 一份往回传，另一份只用来读接口回报的 token 用量，记一行日志
    const [forward, copy] = stream ? stream.tee() : [null, null];
    const logged = logUsage(record, response.status, copy);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(logged);
    return new Response(forward, out);
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

/** 变量 WEB_SEARCH：'off'、一个工具对象、或按模型名分开的映射；没设为 null（用默认） */
function searchSetting(env) {
  const raw = String(env.WEB_SEARCH || '').trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'off') return 'off';
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 这个模型用哪个搜索工具；null 表示不加 */
function searchTool(env, upstream, model) {
  const setting = searchSetting(env);
  if (setting === 'off') return null;
  if (setting && typeof setting.type === 'string') return setting;
  if (setting) {
    const name = String(model || '').toLowerCase();
    for (const [key, tool] of Object.entries(setting)) {
      if (key !== 'default' && name.includes(key.toLowerCase())) return tool && typeof tool === 'object' ? tool : null;
    }
    if (setting.default && typeof setting.default === 'object') return setting.default;
  }
  return /(^|\.)openrouter\.ai$/i.test(upstream.hostname)
    ? { type: 'openrouter:web_search', parameters: { engine: 'native' } }
    : { type: 'web_search' };
}

/** 删掉请求里所有标签，按最后一个改写请求 */
function applyDirectives(text, env, upstream) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { body: text, bodyWithoutSearch: text, effort: null, applied: false, search: false, searchMode: null, model: null };
  }
  const model = typeof payload?.model === 'string' ? payload.model : null;
  let effort = null;
  let searchMode = null;
  if (text.includes('cloudssh_reasoning') || text.includes('[cloudssh-reasoning:') || text.includes('cloudssh_web_search')) {
    const walk = (value) => {
      if (typeof value === 'string') {
        return value
          .replace(REASONING_TAG, (_, tag, legacy) => {
            effort = tag || legacy;
            return '';
          })
          .replace(SEARCH_TAG, (_, mode) => {
            searchMode = mode;
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
  }
  const applied = !!effort && effort !== 'auto';
  if (applied) {
    const reasoning = payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning : {};
    payload.reasoning = { ...reasoning, effort };
  }
  const bodyWithoutSearch = JSON.stringify(payload);
  // 只给带函数工具的主对话加搜索；Worker 整理上下文、提炼记忆的结构化请求（text.format）不加
  const tool = searchMode === 'on' && Array.isArray(payload.tools) && !payload.text?.format ? searchTool(env, upstream, model) : null;
  if (!tool) return { body: bodyWithoutSearch, bodyWithoutSearch, effort, applied, search: false, searchMode, model };
  payload.tools = [...payload.tools, tool];
  return { body: JSON.stringify(payload), bodyWithoutSearch, effort, applied, search: true, searchMode, model };
}

function keptOutput(output, record) {
  const kept = output.filter((item) => KEPT_ITEMS.has(item?.type));
  record.searches += output.length - kept.length;
  return kept;
}

/** 流式输出：只改 response.completed / response.incomplete 那一帧里的结果条目，其余帧原样逐帧转发 */
function stripHostedSse(stream, record) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const rewrite = (frame) => {
    if (!frame.includes('response.completed') && !frame.includes('response.incomplete')) return frame;
    const lines = frame.split(/\r\n|\n|\r/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return frame;
    }
    if (!event?.response || !Array.isArray(event.response.output)) return frame;
    event.response.output = keptOutput(event.response.output, record);
    const other = lines.filter((line) => line && !line.startsWith('data:'));
    return `${[...other, `data: ${JSON.stringify(event)}`].join('\n')}\n\n`;
  };
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
          if (!boundary) break;
          const end = boundary.index + boundary[0].length;
          controller.enqueue(encoder.encode(rewrite(buffer.slice(0, end))));
          buffer = buffer.slice(end);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
      },
    })
  );
}

/** 非流式结果（JSON）：去掉内置工具的条目 */
async function stripHostedJson(response, record) {
  const text = await response.text();
  let body = text;
  try {
    const value = JSON.parse(text);
    if (value && Array.isArray(value.output)) {
      value.output = keptOutput(value.output, record);
      body = JSON.stringify(value);
    }
  } catch {
    // 不是 JSON：原样
  }
  return new Response(body).body;
}

/** 读完响应（只保留末尾一段，usage 在最后），取推理、输入与缓存命中的 token 数后记一行日志 */
async function logUsage(record, status, stream) {
  let tail = '';
  if (stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tail = (tail + decoder.decode(value, { stream: true })).slice(-65536);
      }
    } catch {
      // 客户端断开等：有多少算多少
    }
  }
  // 取最后一次出现的值（response.completed 里的 usage）
  const lastNumber = (key) => {
    const matches = [...tail.matchAll(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'g'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  const reasoningTokens = lastNumber('reasoning_tokens');
  const inputTokens = lastNumber('input_tokens');
  const cachedTokens = lastNumber('cached_tokens');
  const cacheHit = inputTokens && cachedTokens != null ? `${Math.round((cachedTokens / inputTokens) * 100)}%` : null;
  console.log(JSON.stringify({ ...record, status, reasoningTokens, inputTokens, cachedTokens, cacheHit }));
}
