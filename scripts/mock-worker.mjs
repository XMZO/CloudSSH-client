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

const args = process.argv.slice(2);
const port = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 8788);
const uiArg = args.indexOf('--ui');
const uiDir = uiArg >= 0 && args[uiArg + 1] ? nodePath.resolve(args[uiArg + 1]) : null;
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
  let file = nodePath.join(uiDir, decodeURIComponent(pathname));
  // 只允许目录内的文件；目录或不存在的路径交给单页应用的 index.html
  if (!file.startsWith(uiDir + nodePath.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = nodePath.join(uiDir, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[nodePath.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
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

const PROMPT = '\x1b[1;32mroot@mock\x1b[0m:\x1b[1;34m~\x1b[0m# ';
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
  '可用命令：help  ls  date  uname -a  echo <文本>  seq <n>  colors  top  logs  menu  size  clear  exit',
  '调试后台提醒：sleep <秒>（隔这么久才回到提示符）  bell（响铃）  notify <文本>（OSC 9 通知）  drop（模拟断网）',
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
    default:
      write(`\x1b[2m（模拟）已执行：${line.trim()}\x1b[0m\r\n`);
  }
  return 0;
}

// AI 助手：打印收到的完整 message（调试客户端附加的回复风格提示），再流式返回一份固定的巡检报告（调试回复配色与状态高亮）
const AGENT_REPLY = [
  '我将并行采集 CPU、内存、磁盘三类信息。',
  '',
  '## 系统资源巡检报告',
  '',
  '**主机**: mock-pi (aarch64)  **运行时长**: 1 天 16 小时  **结论**: ✅ 三个维度都在健康区间，无需干预。',
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
  '- ✅ `/` 已用 41%（12G / 29G）',
  '- ⚠️ `/var/log` 增长较快，近 7 天新增 2.1G',
  '- ❌ `/boot/firmware` 只剩 3% 可用空间',
  '',
  '### 建议',
  '',
  '1. 清理旧日志：',
  '',
  '```bash',
  'sudo journalctl --vacuum-time=7d',
  '```',
].join('\n');

function mockAgentReply(ws, msg) {
  console.log('AGENT 收到的 message ↓\n' + msg.message + '\nAGENT ↑');
  const frame = (subType, extra = {}) => ws.sendJson({ type: 'agent_frame', runId: 'mock-run', requestId: msg.requestId, subType, ...extra });
  frame('run_start');
  const pieces = AGENT_REPLY.match(/[\s\S]{1,60}/g);
  pieces.forEach((piece, index) => setTimeout(() => frame('stream_chunk', { content: piece }), 40 * (index + 1)));
  setTimeout(() => {
    frame('stream_end', { content: AGENT_REPLY });
    frame('run_end', { outcome: 'completed' });
  }, 40 * (pieces.length + 2));
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
  /** 客户端报告的终端尺寸（resize 消息），size 命令显示它 */
  const term = { cols: 80, rows: 24 };
  return (data) => {
    if (typeof data === 'string' && data.startsWith('{')) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') ws.sendJson({ type: 'pong', ...(msg.id ? { id: msg.id } : {}) });
        if (msg.type === 'resize' && Number(msg.cols) > 0 && Number(msg.rows) > 0) Object.assign(term, { cols: Number(msg.cols), rows: Number(msg.rows) });
        if (msg.type === 'agent_start') mockAgentReply(ws, msg);
        return;
      } catch {
        // 不是 JSON，当作键盘输入
      }
    }
    const text = typeof data === 'string' ? data : data.toString('utf8');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\x1b') {
        // 方向键等转义序列：跳过
        const rest = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(text.slice(i));
        if (rest) i += rest[0].length - 1;
        continue;
      }
      if (ch === '\r') {
        write('\r\n');
        if (line.trim() === 'exit') {
          write('logout\r\n');
          setTimeout(() => ws.close(1000), 50);
          return;
        }
        const delay = runCommand(line, write, term, ws);
        line = '';
        if (delay) setTimeout(() => write(PROMPT), delay);
        else write(PROMPT);
      } else if (ch === '\x7f' || ch === '\b') {
        if (line.length) {
          line = [...line].slice(0, -1).join('');
          write('\b \b');
        }
      } else if (ch === '\x03') {
        line = '';
        write(`^C\r\n${PROMPT}`);
      } else if (ch === '\t') {
        // 不做补全
      } else if (ch >= ' ') {
        line += ch;
        write(ch);
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
  .listen(port, '127.0.0.1', () => console.log(`mock worker on http://127.0.0.1:${port}`));
