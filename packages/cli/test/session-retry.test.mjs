/**
 * 后台会话连不上时换一条再试：假 Worker 的 --tcp-stall 让第一次新连接像 Cloudflare 出站 TCP 卡住（连上后不发任何状态，
 * 20 秒后才报错），客户端应在 8 秒左右放弃这条、换一条连上，命令照常执行一次。先 node build.mjs 打好 dist/cloudssh.mjs。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isolatedEnv, startMcp, startMock } from './helpers.mjs';

describe('后台会话：连接卡住时换一条', { timeout: 60_000 }, () => {
  let mock;
  let mcp;

  before(async () => {
    mock = await startMock(['--tcp-stall', '1']);
    mcp = startMcp(isolatedEnv(mock.url).env);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  });

  after(async () => {
    await mcp?.close();
    mock?.stop();
  });

  test('第一次连接卡住：8 秒后换一条，命令照常完成', async () => {
    const started = Date.now();
    const result = await mcp.callTool('exec', { target: 'JP-A', command: 'echo 换了一条' });
    const seconds = (Date.now() - started) / 1000;
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /换了一条/);
    assert.ok(seconds >= 7 && seconds < 18, `用了 ${seconds} 秒`);
  });
});
