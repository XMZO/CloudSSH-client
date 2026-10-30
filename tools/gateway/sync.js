/**
 * 入口网关的纯逻辑部分（不碰网络，test/sync.test.mjs 测它）：A、B 两边的双向同步计划、写入请求体、
 * 主机指纹路径里的服务器 ID 换算、新会话放哪边。
 *
 * 双向同步：对照表按“A 的 ID ↔ B 的 ID”记着每一对，以及上次同步时两边各自的 updated_at。
 * - 两边都在：只有一边变了就把它抄到另一边；两边都变了，updated_at 新的那边为准
 * - 只剩一边：另一边删了。剩下这边上次同步后没改过就跟着删；改过就以它为准重新建回去
 * - 还没对照过的：先按 ID 加内容、再按内容（服务器看名称、地址、端口、用户名；命令片段看名称和命令）配对，
 *   配上的以 updated_at 新的为准；配不上的抄到另一边
 * updated_at 是 SQLite 的 datetime('now')（UTC，“YYYY-MM-DD HH:MM:SS”），按字符串比较就是按时间比较。
 */

/** 服务器的“内容身份”：名称、地址、端口、用户名都一样就当作同一台 */
export const sameServer = (a, b) => a.name === b.name && a.host === b.host && a.port === b.port && a.username === b.username;
export const sameSnippet = (a, b) => a.name === b.name && a.command === b.command;

/**
 * 算出要做的事。map：[{ a, b, ua, ub }]。
 * 返回 { keep: 对照照旧的条目, copies: [{ from: 'A'|'B', src, a, b }]（a / b 为 null 表示那边要新建）,
 *       deletes: [{ side: 'A'|'B', id }] }
 */
export function planTwoWay(aList, bList, map, same) {
  const A = new Map(aList.map((item) => [item.id, item]));
  const B = new Map(bList.map((item) => [item.id, item]));
  const usedA = new Set();
  const usedB = new Set();
  const keep = [];
  const copies = [];
  const deletes = [];
  for (const entry of map) {
    const a = A.get(entry.a);
    const b = B.get(entry.b);
    if (a) usedA.add(a.id);
    if (b) usedB.add(b.id);
    if (a && b) {
      const changedA = a.updated_at !== entry.ua;
      const changedB = b.updated_at !== entry.ub;
      if (!changedA && !changedB) keep.push(entry);
      else if (changedB && (!changedA || b.updated_at >= a.updated_at)) copies.push({ from: 'B', src: b, a: a.id, b: b.id });
      else copies.push({ from: 'A', src: a, a: a.id, b: b.id });
    } else if (a) {
      if (a.updated_at !== entry.ua) copies.push({ from: 'A', src: a, a: a.id, b: null });
      else deletes.push({ side: 'A', id: a.id });
    } else if (b) {
      if (b.updated_at !== entry.ub) copies.push({ from: 'B', src: b, a: null, b: b.id });
      else deletes.push({ side: 'B', id: b.id });
    }
  }
  const freeA = aList.filter((item) => !usedA.has(item.id));
  const freeB = bList.filter((item) => !usedB.has(item.id));
  const pairedA = new Set();
  const pairedB = new Set();
  const pair = (a, b) => {
    pairedA.add(a.id);
    pairedB.add(b.id);
    if (a.updated_at === b.updated_at) keep.push({ a: a.id, b: b.id, ua: a.updated_at, ub: b.updated_at });
    else if (b.updated_at > a.updated_at) copies.push({ from: 'B', src: b, a: a.id, b: b.id });
    else copies.push({ from: 'A', src: a, a: a.id, b: b.id });
  };
  // 先配 ID 也一样的（两边从同一份数据恢复出来时 ID 相同），再只按内容配
  for (const b of freeB) {
    const a = freeA.find((item) => !pairedA.has(item.id) && item.id === b.id && same(item, b));
    if (a) pair(a, b);
  }
  for (const b of freeB) {
    if (pairedB.has(b.id)) continue;
    const a = freeA.find((item) => !pairedA.has(item.id) && same(item, b));
    if (a) pair(a, b);
  }
  for (const b of freeB) if (!pairedB.has(b.id)) copies.push({ from: 'B', src: b, a: null, b: b.id });
  for (const a of freeA) if (!pairedA.has(a.id)) copies.push({ from: 'A', src: a, a: a.id, b: null });
  return { keep, copies, deletes };
}

/** 跳板深度：直连为 0，经过一台跳板为 1……（关系成环或跳板不在列表里时到此为止） */
export function jumpDepth(server, byId) {
  let depth = 0;
  let current = server;
  const seen = new Set([server.id]);
  while (current.jump_server_id != null) {
    const parent = byId.get(current.jump_server_id);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
    depth++;
  }
  return depth;
}

