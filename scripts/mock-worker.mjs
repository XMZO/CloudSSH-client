#!/usr/bin/env node
/**
 * 假 Worker：不连真实服务器也能调试客户端界面（节点列表、终端、SFTP、常用命令）。
 *
 *   node scripts/mock-worker.mjs [端口，默认 8788]
 *   node scripts/mock-worker.mjs 8788 --ui packages/ui-web/dist   # 同时托管构建好的界面，浏览器直接打开调试
 *   node scripts/mock-worker.mjs 8788 --servers 90                 # 补足到 90 台服务器，看节点很多时的流畅度
 *   node scripts/mock-worker.mjs 8788 --anon                       # 未登录（匿名连接页），可走一遍模拟的 GitHub 登录
 *
 * 客户端把实例地址设为 http://127.0.0.1:8788（安卓模拟器可配合 adb reverse tcp:8788 tcp:8788）。
 * 带 --ui 时，非 /api 的 GET 请求返回该目录下的文件（找不到就返回 index.html），浏览器打开 http://127.0.0.1:8788 即可。
 * 提供：登录态、带分组的服务器列表、一次性连接、可交互的假 shell（help/ls/colors/seq/top…）、
 * SFTP 目录列表、命令片段增删改。全部数据在内存里，重启即恢复。仅用于本机开发，不要暴露到公网。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import nodePath from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const port = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 8788);
const uiArg = args.indexOf('--ui');
const uiDir = uiArg >= 0 && args[uiArg + 1] ? nodePath.resolve(args[uiArg + 1]) : null;
/** --mobile-shim：托管手机版构建时在 index.html 最前面插入 scripts/mock-tauri.js，浏览器里就能跑手机版界面 */
const mobileShim = args.includes('--mobile-shim');
const anonymous = args.includes('--anon');
const now = Date.now();

// ---------- 数据 ----------

let nextServerId = 100;
const server = (name, tags, host, extra = {}) => ({
  id: nextServerId++,
  user_id: 1,
  name,
  host,
  port: 22,
  username: 'root',
  auth_method: 'publickey',
  tags,
  os: 'debian',
  transport_type: 'direct',
  last_connected_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...extra,
});
const servers = [
  server('HK-A 香港一号', ['香港 🇭🇰'], '203.0.113.1', { last_connected_at: now - 1000, os: 'ubuntu' }),
  server('HK-B 香港二号', ['香港 🇭🇰'], '203.0.113.2', { os: 'alpine' }),
  // 还没识别系统：连上后像真 Worker 一样发 os_detected（识别成 Ubuntu），用来看图标即时更新
  server('HK-C 香港三号', ['香港 🇭🇰'], '203.0.113.3', { os: null }),
  server('JP-A 东京', ['日本 🇯🇵'], '198.51.100.1', { last_connected_at: now - 5000, os: 'centos' }),
  server('JP-B 大阪', ['日本 🇯🇵'], '198.51.100.2'),
  server('JP-C 名古屋', ['日本 🇯🇵'], '198.51.100.3', { os: 'arch' }),
  server('JP-D 福冈', ['日本 🇯🇵'], '198.51.100.4'),
  ...Array.from({ length: 12 }, (_, i) => server(`DE-${String(i + 1).padStart(2, '0')} 法兰克福`, ['德国 🇩🇪'], `192.0.2.${i + 1}`)),
  server('宁宁云 DE9929 NoLimit', ['德国 🇩🇪'], '192.0.2.200', { last_connected_at: now - 2000 }),
  server('宁宁云 DE9929 1G', ['德国 🇩🇪'], '192.0.2.201', { last_connected_at: now - 3000 }),
  server('US-A 洛杉矶', ['美国 🇺🇸'], '203.0.113.50', { last_connected_at: now - 9000, os: 'fedora' }),
  server('US-B 纽约', ['美国 🇺🇸'], '203.0.113.51'),
  server('NoTag-1 家里 NAS', [], '10.0.0.2', { os: 'freebsd' }),
  server('NoTag-2 测试机', [], '10.0.0.3', { os: null }),
  // 连接会一直卡在认证、永远到不了 Shell 就绪：用来测试“正在连接”状态（例如关闭时是否确认）
  server('Slow-1 卡在认证', [], '10.0.0.9', { stall: true }),
];
// --servers <N>：补足到 N 台（按地区分组），用来看节点很多时的流畅度
const serverCountArg = args.indexOf('--servers');
const wantServers = serverCountArg >= 0 ? Number(args[serverCountArg + 1]) || 0 : 0;
const REGIONS = [['美国 🇺🇸', 'US'], ['德国 🇩🇪', 'DE'], ['荷兰 🇳🇱', 'NL'], ['新加坡 🇸🇬', 'SG'], ['英国 🇬🇧', 'UK'], ['印度 🇮🇳', 'IN']];
for (let i = servers.length; i < wantServers; i++) {
  const [tag, code] = REGIONS[i % REGIONS.length];
  servers.push(server(`${code}-${String(i).padStart(2, '0')} 节点`, [tag], `192.0.2.${(i % 250) + 1}`, { os: i % 3 ? 'debian' : 'ubuntu' }));
}

// JP-D 经 JP-C 跳板连接：用来测试“被用作跳板的服务器不能删”
servers.find((s) => s.name.startsWith('JP-D')).jump_server_id = servers.find((s) => s.name.startsWith('JP-C')).id;

let nextSnippetId = 1;
const snippet = (name, command, category = '') => ({
  id: `s${nextSnippetId++}`,
  name,
  command,
  category,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});
const snippets = [
  snippet('磁盘占用', 'df -h', '系统'),
  snippet('内存', 'free -h', '系统'),
  snippet('最近日志', 'journalctl -n 50 --no-pager', '日志'),
  snippet('Docker 容器', 'docker ps --format "table {{.Names}}\\t{{.Status}}"', 'Docker'),
  snippet('跟踪服务日志', 'journalctl -u {{service}} -f', '日志'),
  snippet('端口监听', 'ss -tlnp', '网络'),
  snippet('基础软件包', 'apt install sudo curl wget nano screen vnstat unzip zip jq dnsutils whois ncdu rsync -y', '初始化'),
  snippet('更新并重启', "sudo bash -c 'apt update && apt full-upgrade -y && apt autoremove -y && apt clean && systemctl reboot'", '初始化'),
  snippet('远程安装脚本', 'bash <(curl -sL https://raw.githubusercontent.com/example/project/refs/heads/main/scripts/install-latest.sh)', '初始化'),
  snippet('分行更新','sudo apt update \\\n&& sudo apt full-upgrade -y \\\n&& sudo apt autoremove -y \\\n&& sudo apt clean', '初始化'),
];

// ---------- HTTP ----------

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

// ---------- 模拟 GitHub OAuth（--anon 时） ----------
// 与 Worker 的顺序一致：/api/auth/github 下发 oauth_state Cookie 并跳到授权页；回调先校验 state 再用 code，
// state 不对直接 403（不会用掉 code）。授权页由假 Worker 自己提供，点“Authorize”回到回调地址。
const oauthCodes = new Set();
const sessions = new Set();
const cookieOf = (req, name) =>
  (req.headers.cookie ?? '')
    .split(/;\s*/)
    .map((part) => part.split('='))
    .find(([key]) => key === name)?.[1] ?? null;

