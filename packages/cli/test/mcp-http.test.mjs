/**
 * cloudssh mcp http（远程 MCP，给云端 AI 用）对假 Worker 的端到端测试：发现文档与 401、动态注册、授权页口令与锁定、
 * PKCE 与授权码、令牌刷新与吊销、MCP over HTTP（工具、完全权限、不提供的服务器、通知 202），以及只读模式的命令判定。
 * 先 node build.mjs 打好 dist/cloudssh.mjs。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { CLI, isolatedEnv, runCli, startMock } from './helpers.mjs';

const PASSWORD = 'correct horse battery staple';
const PUBLIC = 'https://mcp.example.test';
const REDIRECT = 'https://client.example.test/callback';

async function hashPassword(env) {
  const result = await spawnSyncInput(['mcp', 'http', '--hash-password'], env, `${PASSWORD}\n`);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function spawnSyncInput(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** 起 cloudssh mcp http，等它报出监听地址 */
async function startHttp(env, args) {
  const child = spawn(process.execPath, [CLI, 'mcp', 'http', '--listen', '127.0.0.1:0', '--public-url', PUBLIC, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const base = await new Promise((resolve, reject) => {
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      stderr += `${line}\n`;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (match) resolve(match[1]);
    });
    child.on('exit', (code) => reject(new Error(`mcp http 退出了（${code}）\n${stderr}`)));
  });
  return { base, child, get stderr() { return stderr; }, stop: () => child.kill() };
}

const verifier = () => crypto.randomBytes(32).toString('base64url');
const challengeOf = (value) => crypto.createHash('sha256').update(value).digest('base64url');

async function register(base, body = { client_name: 'Test client', redirect_uris: [REDIRECT] }) {
  const response = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function authorizeUrl(base, clientId, extra = {}) {
  const url = new URL(`${base}/authorize`);
  const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'st-1', scope: 'cloudssh', resource: `${PUBLIC}/mcp`, ...extra };
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url;
}

/** 走完授权：打开授权页、交口令，返回跳回去的地址 */
async function approve(base, clientId, challenge, password = PASSWORD) {
  const page = await fetch(authorizeUrl(base, clientId, { code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
  assert.equal(page.status, 200);
  const html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(request, html);
  const response = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, password }),
    redirect: 'manual',
  });
  return response;
}

async function tokenRequest(base, fields) {
  const response = await fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { status: response.status, body: await response.json() };
}

/** 注册 + 授权 + 换令牌 */
async function login(base) {
  const client = (await register(base)).body;
  const codeVerifier = verifier();
  const redirect = await approve(base, client.client_id, challengeOf(codeVerifier));
  const code = new URL(redirect.headers.get('location')).searchParams.get('code');
  const tokens = await tokenRequest(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: codeVerifier });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return { client, tokens: tokens.body };
}

