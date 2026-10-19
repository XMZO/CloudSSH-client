/**
 * cloudssh mcp 对假 Worker 的端到端测试：协议（initialize 版本协商、tools/list、ping、错误码、批量）、
 * 五个工具、危险命令规则、64KB 有界输出、进度通知与取消。先 node build.mjs 打好 dist/cloudssh.mjs。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { isolatedEnv, startMcp, startMock, tempDir } from './helpers.mjs';

const LIMIT = 64 * 1024;
const bytes = (text) => Buffer.byteLength(text, 'utf8');

describe('cloudssh mcp', { timeout: 120_000 }, () => {
  let mock;
  let env;
  let mcp;

  before(async () => {
    mock = await startMock();
    ({ env } = isolatedEnv(mock.url));
    mcp = startMcp(env);
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  after(async () => {
    const code = await mcp?.close();
    mock?.stop();
    assert.equal(code, 0, `cloudssh mcp 退出码 ${code}\n${mcp?.stderr}`);
    // stdout 只能有协议消息
    assert.deepEqual(mcp.badLines, []);
  });

  test('initialize：认识的版本照用，不认识的回最新的，带服务器信息与说明', async () => {
    const other = startMcp(env);
    const response = await other.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old', version: '0' } });
    await other.close();
    assert.equal(response.result.protocolVersion, '2025-11-25');
    assert.equal(response.result.serverInfo.name, 'cloudssh');
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
    assert.match(response.result.instructions, /list_servers/);
    assert.match(response.result.instructions, new RegExp(mock.url.replace(/[.:/]/g, '\\$&')));
  });

  test('tools/list：五个工具，参数都是 JSON Schema 对象', async () => {
    const { result } = await mcp.request('tools/list', {});
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ['list_servers', 'exec', 'upload', 'download', 'copy']
    );
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.description, 'string');
    }
    const exec = result.tools.find((tool) => tool.name === 'exec');
    assert.deepEqual(exec.inputSchema.required, ['target', 'command']);
    assert.equal(exec.inputSchema.properties.confirm.type, 'boolean');
  });

  test('ping、未知方法、未知工具、解析错误、批量请求', async () => {
    assert.deepEqual((await mcp.request('ping')).result, {});
    assert.equal((await mcp.request('nope/method', {})).error.code, -32601);
    assert.equal((await mcp.request('tools/call', { name: 'toString', arguments: {} })).error.code, -32602);
    const before = mcp.notifications.length;
    mcp.write('{not json\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const parseError = mcp.notifications.slice(before).find((item) => item.error?.code === -32700);
    assert.ok(parseError, '应回复 -32700');
    assert.equal(parseError.id, null);
    // 批量：两条请求一起回
    const batch = await new Promise((resolve) => {
      const start = mcp.lines.length;
      mcp.send([
        { jsonrpc: '2.0', id: 'b1', method: 'ping' },
        { jsonrpc: '2.0', id: 'b2', method: 'tools/list' },
      ]);
      const timer = setInterval(() => {
        const line = mcp.lines.slice(start).find((item) => item.startsWith('['));
        if (line) {
          clearInterval(timer);
          resolve(JSON.parse(line));
        }
      }, 50);
    });
    assert.deepEqual(batch.map((item) => item.id).sort(), ['b1', 'b2']);
  });

  test('list_servers：主机 ID、名称、标签、系统、线路，可按关键字与标签筛', async () => {
    const all = await mcp.callTool('list_servers', {});
    assert.equal(all.isError, false);
    assert.match(all.text, /^共 \d+ 台/);
    const jp = await mcp.callTool('list_servers', { query: 'JP' });
    assert.match(jp.text, /srv-\d+\s+JP-A 东京\s+\[日本 🇯🇵\]\s+centos\s+direct/);
    assert.match(jp.text, /JP-D 福冈.*via srv-\d+/);
    const none = await mcp.callTool('list_servers', { query: 'no-such-server' });
    assert.match(none.text, /没有匹配/);
  });

  test('exec：单台、按标签批量、非零退出码是 isError', async () => {
    const one = await mcp.callTool('exec', { target: 'JP-A', command: 'echo hello' });
    assert.equal(one.isError, false);
    assert.match(one.text, /^===== srv-\d+ JP-A 东京 · 退出码 0/);
    assert.match(one.text, /\nhello$/);

    const many = await mcp.callTool('exec', { target: 'tag:日本', command: 'hostname' });
    assert.equal(many.isError, false);
    assert.equal(many.text.match(/^===== /gm).length, 4);
    assert.match(many.text, /4 台：4 台成功/);

    const failed = await mcp.callTool('exec', { target: 'JP-B', command: 'exit 3' });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /退出码 3/);
  });

  test('exec：目标与参数出错返回 isError，进程照常', async () => {
    const missing = await mcp.callTool('exec', { target: 'no-such-server', command: 'uptime' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /没有叫“no-such-server”的服务器/);
    const ambiguous = await mcp.callTool('exec', { target: 'JP', command: 'uptime' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /匹配到 4 台/);
    const badTimeout = await mcp.callTool('exec', { target: 'JP-A', command: 'uptime', timeout: 0 });
    assert.equal(badTimeout.isError, true);
    assert.match(badTimeout.text, /timeout/);
    const noCommand = await mcp.callTool('exec', { target: 'JP-A' });
    assert.equal(noCommand.isError, true);
    assert.match(noCommand.text, /command/);
  });

  test('exec：拦截级命令一律拒绝，危险命令要 confirm', async () => {
    const blocked = await mcp.callTool('exec', { target: 'JP-A', command: 'rm -rf /', confirm: true });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /^拒绝执行/);

    const risky = await mcp.callTool('exec', { target: 'JP-A', command: 'rm -rf /tmp/old-logs' });
    assert.equal(risky.isError, true);
    assert.match(risky.text, /危险命令.*没有执行.*confirm: true/);

    const confirmed = await mcp.callTool('exec', { target: 'JP-A', command: 'rm -rf /tmp/old-logs', confirm: true });
    assert.doesNotMatch(confirmed.text, /没有执行/);
    assert.match(confirmed.text, /^===== srv-\d+ JP-A/);
  });

  test('upload 与 download（带进度通知），本机 ~ 展开成家目录', async () => {
    const local = tempDir('cloudssh-up-');
    const file = path.join(local, 'hello.txt');
    fs.writeFileSync(file, 'hello from mcp\n');
    const up = await mcp.callTool('upload', { target: 'JP-A', local_path: file, remote_path: '/tmp/' });
    assert.equal(up.isError, false, up.text);
    assert.match(up.text, /已上传到 srv-\d+ JP-A 东京：文件 → \/tmp\/hello\.txt/);
    const cat = await mcp.callTool('exec', { target: 'JP-A', command: 'cat /tmp/hello.txt' });
    assert.match(cat.text, /hello from mcp/);

    const before = mcp.notifications.length;
    const down = await mcp.callTool('download', { target: 'JP-A', remote_path: '/root/notes.txt', local_path: '~/downloads/' }, { _meta: { progressToken: 'dl-1' } });
    assert.equal(down.isError, false, down.text);
    const saved = path.join(env.USERPROFILE, 'downloads', 'notes.txt');
    assert.equal(fs.readFileSync(saved, 'utf8'), 'CloudSSH mock notes\n'.repeat(40));
    const progress = mcp.notifications.slice(before).filter((item) => item.method === 'notifications/progress');
    assert.ok(progress.length >= 1, '应有进度通知');
    assert.equal(progress[0].params.progressToken, 'dl-1');

    const missing = await mcp.callTool('download', { target: 'JP-A', remote_path: '/root/nope.txt', local_path: local });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /没有 \/root\/nope\.txt/);
  });

  test('copy：已存在的目标不 confirm 不覆盖', async () => {
    const first = await mcp.callTool('copy', { from_target: 'JP-A', from_path: '/root/deploy.sh', to_target: 'JP-B', to_path: '/tmp/deploy-copy.sh' });
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /已从 srv-\d+ JP-A 东京 传到 srv-\d+ JP-B 大阪：文件 → \/tmp\/deploy-copy\.sh/);
    const again = await mcp.callTool('copy', { from_target: 'JP-A', from_path: '/root/deploy.sh', to_target: 'JP-B', to_path: '/tmp/deploy-copy.sh' });
    assert.equal(again.isError, true);
    assert.match(again.text, /已有 \/tmp\/deploy-copy\.sh，没有覆盖/);
    const forced = await mcp.callTool('copy', { from_target: 'JP-A', from_path: '/root/deploy.sh', to_target: 'JP-B', to_path: '/tmp/deploy-copy.sh', confirm: true });
    assert.equal(forced.isError, false, forced.text);
  });

  test('输出有界：多台大输出合起来不超过 64KB，每台留末尾', async () => {
    const local = tempDir('cloudssh-big-');
    const file = path.join(local, 'big.txt');
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(40)}`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const up = await mcp.callTool('upload', { target: 'JP-A', local_path: file, remote_path: '/tmp/big.txt' });
    assert.equal(up.isError, false, up.text);
    const result = await mcp.callTool('exec', { target: 'JP-A,JP-B,JP-C', command: 'cat /tmp/big.txt' });
    assert.ok(bytes(result.text) <= LIMIT, `结果 ${bytes(result.text)} 字节`);
    assert.equal(result.text.match(/^===== /gm).length, 3);
    // 每台都留了最后一行
    assert.equal(result.text.match(/line 03999 x+/g).length, 3);
    assert.match(result.text, /只保留最后/);
  });

  test('取消：不再回复，用到的会话关掉，之后照常可用', async () => {
    mcp.send({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'exec', arguments: { target: 'JP-C', command: 'sleep 30', timeout: 60 } } });
    await new Promise((resolve) => setTimeout(resolve, 800));
    mcp.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow', reason: 'test' } });
    assert.equal(await mcp.waitFor('slow', 2000), null, '取消后不应回复');
    const next = await mcp.callTool('exec', { target: 'JP-C', command: 'echo after' });
    assert.equal(next.isError, false, next.text);
    assert.match(next.text, /after/);
  });

  test('没登录的实例：工具返回 isError 提示登录，协议照常', async () => {
    const other = startMcp(env, ['--instance', 'http://127.0.0.1:9']);
    await other.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const result = await other.callTool('list_servers', {});
    await other.close();
    assert.equal(result.isError, true);
    assert.match(result.text, /还没有登录 http:\/\/127\.0\.0\.1:9/);
  });
});