function handleMockOauth(req, res, url) {
  const base = `http://${req.headers.host}`;
  if (url.pathname === '/api/auth/github') {
    const state = crypto.randomUUID();
    const params = new URLSearchParams({ client_id: 'mock', redirect_uri: `${base}/api/auth/callback`, scope: 'read:user', state });
    res.writeHead(302, {
      location: `${base}/mock-github/authorize?${params}`,
      'set-cookie': `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    });
    res.end();
    return true;
  }
  if (url.pathname === '/mock-github/authorize') {
    const code = crypto.randomUUID();
    oauthCodes.add(code);
    const back = new URL(url.searchParams.get('redirect_uri') ?? `${base}/api/auth/callback`);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    const href = back.toString().replace(/&/g, '&amp;');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock GitHub</title>` +
        `<body style="font-family:sans-serif;padding:24px"><h2>Mock GitHub</h2><p>假 Worker 的授权页，模拟 GitHub 登录与授权。</p>` +
        `<a id="authorize" href="${href}" style="display:block;margin-top:40px;padding:20px;background:#2da44e;color:#fff;text-align:center;border-radius:10px;font-size:22px;text-decoration:none">Authorize</a></body>`
    );
    return true;
  }
  if (url.pathname === '/api/auth/callback') {
    const state = url.searchParams.get('state');
    if (!state || state !== cookieOf(req, 'oauth_state')) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid state parameter (CSRF protection)');
      return true;
    }
    const code = url.searchParams.get('code');
    if (!code || !oauthCodes.delete(code)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('GitHub OAuth error: bad_verification_code');
      return true;
    }
    const token = crypto.randomUUID();
    sessions.add(token);
    res.writeHead(302, {
      location: `${base}/`,
      'set-cookie': [`session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`, 'oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'],
    });
    res.end();
    return true;
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    sessions.delete(cookieOf(req, 'session'));
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    res.end('{}');
    return true;
  }
  return false;
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname;
  const method = req.method;
  console.log(method, path);

  if (path === '/api/config') return json(res, 200, { turnstileEnabled: false, githubAuthEnabled: true, requireGithubAuth: false, authMode: 'github', sshSharingEnabled: true });
  if (anonymous && handleMockOauth(req, res, url)) return;
  if (path === '/api/auth/me') {
    if (anonymous && !sessions.has(cookieOf(req, 'session'))) return json(res, 401, { error: 'Unauthorized' });
    return json(res, 200, { id: 1, github_id: 1, username: 'tester', avatar_url: null });
  }
  if (path === '/api/servers' && method === 'GET') return json(res, 200, servers);
  // 模拟 AI 增强代理的检测接口（客户端直接访问，要带 CORS）；--proxy-v3 模拟没有长上下文的旧版
  if (path === '/mock-proxy/cloudssh-reasoning') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const model = url.searchParams.get('model') || '';
    const body = MOCK_PROXY_VERSION >= 4
      ? {
          cloudsshReasoningProxy: 4,
          upstream: true,
          features: ['reasoning', 'web_search', 'long_context'],
          ...(model ? { context: { model, ...mockWindow(model), maxBytes: 1200000, storage: args.includes('--proxy-kv') ? 'kv' : 'memory' } } : {}),
        }
      : { cloudsshReasoningProxy: 3, upstream: true, features: ['reasoning', 'web_search'] };
    return res.end(JSON.stringify(body));
  }
  // AI 配置（客户端 agent-output/ai-model.ts 读、切换模型）：与 Worker 一致，换接口地址必须带新密钥
  if (path === '/api/ai/config' && method === 'GET') return json(res, 200, { configured: true, base_url: aiBase, model: aiModel, api_key_last4: 'mock' });
  if (path === '/api/ai/config' && method === 'PUT') {
    const body = await readBody(req);
    if (!body.base_url || !body.model) return json(res, 400, { error: 'Missing user_id, base_url or model' });
    if (body.base_url !== aiBase && !body.api_key) return json(res, 400, { error: 'API address changed; provide a new key', code: 'responses_key_required' });
    aiBase = String(body.base_url);
    aiModel = String(body.model);
    console.log('  AI 接口 →', aiBase, '模型 →', aiModel);
    return json(res, 200, { success: true });
  }
  if (path === '/api/ai/models' && method === 'POST') {
    const body = await readBody(req);
    if (body.base_url && body.base_url !== aiBase && !body.api_key) return json(res, 400, { error: '接口地址与已保存配置不一致，请提供对应的 API 密钥' });
    return json(res, 200, { models: AI_MODELS.map((id) => ({ id })), fallback: false });
  }
  if (path === '/api/health') return json(res, 200, { ok: true });
  if (path === '/api/known-hosts' && method === 'GET') return json(res, 200, []);

  const connect = /^\/api\/servers\/(\d+)\/connect$/.exec(path);
  if (connect && method === 'POST') {
    const target = servers.find((s) => s.id === Number(connect[1]));
    if (target) target.last_connected_at = Date.now();
    return json(res, 200, { wsUrl: `ws://${req.headers.host}/api/ssh?token=mock-${connect[1]}-${Date.now()}` });
  }

  const serverPath = /^\/api\/servers\/(\d+)$/.exec(path);
  // 与 Worker 一致：只改请求里带的字段；主机或端口变了就清掉已识别的系统
  if (serverPath && method === 'PUT') {
    const target = servers.find((s) => s.id === Number(serverPath[1]));
    if (!target) return json(res, 404, { error: 'Server not found' });
    const body = await readBody(req);
    // 与 Worker 一致：凭据不能是空串；换认证方式时必须同时给新凭据
    if (body.credential !== undefined && !body.credential) return json(res, 400, { error: '认证凭据不能为空' });
    if (body.auth_method !== undefined && body.auth_method !== target.auth_method && !body.credential) {
      return json(res, 400, { error: '切换认证方式时必须同时提供对应凭据' });
    }
    if (body.credential) console.log('  新凭据', body.auth_method ?? target.auth_method, `${body.credential.length} 字符`);
    if ((body.host !== undefined && body.host !== target.host) || (body.port !== undefined && body.port !== target.port)) target.os = null;
    for (const key of ['name', 'host', 'port', 'username', 'auth_method', 'region', 'jump_server_id', 'transport_type', 'cf_tunnel_host']) {
      if (body[key] !== undefined) target[key] = body[key];
    }
    if (Array.isArray(body.tags)) target.tags = body.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10);
    target.updated_at = new Date().toISOString();
    return json(res, 200, target);
  }
  if (serverPath && method === 'DELETE') {
    const id = Number(serverPath[1]);
    const index = servers.findIndex((s) => s.id === id);
    if (index < 0) return json(res, 404, { error: 'Server not found' });
    // 与 Worker 一致：被别的服务器用作跳板时不能删
    if (servers.some((s) => s.jump_server_id === id)) return json(res, 409, { error: 'Server is used as a jump host' });
    servers.splice(index, 1);
    return json(res, 200, { success: true });
  }
  // 一次性分享：只提供空列表，够打开分享管理界面
  if (/^\/api\/servers\/\d+\/shares$/.test(path) && method === 'GET') return json(res, 200, []);

  if (path === '/api/snippets' && method === 'GET') return json(res, 200, snippets);
  if (path === '/api/snippets' && method === 'POST') {
    const body = await readBody(req);
    const item = snippet(String(body.name ?? ''), String(body.command ?? ''), String(body.category ?? ''));
    snippets.push(item);
    return json(res, 201, item);
  }
  const snippetPath = /^\/api\/snippets\/([\w-]+)$/.exec(path);
  if (snippetPath) {
    const index = snippets.findIndex((s) => s.id === snippetPath[1]);
    if (index < 0) return json(res, 404, { error: 'not found' });
    if (method === 'PUT') {
      const body = await readBody(req);
      Object.assign(snippets[index], { name: body.name, command: body.command, category: body.category ?? '' });
      return json(res, 200, snippets[index]);
    }
    if (method === 'DELETE') {
      snippets.splice(index, 1);
      return json(res, 200, { ok: true });
    }
  }
  if (uiDir && method === 'GET' && !path.startsWith('/api/')) return serveUi(res, path);
  return json(res, 404, { error: 'not mocked' });
}

// ---------- 托管界面（--ui） ----------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function serveUi(res, pathname) {
  if (mobileShim && pathname === '/__mock-tauri.js') {
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.js'], 'Cache-Control': 'no-store' });
    return fs.createReadStream(new URL('./mock-tauri.js', import.meta.url)).pipe(res);
  }
  let file = nodePath.join(uiDir, decodeURIComponent(pathname));
  // 只允许目录内的文件；目录或不存在的路径交给单页应用的 index.html
  if (!file.startsWith(uiDir + nodePath.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = nodePath.join(uiDir, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[nodePath.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (mobileShim && file.endsWith('index.html')) {
    return res.end(fs.readFileSync(file, 'utf8').replace(/<head([^>]*)>/i, '<head$1><script src="/__mock-tauri.js"></script>'));
  }
  fs.createReadStream(file).pipe(res);
}

// ---------- WebSocket（最小实现：解析客户端掩码帧，发送不掩码帧） ----------

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function frame(opcode, payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload);
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function createSocket(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  const api = {
    sendText: (text) => !socket.destroyed && socket.write(frame(0x1, text)),
    sendBinary: (bytes) => !socket.destroyed && socket.write(frame(0x2, bytes)),
    sendJson: (value) => api.sendText(JSON.stringify(value)),
    destroy: () => socket.destroy(),
    close: (code = 1000) => {
      if (socket.destroyed) return;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.write(frame(0x8, payload));
      socket.end();
    },
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + (i % 4)];
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        api.close(1000);
        return;
      }
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0) fragmentOpcode = opcode;
      fragments.push(payload);
      if (!fin) continue;
      const message = Buffer.concat(fragments);
      fragments = [];
      onMessage(fragmentOpcode === 0x1 ? message.toString('utf8') : message, fragmentOpcode);
    }
  });
  socket.on('error', () => {});
  return api;
}

// ---------- 假 shell ----------

/** 提示符；末尾打开括号粘贴模式，像 bash 5.1 起的 readline 在等输入时那样（执行命令时关掉） */
const PROMPT = '\x1b[1;32mroot@mock\x1b[0m:\x1b[1;34m~\x1b[0m# \x1b[?2004h';
/** 各种常见日志（系统、nginx 访问日志、容器状态……），用来测试关键词高亮；ls 那一行带程序自己的颜色 */
const SAMPLE_LOGS = [
  '2026-10-17 15:30:01 INFO  nginx started, listening on 0.0.0.0:443 (pid=1234)',
  'Oct 17 15:30:02 web-01 sshd[2291]: Failed password for invalid user admin from 203.0.113.7 port 52144 ssh2',
  'Oct 17 15:30:03 web-01 systemd[1]: nginx.service: Active: active (running) since Fri; 12.5MB memory',
  'Oct 17 15:30:04 web-01 kernel: Out of memory: Killed process 4242 (java) total-vm:2048000kB',
  'WARN  disk /dev/sda1 is 91% full, retrying in 5s (deprecated option --legacy)',
  'ERROR connection to 10.0.0.5:5432 refused: timeout after 3000ms',
  'DEBUG cache miss for key=user:42, fallback to database',
  '192.0.2.10 - - [17/Oct/2026:15:30:05 +0800] "GET /api/servers HTTP/1.1" 200 512 "-" "curl/8.5.0"',
  '192.0.2.11 - - [17/Oct/2026:15:30:06 +0800] "POST /login HTTP/1.1" 403 87 "-" "Mozilla/5.0"',
  'HTTP/1.1 502 Bad Gateway   upstream 2001:db8::1 unreachable',
  'CONTAINER ID   NAME     STATUS',
  '3f9c2ab1d4e5   web      Up 3 hours',
  '7a1b2c3d4e5f   api      Exited (1) 2 minutes ago',
  'worker-6d9f8   0/1      CrashLoopBackOff   5 (30s ago)',
  'cache-5c7b9    0/1      Pending',
  'eth0: ether 52:54:00:12:34:56  inet 172.17.0.2/16  link fe80::5054:ff:fe12:3456',
  'Saved to ~/backups/db-2026-10-17.sql.gz (sha256 9b74c9897bac770ffc029102a200c5de)',
  'See https://github.com/XMZO/CloudSSH/issues for details; request id 3fa85f64-5717-4562-b3fc-2c963f66afa6',
  '\x1b[1;34mbin\x1b[0m  \x1b[1;32mdeploy.sh\x1b[0m  error.log  ok.txt  (ls 自己着色的部分保持原样)',
].join('\r\n');