let rpcId = 1;
async function rpc(base, token, method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function callTool(base, token, name, args) {
  const response = await rpc(base, token, 'tools/call', { name, arguments: args });
  assert.equal(response.status, 200);
  if (response.body.error) throw new Error(`JSON-RPC 错误：${response.body.error.message}`);
  return { text: response.body.result.content.map((part) => part.text).join(''), isError: !!response.body.result.isError };
}

describe('cloudssh mcp http', { timeout: 180_000 }, () => {
  let mock;
  let env;
  let server;
  let excluded;

  before(async () => {
    mock = await startMock();
    ({ env } = isolatedEnv(mock.url));
    env.CLOUDSSH_MCP_PASSWORD_HASH = await hashPassword(env);
    const servers = await (await fetch(`${mock.url}/api/servers`, { headers: { Cookie: 'session=test' } })).json();
    excluded = servers.find((item) => item.name.startsWith('JP-B'));
    server = await startHttp(env, ['--access', 'full', '--exclude', `srv-${excluded.id}`]);
  });

  after(() => {
    server?.stop();
    mock?.stop();
  });

  test('口令哈希：太短拒绝；不设口令哈希或对外地址不对时不启动', async () => {
    const short = await spawnSyncInput(['mcp', 'http', '--hash-password'], env, 'short\n');
    assert.notEqual(short.code, 0);
    assert.match(short.stderr, /至少 12 个字符/);
    const { CLOUDSSH_MCP_PASSWORD_HASH: _, ...noHash } = env;
    const missing = runCli(['mcp', 'http', '--public-url', PUBLIC], noHash);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /CLOUDSSH_MCP_PASSWORD_HASH/);
    const http = runCli(['mcp', 'http', '--public-url', 'http://mcp.example.test'], env);
    assert.notEqual(http.code, 0);
    assert.match(http.stderr, /https/);
  });

  test('发现文档；没带令牌访问 /mcp 回 401 并指向资源元数据', async () => {
    const resource = await (await fetch(`${server.base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(resource.resource, `${PUBLIC}/mcp`);
    assert.deepEqual(resource.authorization_servers, [PUBLIC]);
    const metadata = await (await fetch(`${server.base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.issuer, PUBLIC);
    assert.equal(metadata.token_endpoint, `${PUBLIC}/token`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    const denied = await rpc(server.base, null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
    const bad = await rpc(server.base, 'not-a-token', 'ping');
    assert.equal(bad.status, 401);
  });

  test('扫描器的怪路径：回 404，不报错', async () => {
    const net = await import('node:net');
    const { port } = new URL(server.base);
    for (const path of ['//..%2f.env', '//evil.example/x', '/..%2f..%2fetc/passwd']) {
      const status = await new Promise((resolve, reject) => {
        // fetch 会先规范化路径，这里用原始请求行
        const socket = net.connect(Number(port), '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let data = '';
        socket.on('data', (chunk) => (data += chunk));
        socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1])));
        socket.on('error', reject);
      });
      assert.equal(status, 404, path);
    }
    assert.doesNotMatch(server.stderr, /出错/);
  });

  test('动态注册：回调地址要是 https（或本机 http），否则拒绝', async () => {
    assert.equal((await register(server.base, { redirect_uris: ['http://evil.example/cb'] })).status, 400);
    assert.equal((await register(server.base, { redirect_uris: [] })).status, 400);
    assert.equal((await register(server.base, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' })).status, 400);
    const ok = await register(server.base, { client_name: 'Local', redirect_uris: ['http://127.0.0.1:3333/cb'] });
    assert.equal(ok.status, 201);
    assert.match(ok.body.client_id, /^cloudssh-/);
    assert.equal(ok.body.client_secret, undefined);
    const confidential = await register(server.base, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' });
    assert.equal(confidential.status, 201);
    assert.ok(confidential.body.client_secret);
  });

  test('授权页：不认识的客户端、对不上的回调不跳转；缺 PKCE 跳回带错误；口令错误不发授权码', async () => {
    const client = (await register(server.base)).body;
    const unknown = await fetch(authorizeUrl(server.base, 'nobody', { code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' }), { redirect: 'manual' });
    assert.equal(unknown.status, 400);
    const otherRedirect = await fetch(authorizeUrl(server.base, client.client_id, { redirect_uri: 'https://evil.example/cb', code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' }), { redirect: 'manual' });
    assert.equal(otherRedirect.status, 400);
    const noPkce = await fetch(authorizeUrl(server.base, client.client_id), { redirect: 'manual' });
    assert.equal(noPkce.status, 302);
    const back = new URL(noPkce.headers.get('location'));
    assert.equal(back.searchParams.get('error'), 'invalid_request');
    assert.equal(back.searchParams.get('state'), 'st-1');
    const wrong = await approve(server.base, client.client_id, challengeOf(verifier()), 'wrong password!!');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('location'), null);
    assert.match(wrong.headers.get('x-frame-options'), /DENY/);
  });

  test('授权码：PKCE 不对、重复使用都拒绝；正确时发访问令牌与刷新令牌', async () => {
    const client = (await register(server.base)).body;
    const codeVerifier = verifier();
    const redirect = await approve(server.base, client.client_id, challengeOf(codeVerifier));
    assert.equal(redirect.status, 302);
    const back = new URL(redirect.headers.get('location'));
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'st-1');
    assert.equal(back.searchParams.get('iss'), PUBLIC);
    const code = back.searchParams.get('code');
    const base = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id };
    // 第一次用错的 verifier：授权码随之作废
    assert.equal((await tokenRequest(server.base, { ...base, code_verifier: verifier() })).body.error, 'invalid_grant');
    assert.equal((await tokenRequest(server.base, { ...base, code_verifier: codeVerifier })).body.error, 'invalid_grant');

    const fresh = verifier();
    const again = await approve(server.base, client.client_id, challengeOf(fresh));
    const code2 = new URL(again.headers.get('location')).searchParams.get('code');
    const ok = await tokenRequest(server.base, { ...base, code: code2, code_verifier: fresh });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.token_type, 'Bearer');
    assert.ok(ok.body.access_token && ok.body.refresh_token);
    assert.equal((await tokenRequest(server.base, { ...base, code: code2, code_verifier: fresh })).body.error, 'invalid_grant');
  });

  test('MCP：完全权限的工具、不提供的服务器、危险命令直接执行、拦截级仍拒绝、只有通知时回 202', async () => {
    const { tokens } = await login(server.base);
    const token = tokens.access_token;
    const init = await rpc(server.base, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse', version: '0' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.match(init.body.result.instructions, /Full access is on/);
    const note = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(note.status, 202);

    const tools = await rpc(server.base, token, 'tools/list');
    assert.deepEqual(tools.body.result.tools.map((tool) => tool.name), ['list_servers', 'exec', 'read_file', 'list_dir', 'write_file', 'edit_file', 'start_job', 'job_status', 'copy']);
    const exec = tools.body.result.tools.find((tool) => tool.name === 'exec');
    assert.match(exec.description, /Full access is on/);
    const upload = await rpc(server.base, token, 'tools/call', { name: 'upload', arguments: {} });
    assert.equal(upload.body.error.code, -32602);

    const list = await callTool(server.base, token, 'list_servers', {});
    assert.match(list.text, /JP-A/);
    assert.doesNotMatch(list.text, /JP-B/);
    assert.match((await callTool(server.base, token, 'exec', { target: `srv-${excluded.id}`, command: 'echo hi' })).text, /找不到|没有|不认识/);

    const hello = await callTool(server.base, token, 'exec', { target: 'JP-A', command: 'echo hello' });
    assert.equal(hello.isError, false, hello.text);
    assert.match(hello.text, /hello/);
    const risky = await callTool(server.base, token, 'exec', { target: 'JP-A', command: 'rm -rf /tmp/old-logs' });
    assert.doesNotMatch(risky.text, /危险命令/);
    const blocked = await callTool(server.base, token, 'exec', { target: 'JP-A', command: 'rm -rf /' });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /拒绝执行/);
    assert.match(server.stderr, /exec 执行 srv-\d+：echo hello/);
  });

  test('令牌刷新：换新的一对，旧的刷新令牌与旧访问令牌都作废；吊销后不能再用', async () => {
    const { client, tokens } = await login(server.base);
    const refreshed = await tokenRequest(server.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.access_token, tokens.access_token);
    assert.equal((await tokenRequest(server.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error, 'invalid_grant');
    assert.equal((await rpc(server.base, tokens.access_token, 'ping')).status, 401);
    assert.equal((await rpc(server.base, refreshed.body.access_token, 'ping')).status, 200);
    const revoked = await fetch(`${server.base}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshed.body.refresh_token, client_id: client.client_id }),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await rpc(server.base, refreshed.body.access_token, 'ping')).status, 401);
  });

  test('有密钥的客户端：换令牌要带对密钥', async () => {
    const client = (await register(server.base, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })).body;
    const codeVerifier = verifier();
    const redirect = await approve(server.base, client.client_id, challengeOf(codeVerifier));
    const code = new URL(redirect.headers.get('location')).searchParams.get('code');
    const fields = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: codeVerifier };
    const noSecret = await tokenRequest(server.base, { ...fields, client_id: client.client_id });
    assert.equal(noSecret.body.error, 'invalid_client');
    const response = await fetch(`${server.base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}` },
      body: new URLSearchParams(fields),
    });
    // 上一次用错密钥时授权码没被消费（客户端认证先于授权码），这次能换到令牌
    assert.equal(response.status, 200, await response.clone().text());
  });

  describe('只读模式', () => {
    let readonly;
    let token;

    before(async () => {
      readonly = await startHttp(env, ['--access', 'read-only']);
      token = (await login(readonly.base)).tokens.access_token;
    });

    after(() => readonly?.stop());

    test('只有查看类工具（没有 write_file、edit_file、copy），exec 没有 confirm 参数', async () => {
      const tools = await rpc(readonly.base, token, 'tools/list');
      assert.deepEqual(tools.body.result.tools.map((tool) => tool.name), ['list_servers', 'exec', 'read_file', 'list_dir', 'start_job', 'job_status']);
      const exec = tools.body.result.tools.find((tool) => tool.name === 'exec');
      assert.equal(exec.inputSchema.properties.confirm, undefined);
      assert.match(exec.description, /Read-only mode/);
    });

    const allowed = [
      'echo hello',
      'cat /etc/os-release',
      "echo '== disk'; df -h; echo '== mem'; free -m",
      'journalctl -u nginx -n 50 --no-pager',
      'systemctl status nginx --no-pager -l',
      'systemctl --failed',
      'docker ps -a',
      'docker logs --tail 100 web 2>&1 | tail -n 20',
      'docker compose -f /opt/app/compose.yml logs --tail 20',
      'docker stats --no-stream',
      'ss -tlnp | grep 443',
      'tail -n 100 /var/log/syslog 2>/dev/null',
      'sudo -n cat /var/log/auth.log | tail -n 5',
      'find /var/log -name "*.gz" -mtime +7',
      'curl -sI https://example.com',
      "awk '{print $1}' /var/log/system.log | sort | uniq -c",
      'cd /var/log && ls -la',
      'LC_ALL=C sort /etc/passwd | head',
      'ps aux --sort=-%mem | head -n 10',
      'ip addr; ip route',
      'iptables -L -n -v',
      'git -C /opt/app log --oneline -5',
      'top -b -n1 | head -n 15',
      '[ -f /etc/nginx/nginx.conf ] && nginx -t',
      'timeout 5 ping -c 3 1.1.1.1',
    ];
    for (const command of allowed) {
      test(`放行：${command}`, async () => {
        const result = await callTool(readonly.base, token, 'exec', { target: 'JP-A', command });
        assert.doesNotMatch(result.text, /只读模式/, result.text);
      });
    }

    const refused = [
      'rm -rf /tmp/x',
      'echo hi > /tmp/x',
      'echo hi >> ~/.bashrc',
      'cat $(which ls)',
      'cat `id`',
      'tail -f /var/log/syslog',
      'journalctl -fu nginx',
      'systemctl restart nginx',
      'docker exec web sh',
      'docker logs -f web',
      'docker rm -f web',
      'bash -c "id"',
      'python3 -c "print(1)"',
      "sed -i 's/a/b/' /etc/hosts",
      "sed 's/a/b/w /tmp/out' /etc/hosts",
      'find / -name x -delete',
      'find / -exec rm {} \\;',
      'curl -o /tmp/x https://example.com',
      'curl -X POST https://example.com',
      'apt install -y nginx',
      'cat <<EOF\nhello\nEOF',
      '(cd /tmp; ls)',
      '/tmp/evil --run',
      '$CMD args',
      "awk '{system(\"id\")}' /etc/passwd",
      'echo hi | tee /tmp/x',
      'crontab -r',
      'iptables -F',
      'ip route add 1.2.3.4 dev eth0',
      'cat /etc/passwd | xargs rm',
      'chmod 777 /etc/passwd',
      'sudo -s',
      'env -S "rm -rf /tmp/x"',
      'sysctl -w net.ipv4.ip_forward=1',
      'git -c core.pager=id log',
      'wget https://example.com/x.sh',
    ];
    for (const command of refused) {
      test(`拒绝：${command.replace(/\n/g, '\\n')}`, async () => {
        const result = await callTool(readonly.base, token, 'exec', { target: 'JP-A', command });
        assert.equal(result.isError, true);
        assert.match(result.text, /只读模式|拒绝执行/, result.text);
      });
    }
  });

  test('口令连续输错 5 次后锁定', async () => {
    const locked = await startHttp(env, ['--access', 'read-only']);
    try {
      const client = (await register(locked.base)).body;
      for (let i = 0; i < 5; i++) assert.equal((await approve(locked.base, client.client_id, challengeOf(verifier()), `wrong-${i}-password`)).status, 401);
      const blocked = await approve(locked.base, client.client_id, challengeOf(verifier()));
      assert.equal(blocked.status, 429);
      assert.match(await blocked.text(), /秒后再试/);
    } finally {
      locked.stop();
    }
  });
});
