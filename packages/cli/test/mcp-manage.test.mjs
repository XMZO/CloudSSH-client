/**
 * MCP 管理 CloudSSH 本身的工具（add_server、update_server、delete_server、snippets、server_notes）与 list_servers 的 details，
 * 对假 Worker 端到端：新增后能当目标、凭据不回传、改字段与标签、跳板关系、删除要 confirm、默认（危险命令要确认）时修改要 confirm；
 * 命令片段的增改删、服务器笔记的记下 / 读 / 删 / 工作历程。先 node build.mjs 打好 dist/cloudssh.mjs。
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { isolatedEnv, startMcp, startMock } from './helpers.mjs';

// 测试时现场生成的一次性密钥（仓库里不放任何私钥文本）：一把不带密码、一把带密码
const KEY = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const LOCKED_KEY = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test passphrase' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

describe('MCP 管理 CloudSSH', { timeout: 120_000 }, () => {
  let mock;
  let ask;
  let full;

  before(async () => {
    mock = await startMock();
    ask = startMcp(isolatedEnv(mock.url).env);
    await ask.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const fullEnv = isolatedEnv(mock.url).env;
    const configFile = path.join(fullEnv.CLOUDSSH_HOME, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), confirm: 'never' }));
    full = startMcp(fullEnv);
    await full.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  });

  after(async () => {
    await ask?.close();
    await full?.close();
    mock?.stop();
  });

  const idOf = (text) => /(srv-\d+)/.exec(text)?.[1];

  test('add_server：新增后能当目标；details 显示地址与认证方式，不带凭据；带密码的私钥、缺凭据都拒绝', async () => {
    const added = await full.callTool('add_server', { name: 'MCP 新机', host: '192.0.2.50', port: 2222, username: 'admin', password: 'p@ss "word"', tags: ['测试'] });
    assert.equal(added.isError, false, added.text);
    const id = idOf(added.text);
    assert.ok(id, added.text);
    assert.match(added.text, /admin@192\.0\.2\.50:2222  密码/);
    assert.doesNotMatch(added.text, /p@ss/);

    const details = await full.callTool('list_servers', { query: 'MCP 新机', details: true });
    assert.match(details.text, /admin@192\.0\.2\.50:2222  密码  direct/);
    assert.match(details.text, /标签 \[测试\]/);
    const echo = await full.callTool('exec', { target: id, command: 'echo 新机能用' });
    assert.equal(echo.isError, false, echo.text);
    assert.match(echo.text, /新机能用/);

    const viaKey = await full.callTool('add_server', { name: 'MCP 私钥机', host: '192.0.2.51', private_key: KEY, jump: id });
    assert.equal(viaKey.isError, false, viaKey.text);
    assert.match(viaKey.text, new RegExp(`私钥  via ${id}`));

    const encrypted = await full.callTool('add_server', { name: 'x', host: '192.0.2.52', private_key: LOCKED_KEY });
    assert.equal(encrypted.isError, true);
    assert.match(encrypted.text, /带密码/);
    const noCredential = await full.callTool('add_server', { name: 'x', host: '192.0.2.53' });
    assert.equal(noCredential.isError, true);
    assert.match(noCredential.text, /要给凭据/);
  });

  test('update_server：只改给了的字段，标签增减，跳板改掉；默认要 confirm', async () => {
    const list = await full.callTool('list_servers', { query: 'MCP 私钥机' });
    const id = idOf(list.text);
    const refused = await ask.callTool('update_server', { target: id, name: 'MCP 私钥机2' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /confirm: true/);

    const renamed = await ask.callTool('update_server', { target: id, name: 'MCP 私钥机2', add_tags: ['甲', '乙'], jump: '', confirm: true });
    assert.equal(renamed.isError, false, renamed.text);
    assert.match(renamed.text, /MCP 私钥机2/);
    assert.match(renamed.text, /私钥  direct/);
    assert.match(renamed.text, /标签 \[甲, 乙\]/);
    const fewer = await full.callTool('update_server', { target: id, remove_tags: ['甲'], port: 2200 });
    assert.equal(fewer.isError, false, fewer.text);
    assert.match(fewer.text, /:2200/);
    assert.match(fewer.text, /标签 \[乙\]/);
    const switchAuth = await full.callTool('update_server', { target: id, auth: 'password' });
    assert.equal(switchAuth.isError, true);
    assert.match(switchAuth.text, /要给 password/);
  });

  test('delete_server：没有 confirm 不删；被当跳板时先说明；删了之后找不到', async () => {
    const jumpHost = idOf((await full.callTool('list_servers', { query: 'MCP 新机' })).text);
    const user = await full.callTool('add_server', { name: 'MCP 跳板后', host: '10.0.0.9', password: '', jump: jumpHost });
    const userId = idOf(user.text);
    const noConfirm = await full.callTool('delete_server', { target: userId });
    assert.equal(noConfirm.isError, true);
    assert.match(noConfirm.text, /confirm: true/);
    const inUse = await full.callTool('delete_server', { target: jumpHost, confirm: true });
    assert.equal(inUse.isError, true);
    assert.match(inUse.text, new RegExp(`还是 ${userId} .*的跳板机`));
    const deleted = await full.callTool('delete_server', { target: userId, confirm: true });
    assert.equal(deleted.isError, false, deleted.text);
    assert.match((await full.callTool('exec', { target: userId, command: 'echo hi' })).text, /没有主机 ID/);
  });

  test('snippets：列出、新建、修改、删除（默认删除要 confirm）', async () => {
    const created = await full.callTool('snippets', { action: 'save', name: 'MCP 片段', command: 'echo {{msg}}', category: '测试' });
    assert.equal(created.isError, false, created.text);
    const id = /#([\w-]+)/.exec(created.text)?.[1];
    assert.ok(id, created.text);
    const listed = await full.callTool('snippets', { action: 'list', query: 'mcp 片段' });
    assert.match(listed.text, /MCP 片段  \[测试\]\n    echo \{\{msg\}\}/);
    const changed = await full.callTool('snippets', { action: 'save', id, name: 'MCP 片段', command: 'echo changed' });
    assert.match(changed.text, /已修改/);
    const refused = await ask.callTool('snippets', { action: 'delete', id });
    assert.equal(refused.isError, true);
    const deleted = await ask.callTool('snippets', { action: 'delete', id, confirm: true });
    assert.equal(deleted.isError, false, deleted.text);
    assert.match((await full.callTool('snippets', { action: 'list', query: 'MCP 片段' })).text, /没有匹配/);
  });

  test('server_notes：记下知识、记工作历程、读出来、删掉', async () => {
    const set = await full.callTool('server_notes', { target: 'JP-A', action: 'set', category: 'credential', key: 'mysql_root', value: 'S3cret pass' });
    assert.equal(set.isError, false, set.text);
    await full.callTool('server_notes', { target: 'JP-A', action: 'set', key: 'nginx 配置', value: '/etc/nginx/conf.d/site.conf' });
    const log = await full.callTool('server_notes', { target: 'JP-A', action: 'log', title: '升级 nginx', summary: '1.24 → 1.26，配置不用改' });
    assert.equal(log.isError, false, log.text);
    const read = await full.callTool('server_notes', { target: 'JP-A', action: 'read' });
    assert.match(read.text, /\[凭据\] mysql_root = S3cret pass/);
    assert.match(read.text, /\[备注\] nginx 配置 = \/etc\/nginx\/conf\.d\/site\.conf/);
    assert.match(read.text, /升级 nginx：1\.24 → 1\.26/);
    const deleted = await full.callTool('server_notes', { target: 'JP-A', action: 'delete', key: 'mysql_root' });
    assert.equal(deleted.isError, false, deleted.text);
    assert.doesNotMatch((await full.callTool('server_notes', { target: 'JP-A', action: 'read' })).text, /mysql_root/);
    const missing = await full.callTool('server_notes', { target: 'JP-A', action: 'delete', key: '不存在' });
    assert.equal(missing.isError, true);
  });
});