/** 终端里的显示宽度：中日韩全角字符占 2 列 */
const cellWidth = (text) => [...text].reduce((sum, ch) => sum + (/[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const padCells = (text, width) => text + ' '.repeat(Math.max(0, width - cellWidth(text)));

/** 仿常见一键脚本的固定宽度菜单（60 列，中英混排、框线），用来看窄屏下的排版 */
function boxMenu() {
  const inner = 58;
  const rows = [
    ['', ''],
    ['  VPS 补货频道', 't.me/example'],
    ['  VPS 测评数据', 'example.com'],
    null,
    ['  1. 一键调优', 'Auto-tune (recommended)   ~10 min'],
    ['  2. 基础调优', 'Base tuning only           ~1 min'],
    ['  3. 拐点测试', 'Policer sweep              ~8 min'],
    ['  4. 加 swap', 'Add swap (low-memory box)'],
    null,
    ['  5. 查看状态', 'Status'],
    ['  0. 退出', 'Exit'],
  ];
  const out = [`╔${'═'.repeat(inner)}╗`];
  for (const row of rows) {
    if (!row) out.push(`╟${'─'.repeat(inner)}╢`);
    else out.push(`║${padCells(padCells(row[0], 18) + row[1], inner)}║`);
  }
  out.push(`╚${'═'.repeat(inner)}╝`, '  Machine   1 core / 1965 MB / 7.2.11-example-bbrv3', '', '请选择 / Select [0-5] [1]: ');
  return out.join('\r\n');
}

const HELP = [
  '可用命令：help  ls  date  uname -a  echo <文本>  seq <n>  colors  top  logs  menu  pager（全屏，方向键滚动，q 退出）  nano（像 nano，Alt+M 开关鼠标，Ctrl+X 退出）  size  clear  exit',
  '调试后台提醒：sleep <秒>（隔这么久才回到提示符）  bell（响铃）  notify <文本>（OSC 9 通知）  drop（模拟断网）  hangup（模拟远程主机断开）',
  '其他命令会原样回显为“已执行”，方便测试常用命令的插入与执行。',
].join('\r\n');

/** 返回毫秒数时，过这么久才回到提示符（模拟耗时命令） */
function runCommand(line, write, term, ws) {
  const [command, ...args] = line.trim().split(/\s+/);
  if (!command) return 0;
  switch (command) {
    case 'sleep':
      return Math.min(600, Math.max(0, Number(args[0]) || 1)) * 1000;
    case 'bell':
      write('\x07');
      break;
    case 'notify':
      write(`\x1b]9;${args.join(' ') || 'done'}\x07`);
      break;
    case 'drop':
      // 不发关闭帧直接断开 TCP：浏览器侧是异常断线，网页版会自动重连
      setTimeout(() => ws.destroy(), 100);
      break;
    case 'hangup':
      // 模拟远程主机断开（服务器重启、sshd 被杀……）：Worker 报错后以 1011 关闭
      ws.sendJson({ type: 'error', message: '远程主机已关闭连接', event: 'remote_closed' });
      setTimeout(() => ws.close(1011), 50);
      break;
    case 'help':
      write(`${HELP}\r\n`);
      break;
    case 'size':
      // 与 stty size 一样：行 列（客户端最近一次 resize 报告的尺寸）
      write(`${term.rows} ${term.cols}\r\n`);
      break;
    case 'menu':
      write(`${boxMenu()}\r\n`);
      break;
    case 'ls':
      write('\x1b[1;34mbin\x1b[0m  \x1b[1;34metc\x1b[0m  \x1b[1;34mhome\x1b[0m  notes.txt  \x1b[1;32mdeploy.sh\x1b[0m  data.tar.gz\r\n');
      break;
    case 'date':
      write(`${new Date().toString()}\r\n`);
      break;
    case 'uname':
      write('Linux mock 6.1.0-mock #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\r\n');
      break;
    case 'echo':
      write(`${args.join(' ')}\r\n`);
      break;
    case 'seq': {
      const count = Math.min(5000, Math.max(1, Number(args[0]) || 10));
      write(`${Array.from({ length: count }, (_, i) => i + 1).join('\r\n')}\r\n`);
      break;
    }
    case 'colors': {
      let out = '';
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < 8; i++) out += `\x1b[${row ? 100 + i : 40 + i}m  ${row ? 'bright' : 'normal'} ${i} \x1b[0m`;
        out += '\r\n';
      }
      for (let i = 0; i < 8; i++) out += `\x1b[${30 + i}m色${i}\x1b[0m \x1b[${90 + i}m亮${i}\x1b[0m  `;
      write(`${out}\r\n`);
      break;
    }
    case 'logs':
      write(`${SAMPLE_LOGS}\r\n`);
      break;
    case 'top':
      write('top - 12:00:00 up 3 days,  load average: 0.10, 0.08, 0.05\r\nTasks: 120 total,   1 running\r\n%Cpu(s):  2.0 us,  1.0 sy, 97.0 id\r\nMiB Mem :   1985.6 total,   512.3 free\r\n');
      break;
    case 'clear':
      write('\x1b[2J\x1b[H');
      break;
    case 'stream': {
      // stream [秒数]：像 tail -f 那样持续刷彩色日志（每 50ms 5 行），调试终端渲染卡顿
      const seconds = Math.min(120, Math.max(1, Number(args[0]) || 10));
      let n = 0;
      const timer = setInterval(() => {
        let out = '';
        for (let i = 0; i < 5; i++, n++) {
          out += `\x1b[2m2026-10-19 12:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}\x1b[0m \x1b[3${(n % 6) + 1}m[worker-${n % 8}]\x1b[0m request id=${n.toString(16).padStart(8, '0')} path=/api/v1/items/${n} status=200 duration=${(n * 7) % 250}ms\r\n`;
        }
        write(out);
      }, 50);
      setTimeout(() => clearInterval(timer), seconds * 1000);
      break;
    }
    default:
      write(`\x1b[2m（模拟）已执行：${line.trim()}\x1b[0m\r\n`);
  }
  return 0;
}

// AI 助手：打印收到的完整 message（调试客户端附加的回复风格提示），再流式返回一份固定的巡检报告（调试回复配色与状态高亮）
/**
 * 假的 AI 配置：模型可由客户端切换。接口地址默认是普通中转；在 AI 设置里改成 MOCK_PROXY（要重新填密钥）就模拟
 * 接了思考深度代理（tools/reasoning-proxy）：客户端检测得到它，消息末尾的 [cloudssh-reasoning:x] 被“代理”换成 reasoning.effort
 */
const AI_RELAY = 'https://relay.example.com/v1';
const MOCK_PROXY = `http://127.0.0.1:${port}/mock-proxy`;
const AI_MODELS = ['claude-sonnet-4-5', 'deepseek-chat', 'gemini-2.5-pro', 'gpt-5', 'gpt-5-mini', 'gpt-5.1-codex'];
let aiBase = args.includes('--reasoning-proxy') ? MOCK_PROXY : AI_RELAY;
let aiModel = 'gpt-5';
/** 模拟的代理版本：4 起有长上下文（代理接管 Worker 的整理、保留完整对话，用量打包），--proxy-v3 模拟旧版 */
const MOCK_PROXY_VERSION = args.includes('--proxy-v3') ? 3 : 4;
const USAGE_PACK = 2 ** 26;
/** 模型窗口（代理从接口的 /models 查到的；这里简单按名字给） */
function mockWindow(model) {
  if (/gemini/.test(model)) return { tokens: 1048576, source: 'upstream' };
  if (/claude/.test(model)) return { tokens: 200000, source: 'upstream' };
  if (/gpt-5/.test(model)) return { tokens: 400000, source: 'upstream' };
  return { tokens: 64000, source: 'upstream' };
}
// 与 tools/reasoning-proxy 一致：正式标签 <cloudssh_reasoning effort="high"/>，也认 0.3.23 的旧写法
const SEARCH_MARK = /\s*<cloudssh_web_search\s+mode=\\*"(on|off)\\*"\s*\/>/g;
const REASONING_MARK = /\s*(?:<cloudssh_reasoning\s+effort=\\*"(auto|none|minimal|low|medium|high|xhigh)\\*"\s*\/>|\[cloudssh-reasoning:(auto|none|minimal|low|medium|high|xhigh)\])/g;

/** 与 Worker 的上下文口径一致：系统提示 + 工具约 1.15 万字节，到 37760 字节整理；这里按每 token 3.3 字节换算 */
const MOCK_PREFIX_TOKENS = 3500;
/** #heavy-base：模拟服务器记忆、终端快照很大（底多占的 token，跨会话保留；#light-base 恢复） */
let mockBaseExtra = 0;
const MOCK_LIMIT_TOKENS = Math.floor(37760 / 3.3);
const mockTokens = (text) => Math.ceil(Buffer.byteLength(String(text)) / 3.3);

const COMPACT_SUMMARY = [
  '- 用户目标：检查几台服务器的负载与磁盘',
  '- prohosting24 6c12g：负载 0.06，内存 11Gi 可用，根分区用了 4%',
  '- BERO-HOST 德国 v6 12o：单核 2G，负载 0.13，Docker 与 valkey 在跑',
  '- 已执行：uptime、free -h、df -h，均为只读命令',
  '- 待办：需要时再用 docker ps 看容器',
].join('\n');

const AGENT_REPLY = [
  '我将并行采集 CPU、内存、磁盘三类信息。',
  '',
  '## 系统资源巡检报告',
  '',
  '**主机**: mock-pi (aarch64)  **运行时长**: 1 天 16 小时  **结论**: 三个维度大体健康，`/boot/firmware` 需要清理。',
  '',
  '### 一、CPU',
  '',
  '| 指标 | 数值 | 评估 |',
  '|---|---|---|',
  '| 核心数 | 4 | — |',
  '| load average | 0.17 / 0.08 / 0.02 | 极低，远低于 4 核阈值 |',
  '| 用户态占用 | 1.8% us | 正常 |',
  '| 空闲 | 93.0% id | 充裕 |',
  '| I/O 等待 | 0.0% wa | 无异常 |',
  '| 温度 | 71.2 °C | 偏高 |',
  '| 风扇 | 0 RPM | 异常 |',
  '| 交换分区 | 1.9 GiB 已用 | 不正常 |',
  '',
  '> 采样瞬间 `top` 自身占 7.7% CPU，属采集程序噪声，不代表实际负载。',
  '',
  '### 二、磁盘',
  '',
  '- **正常**：`/` 已用 41%（12G / 29G）',
  '- **注意**：`/var/log` 增长较快，近 7 天新增 2.1G',
  '- **异常**：`/boot/firmware` 只剩 3% 可用空间',
  '',
  '### 建议',
  '',
  '1. 清理旧日志：',
  '',
  '```bash',
  'sudo journalctl --vacuum-time=7d',
  '```',
].join('\n');

/**
 * 模拟 Worker 端 AI 会话的上下文状态（每条连接一份），用来调试客户端的接续逻辑：
 *   消息里带 #long：本轮正常回复，之后上下文“过长”，再发消息都会在压缩时报 responses_schema（与 Worker 一样会先执行一条命令），
 *                   直到 agent_reset；
 *   消息里带 #compact：本轮回复后“压缩成功”，清空编辑检查点，之后编辑更早的消息报 responses_history。
 *   消息里带 #big：这一轮模拟调用三次、工具输出很长，上下文涨得快（客户端上下文圆环、自动压缩）；
 *   上下文涨到整理线时与用户遇到的一样报 responses_schema（Worker 整理失败），带 #checkpoint-ok 则模拟整理成功。
 *   客户端压缩（<cloudssh_compact>）：流式写一段摘要；之前发过 #compact-fail 就报错（测试改用对话要点），#compact-tool 则先调工具。
 *   会话绑定第一次用的模型，换了模型报 responses_config_changed，直到 agent_reset；模型名不认识报 responses_http 404。
 *   接了思考深度代理（--reasoning-proxy，或 AI 设置里接口地址改成 MOCK_PROXY）时，#reasoning-reject 带思考深度报 400，
 *   #proxy-down 模拟 Worker 访问不到代理（同区域限制，报 522）。
 * 判断标记时忽略客户端接续时附带的 <earlier_conversation> 回顾。
 */
const agentStates = new WeakMap();

function agentState(ws) {
  let state = agentStates.get(ws);
  if (!state) {
    // ctx：Worker 那份对话的量（到线就整理）；modelCtx：模型实际看到的（长上下文代理把前文放回，整理也不丢）
    state = { nextTurn: 0, turns: new Set(), long: false, compacted: false, ctx: 0, modelCtx: 0, model: null, current: null, flags: new Set() };
    agentStates.set(ws, state);
  }
  return state;
}

/**
 * 模拟 AI 请求跨服务器操作（客户端 ai-remote）：消息里带 #remote 时回一个 cloudssh-action 代码块
 * （#remote-dir 传目录，#remote-risky 带一条需要确认的命令）；收到 <cloudssh_action_results> 时总结结果、不再请求
 */
function mockRemoteReply(request) {
  // 只认开头：服务器目录的用法说明里也提到了这个标记
  if (request.trimStart().startsWith('<cloudssh_action_results>')) {
    const lines = request.split('\n').filter((line) => /^\[\d+\]|^exit code|^done:|^failed:|^rejected|^blocked/.test(line));
    return `已拿到其他服务器的结果：\n\n${lines.map((line) => `- ${line}`).join('\n')}\n\n✅ 跨服务器操作完成。`;
  }
  // 模拟 AI 提问（客户端 agent-output/ask.ts 换成选项卡片）
  if (request.includes('#ask-multi')) {
    return '先确认两件事。\n\n```cloudssh-ask\n[{"question":"要检查哪些项目？","options":["磁盘占用","Swap 配置","BBR 是否生效"],"multiple":true},{"question":"发现问题后怎么处理？","options":["只报告","直接修复"]}]\n```';
  }
  if (request.includes('#ask')) {
    return '提问功能没问题，下面给你来一道题：\n\n```cloudssh-ask\n{"question":"你希望我先查哪一项？","options":["磁盘占用","Swap 配置","BBR 是否生效"]}\n```';
  }
  if (!request.includes('#remote')) return null;
  // 只拿到简介时 AI 先要列表与用法（客户端把完整的目录与用法作为结果发回来）
  if (request.includes('#remote-list')) return '先看看有哪些服务器。\n\n```cloudssh-action\n{"action":"list"}\n```';
  if (request.includes('#remote-jump')) {
    // 源就是跳板机 JP-C：直接连它后面的 JP-D；从当前服务器传给 JP-D 则经 JP-C 一跳
    return '经跳板直连传两份文件。\n\n```cloudssh-action\n{"action":"copy","from":{"server":"JP-C","path":"/root/notes.txt"},"to":{"server":"JP-D","path":"/tmp/from-jump/"}}\n{"action":"copy","from":{"server":"current","path":"/root/deploy.sh"},"to":{"server":"JP-D","path":"/tmp/via-jump.sh"}}\n```';
  }
  if (request.includes('#remote-slow')) {
    return '先在 DE-03 上跑一个慢命令。\n\n```cloudssh-action\n{"action":"exec","server":"DE-03 法兰克福","command":"sleep 20","timeout":60}\n```';
  }
  // #remote-id：像 AI 读过服务器目录那样用主机 ID（srv-编号，也有写成数字的），不用确认是哪台
  if (request.includes('#remote-id')) {
    const id = (name) => servers.find((item) => item.name === name)?.id;
    const byId = [
      { action: 'exec', server: `srv-${id('DE-03 法兰克福')}`, command: 'df -h' },
      { action: 'copy', from: { server: 'current', path: '/root/deploy.sh' }, to: { server: `srv-${id('JP-D 福冈')}`, path: '/tmp/deploy-copy.sh' } },
      { action: 'exec', server: id('US-A 洛杉矶'), command: 'uptime' },
    ];
    return `按主机 ID 在其他服务器上处理。\n\n\`\`\`cloudssh-action\n${byId.map((item) => JSON.stringify(item)).join('\n')}\n\`\`\``;
  }
  const actions = [
    { action: 'exec', server: 'DE-03 法兰克福', command: 'df -h' },
    request.includes('#remote-dir')
      ? { action: 'copy', from: { server: 'current', path: '/root/www' }, to: { server: 'JP-D', path: '/tmp/' } }
      : { action: 'copy', from: { server: 'current', path: '/root/notes.txt' }, to: { server: 'DE-03 法兰克福', path: '/tmp/' } },
    { action: 'copy', from: { server: 'current', path: '/root/deploy.sh' }, to: { server: 'JP-D', path: '/tmp/deploy-copy.sh' } },
  ];
  if (request.includes('#remote-risky')) actions.push({ action: 'exec', server: 'JP-D', command: 'rm -rf /tmp/old-logs' });
  return `我来在其他服务器上处理这些操作。\n\n\`\`\`cloudssh-action\n${actions.map((item) => JSON.stringify(item)).join('\n')}\n\`\`\``;
}

/** agent_stop：停掉正在流式输出的那一轮（与 Worker 一样回 agent.stopped 与 run_end stopped） */
function mockAgentStop(ws) {
  const current = agentState(ws).current;
  if (!current) return;
  agentState(ws).current = null;
  current.timers.forEach((timer) => clearTimeout(timer));
  console.log('AGENT stop');
  current.frame('response', { messageKey: 'agent.stopped' });
  current.frame('run_end', { outcome: 'stopped', usage: current.usage(0) });
}

function mockAgentReset(ws) {
  agentStates.delete(ws);
  console.log('AGENT reset');
  ws.sendJson({ type: 'agent_frame', runId: 'mock-run', subType: 'reset_done' });
}

function mockAgentReply(ws, msg) {
  console.log(`AGENT 收到的 message（userIndex=${msg.userIndex ?? '-'}）↓\n` + msg.message + '\nAGENT ↑');
  const frame = (subType, extra = {}) => ws.sendJson({ type: 'agent_frame', runId: 'mock-run', requestId: msg.requestId, subType, ...extra });
  const state = agentState(ws);
  // 思考深度标记：接了代理时由“代理”删掉、换成 reasoning.effort；没接代理还带着标记说明客户端判断错了
  let effort = null;
  let webSearch = null;
  const rawMessage = String(msg.message ?? '')
    .replace(REASONING_MARK, (_, tag, legacy) => {
      effort = tag || legacy;
      return '';
    })
    .replace(SEARCH_MARK, (_, mode) => {
      webSearch = mode;
      return '';
    });
  if (effort && aiBase !== MOCK_PROXY) console.log(`AGENT 警告：没接思考深度代理，标记 [cloudssh-reasoning:${effort}] 会原样发给模型`);
  else if (aiBase === MOCK_PROXY) console.log(`AGENT 代理：reasoning.effort = ${effort && effort !== 'auto' ? effort : '（不加）'}，联网搜索 = ${webSearch ?? '（没带标签）'}`);
  const request = rawMessage.replace(/<earlier_conversation>[\s\S]*?<\/earlier_conversation>/, '');
  for (const flag of ['#compact-fail', '#compact-tool', '#checkpoint-ok']) if (request.includes(flag)) state.flags.add(flag);
  if (request.includes('#heavy-base')) mockBaseExtra = 5500;
  if (request.includes('#light-base')) mockBaseExtra = 0;
  // 上一轮还在流式输出（客户端顶掉了它）：与 Worker 一样先停掉
  if (state.current) mockAgentStop(ws);
  const timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  // 用量：这一轮各次调用的输入 / 输出合计（与 Worker run_end 的 usage 一致）
  const firstInput = MOCK_PREFIX_TOKENS + mockBaseExtra + state.ctx + mockTokens(msg.message) + 300;
  // 长上下文代理：模型看到的是完整前文；联网搜索的结果也算进接口回报的输入（Worker 那份里没有）
  const longCtx = aiBase === MOCK_PROXY && MOCK_PROXY_VERSION >= 4;
  const searchExtra = aiBase === MOCK_PROXY && webSearch === 'on' ? 6000 : 0;
  const modelFirst = MOCK_PREFIX_TOKENS + mockBaseExtra + (longCtx ? state.modelCtx : state.ctx) + mockTokens(msg.message) + 300 + searchExtra;
  const usage = (output, calls = 1, growth = 0) => {
    const inputs = Array.from({ length: calls }, (_, i) => modelFirst + Math.round((growth * i) / Math.max(1, calls - 1)));
    const input = inputs.reduce((a, b) => a + b, 0);
    // 推理用量随“代理”加上的档位变化（客户端思考深度菜单里显示上一轮的推理用量，用来确认是否生效）
    const perCall = { minimal: 0, low: 120, medium: 400, high: 900, xhigh: 1600 }[aiBase === MOCK_PROXY ? effort : ''] ?? 300;
    const cached = Math.floor(input * 0.6);
    const use = { calls, reportedCalls: calls, input, cached, output, reasoning: perCall * calls, checkpointCalls: 0 };
    // 代理回给 Worker：输入按 Worker 那份算，实际输入编进缓存（客户端解开）
    if (longCtx && calls) Object.assign(use, { input: Math.min(input, Math.round(firstInput * calls * 0.8)), cached: cached + input * USAGE_PACK });
    return use;
  };
  state.current = { frame, timers, usage };
  const finishRun = (outcome, use) => {
    if (state.current?.frame !== frame) return;
    state.current = null;
    frame('run_end', { outcome, usage: use });
  };
  frame('run_start');
  const fail = (code, executed, extra = {}) => {
    if (executed) frame('executing', { tool: 'execute_command', args: { command: 'df -h' } });
    later(() => {
      frame('error', { code, ...extra });
      // 与 Worker 一样：调用模型之前就失败的没有调用次数（整理失败的那次检查点调用不计入这里）
      finishRun('failed', usage(0, 0));
    }, 150);
  };
  // 会话绑定模型；不认识的模型名（含不认的后缀）报 404
  if (state.model && state.model !== aiModel) return fail('responses_config_changed');
  if (!AI_MODELS.includes(aiModel)) return fail('responses_http', false, { status: 404 });
  // #reasoning-reject：模型不支持 reasoning.effort，接口报 400
  if (request.includes('#reasoning-reject') && effort && effort !== 'auto' && aiBase === MOCK_PROXY) return fail('responses_http', false, { status: 400 });
  if (request.includes('#proxy-down') && aiBase === MOCK_PROXY) return fail('responses_http', false, { status: 522 });
  state.model = aiModel;
  console.log(`AGENT 上下文约 ${firstInput} tokens（整理线约 ${MOCK_LIMIT_TOKENS}），模型实际看到约 ${modelFirst}，模型 ${aiModel}`);
  // 客户端压缩：写摘要
  if (request.includes('<cloudssh_compact>')) {
    if (state.flags.has('#compact-fail')) return fail('responses_schema');
    if (state.flags.has('#compact-tool')) frame('executing', { tool: 'execute_command', args: { command: 'uptime' } });
    const pieces = COMPACT_SUMMARY.match(/[\s\S]{1,24}/g);
    pieces.forEach((piece, index) => later(() => frame('stream_chunk', { content: piece }), 400 + 120 * index));
    later(() => {
      frame('stream_end', { content: COMPACT_SUMMARY });
      finishRun('completed', usage(mockTokens(COMPACT_SUMMARY)));
    }, 400 + 120 * (pieces.length + 1));
    return;
  }
  // 到了整理线：与用户遇到的一样整理失败（带 #checkpoint-ok 时模拟整理成功）；长上下文代理接管整理，总是成功、不丢内容
  if (firstInput >= MOCK_LIMIT_TOKENS && !longCtx && !state.flags.has('#checkpoint-ok')) return fail('responses_schema', true);
  let workerFirst = firstInput;
  if (firstInput >= MOCK_LIMIT_TOKENS) {
    state.ctx = 2500;
    workerFirst = MOCK_PREFIX_TOKENS + mockBaseExtra + 2500 + mockTokens(msg.message) + 300;
    console.log(`AGENT Worker 整理上下文${longCtx ? '（代理接管，模型仍看到完整前文）' : ''}`);
    frame('context_status', { compacted: true, earliestEditableTurn: state.nextTurn });
  }
  if (typeof msg.userIndex === 'number') {
    if (!state.turns.has(msg.userIndex) && (state.turns.size > 0 || state.compacted)) return fail('responses_history');
    for (const turn of [...state.turns]) if (turn >= msg.userIndex) state.turns.delete(turn);
    state.nextTurn = msg.userIndex;
  }
  state.turns.add(state.nextTurn++);
  if (state.long) return fail('responses_schema', true);
  // #confirm：模拟 AI 要执行危险命令，Worker 发 confirm_required 等客户端回 agent_confirm
  if (request.includes('#confirm')) {
    const command = 'rm -rf /tmp/old-logs';
    const confirmationId = crypto.randomUUID();
    const askedAt = Date.now();
    frame('executing', { tool: 'execute_command', args: { command } });
    frame('confirm_required', { command, reason: '删除文件操作，为保证安全需要确认', confirmationId });
    state.pendingConfirm = (answer) => {
      if (answer.confirmationId !== confirmationId || answer.command !== command) return;
      state.pendingConfirm = null;
      console.log(`AGENT 确认结果 approved=${answer.approved}，等待 ${Date.now() - askedAt}ms`);
      const text = answer.approved ? `✅ 已执行 \`${command}\`。` : `❌ 用户拒绝了 \`${command}\`，没有执行。`;
      frame('stream_chunk', { content: text });
      frame('stream_end', { content: text });
      finishRun('completed', usage(mockTokens(text)));
    };
    return;
  }
  const reply = mockRemoteReply(request) ?? AGENT_REPLY;
  const big = request.includes('#big');
  if (big) frame('executing', { tool: 'execute_command', args: { command: 'journalctl -n 300' } });
  const pieces = reply.match(/[\s\S]{1,60}/g);
  pieces.forEach((piece, index) => later(() => frame('stream_chunk', { content: piece }), 40 * (index + 1)));
  later(() => {
    if (state.current?.frame !== frame) return;
    frame('stream_end', { content: reply });
    const output = mockTokens(reply);
    const use = big ? usage(output, 3, 2600) : usage(output);
    state.ctx = workerFirst - MOCK_PREFIX_TOKENS - mockBaseExtra + (big ? 2600 : 0) + output;
    state.modelCtx = modelFirst - MOCK_PREFIX_TOKENS - mockBaseExtra - searchExtra + (big ? 2600 : 0) + output;
    if (request.includes('#long')) state.long = true;
    if (request.includes('#compact')) {
      state.turns.clear();
      state.compacted = true;
      frame('context_status', { compacted: true, earliestEditableTurn: state.nextTurn });
    }
    finishRun('completed', use);
  }, 40 * (pieces.length + 2));
}

// ---------- AI 跨服务器操作的后台会话（客户端 overrides/shared/ai-remote） ----------
// 客户端把命令包在标记里：初始化打印 __CSRDY<id>；执行时打印 __CSBEG<id>、输出、__CSRC<退出码>、__CSEND<id>。
// 这里认出这些行并模拟执行：几条常用命令给假输出；传文件相关的命令（查路径、生成临时密钥、ssh 直连、tar 打包解包、
// mkdir、rm）作用在下面的内存文件系统上（所有服务器共用一份，按路径区分即可调试）。

/** 单引号字符串还原（'\'' 是转义的单引号）；"$HOME" 换成 /root */
function shellWord(text) {
  return text.replace(/"\$HOME"/g, '/root').replace(/'((?:[^']|'\\'')*)'/g, (_, inner) => inner.replace(/'\\''/g, "'"));
}

function mkdirp(path) {
  const parts = path.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const prefix = `/${parts.slice(0, i).join('/')}`;
    if (!sftpTree.has(prefix)) sftpPut(prefix, 'dir');
  }
}

function copyTree(src, dest) {
  mkdirp(sftpParent(dest));
  for (const [path, node] of [...sftpTree.entries()]) {
    if (path !== src && !path.startsWith(`${src}/`)) continue;
    sftpTree.set(dest + path.slice(src.length), { ...node, data: node.data ? Buffer.from(node.data) : null, mtime: Math.floor(Date.now() / 1000) });
  }
}

function removeTree(path) {
  for (const key of [...sftpTree.keys()]) if (key === path || key.startsWith(`${path}/`)) sftpTree.delete(key);
}

/** 真的 tar.gz（ustar）：服务器上打包的能被本机 tar 解开，本机 tar 打的包这里也能解开（命令行上传 / 下载目录） */
function tarPack(root) {
  const base = sftpParent(root) === '/' ? 1 : sftpParent(root).length + 1;
  const blocks = [];
  for (const [path, node] of [...sftpTree.entries()].filter(([p]) => p === root || p.startsWith(`${root}/`))) {
    const name = path.slice(base) + (node.type === 'dir' ? '/' : '');
    const data = node.type === 'file' ? (node.data ?? Buffer.alloc(node.size, 0x2e)) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(node.type === 'dir' ? '0000755\0' : '0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write(node.type === 'dir' ? '5' : '0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** 解开 tar.gz，返回 [相对路径, {type, data}]（认 ustar 前缀与 pax 扩展头里的 path） */
function tarUnpack(gz) {
  const tar = zlib.gunzipSync(gz);
  const entries = [];
  let paxPath = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(345, 155);
    const name = (paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))).replace(/^\.\//, '').replace(/\/+$/, '');
    paxPath = null;
    if (!name || name === '.') continue;
    if (type === '5') entries.push([name, { type: 'dir', data: null }]);
    else if (type === '0' || type === '\0') entries.push([name, { type: 'file', data: Buffer.from(data) }]);
  }
  return entries;
}

function tarExtract(archive, dest, strip = 0) {
  const node = sftpTree.get(archive);
  if (!node?.data) throw new Error(`no archive ${archive}`);
  mkdirp(dest);
  for (const [rel, item] of tarUnpack(node.data)) {
    const parts = rel.split('/').slice(strip);
    if (!parts.length || !parts[0]) continue;
    const path = `${dest.replace(/\/+$/, '')}/${parts.join('/')}`;
    mkdirp(sftpParent(path));
    if (item.type === 'dir') {
      if (!sftpTree.has(path)) sftpPut(path, 'dir');
    } else {
      sftpPut(path, 'file', 0, item.data);
      sftpTree.get(path).size = item.data.length;
    }
  }
}

/** MCP 后台任务（start_job / job_status） */
const mockJobs = new Map();
function jobState(job) {
  if (job.state === 'running') return '运行中（进程 4242）';
  if (job.state === 'stopped') return '已被 job_status 停止';
  return '已结束，退出码 0';
}

function mockExec(cmd) {
  const ok = (output = '') => ({ output, rc: 0 });
  const quoted = String.raw`'(?:[^']|'\\'')*'`;
  const word = String.raw`(?:"\$HOME"/)?${quoted}|"\$HOME"`;
  let m;
  // MCP exec 的 cwd：先进目录，再照常执行后面的命令
  if ((m = new RegExp(`^cd -- (${word}) \\|\\| exit 1; `).exec(cmd))) {
    const dir = shellWord(m[1]).replace(/\/+$/, '') || '/';
    if (sftpTree.get(dir)?.type !== 'dir') return { output: `sh: cd: ${dir}: No such file or directory`, rc: 1 };
    const rest = cmd.slice(m[0].length);
    return rest === 'pwd' ? ok(dir) : mockExec(rest);
  }
  if ((m = /^sleep (\d+)/.exec(cmd))) return { output: '', rc: 0, delay: Number(m[1]) * 1000 };
  if ((m = /^exit (\d+)/.exec(cmd))) return { output: '', rc: Number(m[1]) };
  if (cmd === 'hostname') return ok('mock');
  if (cmd === 'whoami') return ok('root');
  if (cmd === 'uptime') return ok(' 10:00:00 up 1 day, 16:02,  1 user,  load average: 0.17, 0.08, 0.02');
  if (cmd === 'df -h') return ok('Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        29G   12G   16G  41% /\ntmpfs           2.0G     0  2.0G   0% /dev/shm');
  if (cmd === 'free -h') return ok('               total        used        free      shared  buff/cache   available\nMem:           3.8Gi       1.1Gi       1.2Gi        12Mi       1.5Gi       2.4Gi\nSwap:          2.0Gi       1.9Gi       100Mi');
  if (cmd.startsWith('echo ')) return ok(cmd.slice(5));
  if ((m = /^cat ([^\s]+)$/.exec(cmd)) && sftpTree.get(m[1])?.data) return ok(sftpTree.get(m[1]).data.toString('utf8'));
  if (cmd === 'printf %s "$HOME"') return ok('/root');
  // 传文件：查源（AI 的 copy 与命令行的 download 共用：都输出类型、[大小]、绝对路径）
  if ((m = new RegExp(`^p=(${word}); if \\[ -d`).exec(cmd))) {
    const path = shellWord(m[1]).replace(/\/+$/, '') || '/';
    const node = sftpTree.get(path);
    if (!node) return { output: 'missing', rc: 3 };
    if (node.type === 'dir') {
      const bytes = [...sftpTree.entries()].filter(([p]) => p.startsWith(`${path}/`)).reduce((sum, [, n]) => sum + (n.size || 0), 0);
      return ok(`dir\n${Math.ceil(bytes / 1024) || 4}\n${path}`);
    }
    return ok(`file\n${node.size}\n${path}`);
  }
  // 传文件：查目标落点
  if ((m = new RegExp(`^d=(${word}); case`).exec(cmd))) {
    const d = shellWord(m[1]);
    const name = shellWord(new RegExp(`f="\\$\\{d%/\\}/"(${quoted})`).exec(cmd)?.[1] ?? "''");
    const f = d.endsWith('/') || sftpTree.get(d)?.type === 'dir' ? `${d.replace(/\/+$/, '')}/${name}` : d;
    return ok(`${sftpTree.has(f) ? 'exists' : 'new'}\n${f}`);
  }
  // 直连：目标主机公钥、源上生成临时密钥、目标加临时公钥、清理
  if (cmd.startsWith('cat /etc/ssh/ssh_host_')) return ok('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockHostKeyMockHostKeyMockHostKeyMock root@mock');
  if (cmd.includes('ssh-keygen -q')) {
    const tag = /-C '([^']+)'/.exec(cmd)?.[1] ?? 'cloudssh-xfer';
    return ok(`/tmp/cloudssh.mock\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockClientKeyMockClientKeyMock ${tag}`);
  }
  // 临时公钥：跳板上带 permitopen（只许转发到下一跳），目标上只有 restrict
  if ((m = /'(restrict[^ ']*) ssh-ed25519 /.exec(cmd))) {
    console.log('ai-remote 临时公钥加入 authorized_keys：', m[1]);
    return ok();
  }
  if (cmd.includes('awk -v now=')) {
    console.log('ai-remote 临时公钥已清理');
    return ok();
  }
  // 源上写 known_hosts 与跳板链的 ssh 配置
  if (cmd.includes("/cfg'") && cmd.includes('Host cs-hop')) {
    const hops = (cmd.match(/'Host cs-hop\d+'/g) ?? []).length;
    const proxies = (cmd.match(/ProxyCommand ssh -F/g) ?? []).length;
    console.log(`ai-remote ssh 配置：${hops} 跳，${proxies} 条 ProxyCommand`);
    return ok();
  }
  // 直连传输：ssh 到目标（文件 cat > 、目录 tar 管道）
  if (cmd.includes('ssh -F ')) {
    const esc = String.raw`'\\''`;
    let src;
    let dest;
    if ((m = new RegExp(`^k=${quoted}; tar czf - -C (${quoted}) (${quoted}) \\|`).exec(cmd))) {
      src = `${shellWord(m[1]).replace(/\/+$/, '')}/${shellWord(m[2])}`;
      dest = new RegExp(`mkdir -p ${esc}(.*?)${esc} && tar xzf`).exec(cmd)?.[1];
    } else {
      src = shellWord(new RegExp(`< (${quoted})$`).exec(cmd)?.[1] ?? "''");
      dest = new RegExp(`cat > ${esc}(.*?)${esc}\\.cs-part`).exec(cmd)?.[1];
    }
    if (!dest || !sftpTree.has(src)) return { output: 'mock ssh: cannot parse transfer', rc: 255 };
    copyTree(src, dest.startsWith('/') ? dest : `/root/${dest}`);
    console.log('ai-remote 直连传输', src, '→', dest, `（连 ${/ cs-hop(\d+) /.exec(cmd)?.[1] ?? '?'} 号跳）`);
    return ok();
  }
  // 中转：源上打包、目标上解包
  if ((m = new RegExp(`^tar czf (${quoted}) -C (${quoted}) (${quoted})$`).exec(cmd))) {
    const archive = shellWord(m[1]);
    const root = `${shellWord(m[2]).replace(/\/+$/, '')}/${shellWord(m[3])}`;
    if (!sftpTree.has(root)) return { output: `tar: ${root}: No such file or directory`, rc: 2 };
    sftpPut(archive, 'file', 0, tarPack(root));
    sftpTree.get(archive).size = sftpTree.get(archive).data.length;
    return ok();
  }
  if ((m = new RegExp(`^mkdir -p (${quoted}) && tar xzf (${quoted}) -C ${quoted} --strip-components=1`).exec(cmd))) {
    tarExtract(shellWord(m[2]), shellWord(m[1]), 1);
    sftpTree.delete(shellWord(m[2]));
    return ok();
  }
  // 命令行上传目录：临时目录解包，目标已是目录就合并，否则改名过去
  if ((m = new RegExp(`^t=\\$\\(mktemp -d\\) && tar xzf (${quoted}) -C "\\$t";.*? f=(${quoted}); if`).exec(cmd))) {
    const archive = shellWord(m[1]);
    const dest = shellWord(m[2]);
    const name = shellWord(new RegExp(`"\\$t"/(${quoted})/\\. "\\$f"/`).exec(cmd)?.[1] ?? "''");
    const temp = `/tmp/mock-unpack-${Date.now()}`;
    try {
      tarExtract(archive, temp);
    } catch (error) {
      return { output: String(error), rc: 2 };
    }
    sftpTree.delete(archive);
    copyTree(`${temp}/${name}`, dest);
    removeTree(temp);
    return ok();
  }
  // 命令行上传文件：.cs-part 改名
  if ((m = new RegExp(`^mv -f (${quoted}) (${quoted})$`).exec(cmd))) {
    const from = shellWord(m[1]);
    const to = shellWord(m[2]);
    if (!sftpTree.has(from)) return { output: `mv: cannot stat '${from}'`, rc: 1 };
    copyTree(from, to);
    removeTree(from);
    return ok();
  }
  // 同机复制
  if ((m = new RegExp(`cp -a (${quoted})(/\\.)? (${quoted})/?$`).exec(cmd))) {
    copyTree(shellWord(m[1]), shellWord(m[3]).replace(/\/+$/, ''));
    return ok();
  }
  if ((m = new RegExp(`^mkdir -p "\\$\\(dirname -- (${quoted})\\)"`).exec(cmd))) {
    mkdirp(sftpParent(shellWord(m[1])));
    return ok();
  }
  if ((m = new RegExp(`^rm -r?f (${quoted})(\\.cs-part)?$`).exec(cmd))) {
    removeTree(shellWord(m[1]) + (m[2] ?? ''));
    return ok();
  }
  // MCP 的 write_file：查落点（相对路径从家目录算）、建上级目录
  if ((m = new RegExp(`^p=(${word}); case "\\$p" in /\\*\\)`).exec(cmd))) {
    let path = shellWord(m[1]);
    if (!path.startsWith('/')) path = `/root/${path}`;
    if (sftpTree.get(path)?.type === 'dir') return { output: 'dir', rc: 4 };
    mkdirp(sftpParent(path));
    return ok(`${sftpTree.has(path) ? 'exists' : 'new'}\n${path}`);
  }
  // write_file / edit_file：临时文件改名过去（核对 SHA-256、create 不覆盖、append 追加）
  if ((m = new RegExp(`^t=(${quoted}); f=(${quoted}); `).exec(cmd))) {
    const temp = shellWord(m[1]);
    const dest = shellWord(m[2]);
    const part = sftpTree.get(temp);
    if (!part) return { output: `mv: cannot stat '${temp}'`, rc: 1 };
    const expected = /\| cut -c1-64\)" = '([0-9a-f]{64})'/.exec(cmd)?.[1];
    const current = sftpTree.get(dest);
    if (expected && crypto.createHash('sha256').update(current?.data ?? Buffer.alloc(0)).digest('hex') !== expected) {
      sftpTree.delete(temp);
      return { output: '文件在读取之后被改过，没有写入', rc: 9 };
    }
    if (cmd.includes('已存在，没有写入') && current) {
      sftpTree.delete(temp);
      return { output: '已存在，没有写入', rc: 8 };
    }
    if (cmd.includes('cat "$t" >> "$f"')) {
      const data = Buffer.concat([current?.data ?? Buffer.alloc(0), part.data ?? Buffer.alloc(0)]);
      sftpPut(dest, 'file', data.length, data);
    } else {
      copyTree(temp, dest);
    }
    sftpTree.delete(temp);
    return ok();
  }
  // list_dir
  if ((m = new RegExp(`^p=(${word}); cd -- "\\$p"`).exec(cmd))) {
    const path = shellWord(m[1]).replace(/\/+$/, '') || '/';
    if (sftpTree.get(path)?.type !== 'dir') return { output: `没有这个目录：${path}`, rc: 3 };
    const hidden = /ls -lA/.test(cmd);
    const rows = [...sftpTree.entries()]
      .filter(([p]) => sftpParent(p) === path && p !== path)
      .map(([p, node]) => ({ name: p.slice(path.length + (path === '/' ? 0 : 1)), node }))
      .filter((item) => hidden || !item.name.startsWith('.'))
      .sort((a, b) => (a.node.type === b.node.type ? a.name.localeCompare(b.name) : a.node.type === 'dir' ? -1 : 1))
      .map(({ name, node }) => `${node.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--'} 1 root root ${node.size || 4096} 2026-10-20 10:00 ${name}`);
    return ok([path, `total ${rows.length}`, ...rows].join('\n'));
  }
  // start_job / job_status：任务直接记成结束（命令里有 sleep 的记成运行中，直到被停止）
  if ((m = /^d="\$HOME\/\.cloudssh-jobs"; mkdir -p .*? id='(j[a-z0-9]+)'; printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d/.exec(cmd))) {
    const cwd = new RegExp(`cd -- (${word}) \\|\\|`).exec(cmd);
    if (cwd && sftpTree.get(shellWord(cwd[1]).replace(/\/+$/, ''))?.type !== 'dir') return { output: `没有这个目录：${shellWord(cwd[1])}`, rc: 3 };
    const command = Buffer.from(m[2], 'base64').toString('utf8');
    mockJobs.set(m[1], { command, state: /\bsleep\b/.test(command) ? 'running' : 'done', log: `mock job: ${command}\nfinished` });
    return ok(`started ${m[1]}`);
  }
  if (cmd.startsWith('d="$HOME/.cloudssh-jobs"; n=0; for c in')) {
    const rows = [...mockJobs.entries()].reverse().map(([id, job]) => `${id}  ${jobState(job)}  ${job.command.slice(0, 100)}`);
    return ok(rows.length ? rows.join('\n') : '（没有后台任务）');
  }
  if ((m = /^d="\$HOME\/\.cloudssh-jobs"; id='(j[a-z0-9]+)'; \[ -f/.exec(cmd))) {
    const job = mockJobs.get(m[1]);
    if (!job) return { output: '没有这个任务', rc: 3 };
    if (cmd.includes('kill -TERM') && job.state === 'running') job.state = 'stopped';
    const tail = Number(/最后 (\d+) 行/.exec(cmd)?.[1] ?? 50);
    return ok(`状态：${jobState(job)}\n== 命令\n${job.command}\n== 输出（最后 ${tail} 行）\n${job.state === 'running' ? '' : job.log}`);
  }
  return { output: `sh: ${cmd.split(/\s+/)[0]}: command not found (mock)`, rc: 127 };
}