/**
 * 服务器同步计划：跳板先写（深度小的在前），删的时候用别人当跳板的先删（深度大的在前），
 * 否则 CloudSSH 会拒绝删除还被引用的跳板、拒绝引用还不存在的跳板
 */
export function planServers(aList, bList, map) {
  const plan = planTwoWay(aList, bList, map, sameServer);
  const byA = new Map(aList.map((item) => [item.id, item]));
  const byB = new Map(bList.map((item) => [item.id, item]));
  const depthOf = (side, id) => {
    const list = side === 'A' ? byA : byB;
    const item = list.get(id);
    return item ? jumpDepth(item, list) : 0;
  };
  plan.copies.sort((x, y) => depthOf(x.from, x.src.id) - depthOf(y.from, y.src.id));
  plan.deletes.sort((x, y) => depthOf(y.side, y.id) - depthOf(x.side, x.id));
  return plan;
}

export function planSnippets(aList, bList, map) {
  return planTwoWay(aList, bList, map, sameSnippet);
}

/**
 * 防误删：列表读错（比如读回空列表）时不能把另一边清空。要删的超过 5 条且超过那边总数的 20% 就整轮放弃
 */
export function deletesLookSafe(deletes, aCount, bCount) {
  for (const side of ['A', 'B']) {
    const count = deletes.filter((item) => item.side === side).length;
    const total = side === 'A' ? aCount : bCount;
    if (count > 5 && count > total * 0.2) return false;
  }
  return true;
}

const isTunnel = (server) => server.transport_type === 'cf_tunnel';

/** 要不要读这台的凭据：有密码 / 私钥，或者 CF 隧道存了 Access 密钥 */
export function needsCredential(server) {
  return server.auth_method !== 'none' || (isTunnel(server) && server.has_cf_access_client_secret === true);
}

/**
 * 写到另一边的请求体（新建与修改共用，字段都带上，两边就一致）。jumpServerId 已换成目标那边的 ID。
 * current 是目标那边现在那条：来源没手动指定区域、目标却指定了时清掉；都没有时不带区域（免得每次重新推断）
 */
export function serverBody(server, credential, jumpServerId, current) {
  const body = {
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    auth_method: server.auth_method,
    tags: server.tags ?? [],
    jump_server_id: jumpServerId,
    transport_type: isTunnel(server) ? 'cf_tunnel' : 'direct',
  };
  if (server.auth_method === 'password') body.credential = credential?.password ?? '';
  else if (server.auth_method === 'publickey') body.credential = credential?.privateKey ?? '';
  if (isTunnel(server)) {
    body.cf_tunnel_host = server.cf_tunnel_host || server.host;
    body.cf_access_client_id = server.cf_access_client_id ?? '';
    body.cf_access_client_secret = server.has_cf_access_client_secret ? (credential?.cfAccessClientSecret ?? '') : '';
  }
  if (server.region) body.region = server.region;
  else if (current?.region) body.region = '';
  return body;
}

export function snippetBody(snippet) {
  return { name: snippet.name, command: snippet.command, category: snippet.category ?? '' };
}

/**
 * 主机指纹记录的“主机”一栏：直连是地址本身；经过跳板时是 jump:<ID>@<地址>:<端口>>…|<地址>，带着服务器 ID。
 * 抄到另一边时把里面的 ID 换成那边的；有一个换不了（那台还没同步过去）就返回 null，不抄
 */
export function translateHostIdentity(identity, mapId) {
  if (!identity.startsWith('jump:')) return identity;
  let missing = false;
  const translated = identity.replace(/(^jump:|>)(\d+)@/g, (_match, prefix, id) => {
    const next = mapId(Number(id));
    if (next == null) missing = true;
    return `${prefix}${next}@`;
  });
  return missing ? null : translated;
}

/**
 * 新会话放哪边。B 号存着数据（登录、服务器列表都靠它），它的额度用完整个入口就用不了了，所以默认先用 A：
 * A 今天用到 limit（默认 90%）或最近出过错就放 B。policy 为 even 时放今天用得少的那边（比例相同时放 A）。
 * usage：{ A: { ratio }, B: { ratio } }，拿不到时为 null
 */
export function chooseBackend({ policy = 'fill', limit = 0.9, usage = null, aDown = false }) {
  if (aDown) return 'B';
  const a = usage?.A?.ratio;
  const b = usage?.B?.ratio;
  if (a != null && a >= Math.min(limit, 1)) return 'B';
  if (policy === 'even' && a != null && b != null) return b < a ? 'B' : 'A';
  return 'A';
}

/** 下一个 UTC 0 点（Cloudflare 免费额度每天这时重置） */
export function nextUtcMidnight(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
