#!/usr/bin/env node
/**
 * 假 Worker：不连真实服务器也能调试客户端界面（节点列表、终端、SFTP、常用命令）。
 *
 *   node scripts/mock-worker.mjs [端口，默认 8788]
 *   node scripts/mock-worker.mjs 8788 --ui packages/ui-web/dist   # 同时托管构建好的界面，浏览器直接打开调试
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
  server('HK-C 香港三号', ['香港 🇭🇰'], '203.0.113.3'),
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
];

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

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname;
  const method = req.method;
  console.log(method, path);

  if (path === '/api/config') return json(res, 200, { turnstileEnabled: false, githubAuthEnabled: true, requireGithubAuth: false, authMode: 'github', sharingEnabled: false });
  if (path === '/api/auth/me') return json(res, 200, { id: 1, github_id: 1, username: 'tester', avatar_url: null });
  if (path === '/api/servers' && method === 'GET') return json(res, 200, servers);
  if (path === '/api/health') return json(res, 200, { ok: true });
  if (path === '/api/known-hosts' && method === 'GET') return json(res, 200, []);

  const connect = /^\/api\/servers\/(\d+)\/connect$/.exec(path);
  if (connect && method === 'POST') {
    const target = servers.find((s) => s.id === Number(connect[1]));
    if (target) target.last_connected_at = Date.now();
    return json(res, 200, { wsUrl: `ws://${req.headers.host}/api/ssh?token=mock-${connect[1]}-${Date.now()}` });
  }

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
const HELP = [
  '可用命令：help  ls  date  uname -a  echo <文本>  seq <n>  colors  top  clear  exit',
  '其他命令会原样回显为“已执行”，方便测试常用命令的插入与执行。',
].join('\r\n');

function runCommand(line, write) {
  const [command, ...args] = line.trim().split(/\s+/);
  if (!command) return;
  switch (command) {
    case 'help':
      write(`${HELP}\r\n`);
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
    case 'top':
      write('top - 12:00:00 up 3 days,  load average: 0.10, 0.08, 0.05\r\nTasks: 120 total,   1 running\r\n%Cpu(s):  2.0 us,  1.0 sy, 97.0 id\r\nMiB Mem :   1985.6 total,   512.3 free\r\n');
      break;
    case 'clear':
      write('\x1b[2J\x1b[H');
      break;
    default:
      write(`\x1b[2m（模拟）已执行：${line.trim()}\x1b[0m\r\n`);
  }
}

function attachShell(ws, url) {
  const sessionId = `session:mock:${crypto.randomUUID()}`;
  const write = (text) => ws.sendBinary(Buffer.from(text, 'utf8'));
  ws.sendJson({ type: 'rtt', latency: 18, colo: 'HKG' });
  ws.sendJson({ type: 'session_created', sessionId, resumeToken: crypto.randomUUID() });
  ws.sendJson({ type: 'sftp_attach', url: `ws://${url.host}/api/ssh/sftp?session=${encodeURIComponent(sessionId)}&token=sftp-${Date.now()}` });
  const steps = ['version_exchange', 'version_ready', 'host_key_verified', 'auth_service_accepted', 'auth_public_key', 'auth_success', 'shell_ready'];
  const messages = { version_exchange: '正在交换版本信息...', version_ready: '版本交换完成，正在密钥协商...', host_key_verified: '主机密钥验证通过 (ssh-ed25519) ✓', auth_service_accepted: '认证服务已接受，正在认证...', auth_public_key: '正在使用密钥认证...', auth_success: '认证成功', shell_ready: 'Shell 已就绪' };
  steps.forEach((event, index) => setTimeout(() => ws.sendJson({ type: 'status', message: messages[event], event }), 60 * (index + 1)));
  setTimeout(() => write(`欢迎使用 CloudSSH 假 shell（输入 help 查看命令）\r\n${PROMPT}`), 60 * (steps.length + 1));

  let line = '';
  return (data) => {
    if (typeof data === 'string' && data.startsWith('{')) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') ws.sendJson({ type: 'pong', ...(msg.id ? { id: msg.id } : {}) });
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
        runCommand(line, write);
        line = '';
        write(PROMPT);
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

function attachSftp(ws) {
  ws.sendJson({ type: 'sftp_socket_ready' });
  const entries = [
    ['.config', 'dir'],
    ['.ssh', 'dir'],
    ['backups', 'dir'],
    ['www', 'dir'],
    ['.bashrc', 'file', 3771],
    ['deploy.sh', 'file', 2140],
    ['notes.txt', 'file', 815],
    ['data.tar.gz', 'file', 73400320],
  ].map(([name, type, size = 0]) => ({
    name,
    type,
    size,
    sizeFormatted: type === 'dir' ? '-' : size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`,
    permissions: type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--',
    permissionsRaw: type === 'dir' ? 0o40755 : 0o100644,
    modifiedTime: Math.floor(now / 1000) - 3600,
    isDir: type === 'dir',
    isLink: false,
  }));
  return (data) => {
    if (typeof data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'sftp_init') ws.sendJson({ type: 'sftp_ready', isTunnel: false });
    else if (msg.type === 'sftp_list') {
      const path = !msg.path || msg.path === '~' ? '/root' : msg.path;
      ws.sendJson({ type: 'sftp_list_result', path, entries: path === '/root' ? entries : [] });
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