function mockRemoteLine(line, write) {
  const out = (text) => write(text.replace(/\n/g, '\r\n'));
  let m = /CSRDY%s\\n' '(\w+)'/.exec(line);
  if (m) return out(`__CSRDY${m[1]}\n`);
  m = /CSBEG%s\\n' '(\w+)'; \{ cs_run (\d+) ('(?:[^']|'\\'')*'|"\$\(printf %s '([A-Za-z0-9+/=]+)' \| base64 -d\)") <\/dev\/null/.exec(line);
  if (!m) return out('mock: unrecognized remote line\n');
  const id = m[1];
  const cmd = m[4] ? Buffer.from(m[4], 'base64').toString('utf8') : m[3].slice(1, -1).replace(/'\\''/g, "'");
  console.log('ai-remote exec:', cmd.length > 160 ? `${cmd.slice(0, 160)}…` : cmd);
  const { output, rc, delay } = mockExec(cmd);
  setTimeout(() => out(`__CSBEG${id}\n${output}\n__CSRC${rc}\n__CSEND${id}\n`), delay ?? 30);
}

function attachShell(ws, url) {
  const sessionId = `session:mock:${crypto.randomUUID()}`;
  const write = (text) => ws.sendBinary(Buffer.from(text, 'utf8'));
  ws.sendJson({ type: 'rtt', latency: 18, colo: 'HKG' });
  ws.sendJson({ type: 'session_created', sessionId, resumeToken: crypto.randomUUID() });
  ws.sendJson({ type: 'sftp_attach', url: `ws://${url.host}/api/ssh/sftp?session=${encodeURIComponent(sessionId)}&token=sftp-${Date.now()}` });
  // 标了 stall 的服务器卡在认证，永远到不了 Shell 就绪
  const tokenId = Number(/^mock-(\d+)-/.exec(url.searchParams.get('token') ?? '')?.[1]);
  const stall = servers.find((s) => s.id === tokenId)?.stall === true;
  const allSteps = ['version_exchange', 'version_ready', 'host_key_verified', 'auth_service_accepted', 'auth_public_key', 'auth_success', 'shell_ready'];
  const steps = stall ? allSteps.slice(0, 5) : allSteps;
  const messages = { version_exchange: '正在交换版本信息...', version_ready: '版本交换完成，正在密钥协商...', host_key_verified: '主机密钥验证通过 (ssh-ed25519) ✓', auth_service_accepted: '认证服务已接受，正在认证...', auth_public_key: '正在使用密钥认证...', auth_success: '认证成功', shell_ready: 'Shell 已就绪' };
  steps.forEach((event, index) => setTimeout(() => ws.sendJson({ type: 'status', message: messages[event], event }), 60 * (index + 1)));
  if (!stall) setTimeout(() => write(`欢迎使用 CloudSSH 假 shell（输入 help 查看命令）\r\n${PROMPT}`), 60 * (steps.length + 1));
  const connected = servers.find((s) => s.id === tokenId);
  if (!stall && connected && !connected.os) {
    setTimeout(() => {
      connected.os = 'ubuntu';
      ws.sendJson({ type: 'os_detected', serverId: connected.id, os: 'ubuntu' });
    }, 60 * (steps.length + 1) + 800);
  }

  let line = '';
  /** 光标在 line 里的位置（第几个字）：左 / 右方向键移动，打字插在光标处（像 readline） */
  let pos = 0;
  /** 收到的左 / 右键数与越界次数（在行首按左、行尾按右），lines 命令显示，用来调试手机端点按定位 */
  const arrows = { left: 0, right: 0, overflow: 0 };
  const lineKey = (sequence) => {
    const chars = [...line];
    if (sequence === '\x1b[D' || sequence === '\x1bOD') {
      arrows.left++;
      if (pos === 0) {
        arrows.overflow++;
        return write('\x07');
      }
      pos--;
      write('\b'.repeat(cellWidth(chars[pos])));
    } else if (sequence === '\x1b[C' || sequence === '\x1bOC') {
      arrows.right++;
      if (pos >= chars.length) {
        arrows.overflow++;
        return write('\x07');
      }
      write(chars[pos]);
      pos++;
    }
  };
  /** 客户端报告的终端尺寸（resize 消息），size 命令显示它 */
  const term = { cols: 80, rows: 24 };
  /**
   * pager 命令：像 less / nano 那样进备用屏幕、开光标键应用模式，上 / 下方向键滚动 200 行内容，q 退出。
   * 状态行显示收到的上 / 下键数，用来调试手机端在全屏程序里的滑动（alt-scroll）
   */
  let pager = null;
  const PAGER_LINES = 200;
  const drawPager = () => {
    const height = Math.max(3, term.rows - 1);
    pager.top = Math.max(0, Math.min(PAGER_LINES - height, pager.top));
    const body = Array.from({ length: height }, (_, i) => `第 ${pager.top + i + 1} 行  ${'·'.repeat(10)}`);
    write(`\x1b[H\x1b[2J${body.join('\r\n')}\r\n\x1b[7m pager  第 ${pager.top + 1} 行起  收到 上 ${pager.up} / 下 ${pager.down}  （q 退出）\x1b[0m`);
  };
  /**
   * nano 命令：画一个像 nano 的界面（第一行反显的“GNU nano 7.2”标题栏、底部帮助栏），开括号粘贴与光标键应用模式；
   * Alt+M 开关鼠标支持（SGR），开着时收到点击就把光标移过去并记日志；Ctrl+X 退出。用来调试点哪光标到哪
   */
  let nano = null;
  const drawNano = () => {
    const width = term.cols;
    const title = `  GNU nano 7.2${' '.repeat(Math.max(1, Math.floor(width / 2) - 18))}test.txt`;
    const lines = [`\x1b[H\x1b[2J\x1b[7m${title.padEnd(width).slice(0, width)}\x1b[0m`];
    for (let row = 2; row <= term.rows - 3; row++) lines.push(`第 ${row - 1} 行：nano 测试文本 hello world`);
    lines.push('', `\x1b[7m^G\x1b[0m 帮助  \x1b[7m^O\x1b[0m 写入  \x1b[7m^X\x1b[0m 退出  \x1b[7mM-M\x1b[0m 鼠标`, `\x1b[7m^K\x1b[0m 剪切  \x1b[7m^U\x1b[0m 粘贴`);
    write(`${lines.join('\r\n')}\x1b[${nano.row};${nano.col}H`);
  };
  const nanoStatus = (text) => write(`\x1b7\x1b[${term.rows - 2};1H\x1b[2K\x1b[7m[ ${text} ]\x1b[0m\x1b8`);
  const nanoKey = (sequence) => {
    let m;
    if (sequence === '\x1bm' || sequence === '\x1bM') {
      nano.mouse = !nano.mouse;
      write(nano.mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
      nanoStatus(nano.mouse ? '已启用鼠标支持' : '已禁用鼠标支持');
      console.log(`nano：鼠标${nano.mouse ? '打开' : '关闭'}`);
    } else if ((m = /^\x1b\[<0;(\d+);(\d+)M$/.exec(sequence)) && nano.mouse) {
      const now = Date.now();
      // 像真的 nano：同一位置很快点两下是双击，设下标记
      const double = nano.last && nano.last.col === Number(m[1]) && nano.last.row === Number(m[2]) && now - nano.last.at < 400;
      nano.col = Number(m[1]);
      nano.row = Number(m[2]);
      nano.clicks++;
      nano.last = double ? null : { col: nano.col, row: nano.row, at: now };
      write(`\x1b[${nano.row};${nano.col}H`);
      if (double) nanoStatus('Mark Set');
      console.log(`nano：${double ? '双击（设下标记 Mark Set）' : '点击'} 第 ${nano.row} 行 第 ${nano.col} 列`);
    } else if (sequence === '\x18') {
      nano = null;
      write(`\x1b[?1000l\x1b[?1006l\x1b[?1l\x1b[?1049l${PROMPT}`);
    }
  };
  const pagerKey = (sequence) => {
    if (sequence === '\x1b[A' || sequence === '\x1bOA') {
      pager.up++;
      pager.top--;
    } else if (sequence === '\x1b[B' || sequence === '\x1bOB') {
      pager.down++;
      pager.top++;
    } else if (sequence === 'q') {
      pager = null;
      write(`\x1b[?1000l\x1b[?1006l\x1b[?1l\x1b[?1049l${PROMPT}`);
      return;
    } else return;
    drawPager();
  };
  return (data) => {
    if (typeof data === 'string' && data.startsWith('{')) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') ws.sendJson({ type: 'pong', ...(msg.id ? { id: msg.id } : {}) });
        if (msg.type === 'resize' && Number(msg.cols) > 0 && Number(msg.rows) > 0) Object.assign(term, { cols: Number(msg.cols), rows: Number(msg.rows) });
        if (msg.type === 'agent_start') mockAgentReply(ws, msg);
        if (msg.type === 'agent_reset') mockAgentReset(ws);
        if (msg.type === 'agent_stop') mockAgentStop(ws);
        if (msg.type === 'agent_confirm') agentState(ws).pendingConfirm?.(msg);
        return;
      } catch {
        // 不是 JSON，当作键盘输入
      }
    }
    const text = typeof data === 'string' ? data : data.toString('utf8');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\x1b') {
        // 方向键等转义序列：pager 里滚动，其他时候跳过
        // CSI（含 SGR 鼠标报告 ESC [ < …）、SS3（ESC O x）、Alt+字母（ESC x）
        const rest = /^\x1b(\[[<0-9;?]*[ -/]*[@-~]|O.|[a-zA-Z])/.exec(text.slice(i));
        if (rest) i += rest[0].length - 1;
        if (nano && rest) nanoKey(rest[0]);
        else if (pager && rest) pagerKey(rest[0]);
        else if (rest) lineKey(rest[0]);
        continue;
      }
      if (nano) {
        nanoKey(ch);
        continue;
      }
      if (pager) {
        pagerKey(ch);
        continue;
      }
      if ((ch === '\r' || ch === '\n') && line.trim() === 'nano') {
        line = '';
        pos = 0;
        nano = { mouse: false, row: 2, col: 1, clicks: 0 };
        write('\r\n\x1b[?1049h\x1b[?1h');
        drawNano();
        continue;
      }
      if ((ch === '\r' || ch === '\n') && /^pager( -m)?$/.test(line.trim())) {
        // 像 nano：括号粘贴照开（提示符已经开了）；pager -m 再开鼠标模式（SGR）
        const mouse = line.trim() === 'pager -m';
        line = '';
        pos = 0;
        pager = { top: 0, up: 0, down: 0, mouse };
        write(`\r\n\x1b[?1049h\x1b[?1h${mouse ? '\x1b[?1000h\x1b[?1006h' : ''}`);
        drawPager();
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        // 客户端 AI 跨服务器操作的后台会话（ai-remote）：命令带 \137\137CS 标记，按协议回应，不打印提示符
        if (line.includes('\\137\\137CS')) {
          mockRemoteLine(line, write);
          line = '';
          pos = 0;
          continue;
        }
        if (line.trim()) console.log(`行编辑：执行 ${JSON.stringify(line)}，收到 ← ${arrows.left} / → ${arrows.right}，越界 ${arrows.overflow}`);
        // 执行命令时关括号粘贴（像 readline），提示符处再打开（PROMPT 末尾带着）
        write('\x1b[?2004l\r\n');
        if (line.trim() === 'exit') {
          write('logout\r\n');
          setTimeout(() => ws.close(1000), 50);
          return;
        }
        const delay = runCommand(line, write, term, ws);
        line = '';
        pos = 0;
        if (delay) setTimeout(() => write(PROMPT), delay);
        else write(PROMPT);
      } else if (ch === '\x7f' || ch === '\b') {
        const chars = [...line];
        if (pos > 0) {
          const removed = chars.splice(pos - 1, 1)[0];
          pos--;
          line = chars.join('');
          const rest = chars.slice(pos).join('');
          write(`${'\b'.repeat(cellWidth(removed))}${rest}${' '.repeat(cellWidth(removed))}${'\b'.repeat(cellWidth(rest) + cellWidth(removed))}`);
        }
      } else if (ch === '\x03') {
        line = '';
        pos = 0;
        write(`^C\r\n${PROMPT}`);
      } else if (ch === '\t') {
        // 不做补全
      } else if (ch >= ' ') {
        const chars = [...line];
        chars.splice(pos, 0, ch);
        pos++;
        line = chars.join('');
        const rest = chars.slice(pos).join('');
        // 后台会话关了回显（stty -echo），这里也不回显
        if (!line.startsWith(' ') || !line.includes('\\137')) write(`${ch}${rest}${'\b'.repeat(cellWidth(rest))}`);
      }
    }
  };
}

// SFTP：内存里的小文件系统（所有连接共用），支持列目录、新建目录、上传、下载，够调试拖放上传/拖出下载
const sftpTree = new Map();
function sftpPut(path, type, size = 0, data = null) {
  sftpTree.set(path, { type, size, data, mtime: Math.floor(now / 1000) - 3600 });
}
sftpPut('/root', 'dir');
for (const name of ['.config', '.ssh', 'backups', 'www']) sftpPut(`/root/${name}`, 'dir');
sftpPut('/root/.bashrc', 'file', 0, Buffer.from(['# ~/.bashrc', 'export PS1="\\u@\\h:\\w\\$ "', 'alias ll="ls -la"', ''].join('\n')));
sftpPut('/root/deploy.sh', 'file', 0, Buffer.from(['#!/bin/sh', 'set -e', 'echo deploying...', 'sleep 1', 'echo done', ''].join('\n')));
sftpPut('/root/notes.txt', 'file', 0, Buffer.from('CloudSSH mock notes\n'.repeat(40)));
sftpPut('/root/data.tar.gz', 'file', 73400320);
sftpPut('/root/www/index.html', 'file', 0, Buffer.from('<h1>mock site</h1>\n'));
sftpPut('/root/www/assets', 'dir');
sftpPut('/root/www/assets/app.js', 'file', 0, Buffer.from('console.log("mock");\n'));
sftpPut('/tmp', 'dir');
for (const node of sftpTree.values()) if (node.data) node.size = node.data.length;

function sftpParent(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function sftpEntries(dir) {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  return [...sftpTree.entries()]
    .filter(([path]) => path !== dir && path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(([path, node]) => {
      const name = path.slice(prefix.length);
      const isDir = node.type === 'dir';
      const size = node.size;
      return {
        name,
        type: node.type,
        size,
        sizeFormatted: isDir ? '-' : size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`,
        permissions: isDir ? 'drwxr-xr-x' : '-rw-r--r--',
        permissionsRaw: isDir ? 0o40755 : 0o100644,
        modifiedTime: node.mtime,
        isDir,
        isLink: false,
      };
    });
}

function attachSftp(ws) {
  ws.sendJson({ type: 'sftp_socket_ready' });
  let upload = null;
  return (data) => {
    if (typeof data !== 'string') {
      if (!upload) return;
      upload.chunks.push(Buffer.from(data));
      upload.loaded += data.length;
      ws.sendJson({ type: 'sftp_upload_progress', loaded: upload.loaded, total: upload.size });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const error = (operation, message) => ws.sendJson({ type: 'sftp_error', operation, message });
    if (msg.type === 'sftp_init') ws.sendJson({ type: 'sftp_ready', isTunnel: false });
    else if (msg.type === 'sftp_list') {
      const path = !msg.path || msg.path === '~' ? '/root' : msg.path;
      if (sftpTree.get(path)?.type !== 'dir') return error('list', 'No such file');
      ws.sendJson({ type: 'sftp_list_result', path, entries: sftpEntries(path) });
    } else if (msg.type === 'sftp_mkdir') {
      if (sftpTree.has(msg.path)) return error('mkdir', 'Failure');
      if (sftpTree.get(sftpParent(msg.path))?.type !== 'dir') return error('mkdir', 'No such file');
      sftpPut(msg.path, 'dir');
      ws.sendJson({ type: 'sftp_mkdir_result', path: msg.path, success: true });
    } else if (msg.type === 'sftp_upload_start') {
      const existing = sftpTree.get(msg.path);
      if (sftpTree.get(sftpParent(msg.path))?.type !== 'dir') return error('upload', 'No such file');
      if (existing && !msg.overwrite) return ws.sendJson({ type: 'sftp_upload_conflict', path: msg.path, existingSize: existing.size });
      upload = { path: msg.path, size: msg.size, loaded: 0, chunks: [] };
      ws.sendJson({ type: 'sftp_upload_ready', isTunnel: false });
      if (msg.size === 0) ws.sendJson({ type: 'sftp_upload_progress', loaded: 0, total: 0 });
    } else if (msg.type === 'sftp_upload_end' && upload) {
      sftpPut(upload.path, 'file', 0, Buffer.concat(upload.chunks));
      sftpTree.get(upload.path).size = upload.loaded;
      sftpTree.get(upload.path).mtime = Math.floor(Date.now() / 1000);
      console.log('SFTP 上传', upload.path, upload.loaded, 'bytes');
      ws.sendJson({ type: 'sftp_upload_complete', path: upload.path, hash: null, hashMatch: null });
      upload = null;
    } else if (msg.type === 'sftp_upload_cancel') {
      upload = null;
      ws.sendJson({ type: 'sftp_upload_cancelled' });
    } else if (msg.type === 'sftp_download') {
      const node = sftpTree.get(msg.path);
      if (!node || node.type !== 'file') return error('download', 'No such file');
      const filename = msg.path.slice(msg.path.lastIndexOf('/') + 1);
      const bytes = node.data ?? Buffer.alloc(node.size, 0x2e);
      ws.sendJson({ type: 'sftp_download_start', filename, size: bytes.length });
      const CHUNK = 256 * 1024;
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        ws.sendBinary(bytes.subarray(offset, offset + CHUNK));
        ws.sendJson({ type: 'sftp_download_progress', loaded: Math.min(offset + CHUNK, bytes.length), total: bytes.length });
      }
      ws.sendJson({ type: 'sftp_download_done', filename });
      console.log('SFTP 下载', msg.path, bytes.length, 'bytes');
    } else if (msg.type === 'sftp_close') ws.close(1000);
  };
}

// ---------- 服务 ----------

http
  .createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      console.error(error);
      json(res, 500, { error: 'mock error' });
    });
  })
  .on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    console.log('WS', url.pathname);
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`, '', ''].join('\r\n'));
    let handler = () => {};
    const ws = createSocket(socket, (data) => handler(data));
    if (url.pathname === '/api/ssh/sftp') handler = attachSftp(ws);
    else if (url.pathname === '/api/ssh') handler = attachShell(ws, url);
    else ws.close(1008);
  })
  // 端口写 0 时由系统分配，打印实际端口（命令行的测试这样起）
  .listen(port, '127.0.0.1', function () {
    console.log(`mock worker on http://127.0.0.1:${this.address().port}`);
  });
