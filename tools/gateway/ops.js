/**
 * CloudSSH 用户数据库（UserDBDO）的内部接口调用，入口网关（gateway.js，B 号）和 A 号代理（agent.js）共用。
 *
 * 只走 CloudSSH 现有的 /internal/* 路由（公开接口 /api/* 在 Worker 里做完登录校验后转给的就是它们），
 * 不改 CloudSSH 本身。调用方要先确认请求方可信（网关校验登录，代理校验密钥）：这些路由不再校验登录，
 * 能读出解密后的凭据、签发连接令牌和会话。
 */

/** 按路由键（GitHub ID；单管理员密码模式为 -1）取用户数据库 */
export function userDb(namespace, routeKey) {
  return namespace.get(namespace.idFromName(String(routeKey)));
}

async function call(stub, method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await stub.fetch(new Request(`http://internal${path}`, init));
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data };
}

/** 读一台服务器解密后的凭据：申请一次性连接令牌、马上兑换（会把这台的“最近连接时间”改成现在） */
async function readSecret(stub, userId, id) {
  const token = await call(stub, 'POST', `/internal/servers/${id}/connect`, { user_id: userId });
  if (!token.ok || typeof token.data?.token !== 'string') return token;
  const config = await call(stub, 'POST', '/internal/connect-token/consume', { token: token.data.token });
  if (!config.ok) return config;
  if (config.data?.serverId !== id) return { ok: false, status: 500, data: { error: 'server mismatch' } };
  return {
    ok: true,
    status: 200,
    data: {
      authMethod: config.data.authMethod,
      password: config.data.password ?? '',
      privateKey: config.data.privateKey ?? '',
      cfAccessClientSecret: config.data.cfAccessClientSecret ?? '',
    },
  };
}

/** 执行一个操作，返回 { ok, status, data }（data 为接口返回的 JSON） */
export async function runOp(stub, userId, op) {
  const id = Number(op?.id);
  switch (op?.op) {
    case 'listServers':
      return call(stub, 'GET', `/internal/servers?user_id=${userId}`);
    case 'readSecret':
      return readSecret(stub, userId, id);
    case 'createServer':
      return call(stub, 'POST', '/internal/servers', { ...op.body, user_id: userId });
    case 'updateServer':
      return call(stub, 'PUT', `/internal/servers/${id}`, { ...op.body, user_id: userId });
    case 'deleteServer':
      return call(stub, 'DELETE', `/internal/servers/${id}`, { user_id: userId });
    case 'connect':
      return call(stub, 'POST', `/internal/servers/${id}/connect`, { user_id: userId });
    case 'listSnippets':
      return call(stub, 'GET', `/internal/snippets?user_id=${userId}`);
    case 'createSnippet':
      return call(stub, 'POST', '/internal/snippets', { ...op.body, user_id: userId });
    case 'updateSnippet':
      return call(stub, 'PUT', `/internal/snippets/${id}`, { ...op.body, user_id: userId });
    case 'deleteSnippet':
      return call(stub, 'DELETE', `/internal/snippets/${id}`, { user_id: userId });
    case 'aiConfig':
      return call(stub, 'GET', `/internal/ai-config?user_id=${userId}`);
    case 'aiConfigSecret':
      return call(stub, 'GET', `/internal/ai-config/decrypt?user_id=${userId}`);
    case 'putAiConfig':
      return call(stub, 'PUT', '/internal/ai-config', { ...op.body, user_id: userId });
    case 'upsertKnownHost':
      return call(stub, 'POST', '/internal/known-hosts', { user_id: userId, host: op.host, port: op.port, fingerprint: op.fingerprint });
    case 'deleteKnownHost':
      return call(stub, 'DELETE', '/internal/known-hosts', { user_id: userId, host: op.host, port: op.port });
    case 'createSession':
      return call(stub, 'POST', '/internal/session/create', { user_id: userId });
    default:
      return { ok: false, status: 400, data: { error: `unknown op ${op?.op}` } };
  }
}

/** 依次执行一批操作（一次调用里做完，少占子请求数） */
export async function runOps(stub, userId, ops) {
  const results = [];
  for (const op of ops) {
    try {
      results.push(await runOp(stub, userId, op));
    } catch (error) {
      results.push({ ok: false, status: 500, data: { error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return results;
}
