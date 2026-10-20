/**
 * MCP 的文件与后台任务工具（read_file、list_dir、write_file、edit_file、start_job、job_status）与 exec 的 cwd，对假 Worker 端到端：
 * 内容原样往返（引号、$、反斜杠、中文）、按行分段读、二进制与目录、create / append / overwrite、精确替换的唯一性与 $& 原样、
 * 默认（危险命令要确认）时改已有文件要 confirm、完全权限时不用，以及后台任务的启动、查看、停止与列表。
 * 先 node build.mjs 打好 dist/cloudssh.mjs。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { isolatedEnv, startMcp, startMock } from './helpers.mjs';

describe('MCP 文件与后台任务工具', { timeout: 120_000 }, () => {
  let mock;
  let mcp;
  let full;
  let root;

  before(async () => {
    mock = await startMock();
    const ask = isolatedEnv(mock.url);
    root = ask.root;
    mcp = startMcp(ask.env);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    // 完全权限：config.json 的 confirm 设为 never
    const fullEnv = isolatedEnv(mock.url).env;
    const configFile = path.join(fullEnv.CLOUDSSH_HOME, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), confirm: 'never' }));
    full = startMcp(fullEnv);
    await full.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  });

  after(async () => {
    await mcp?.close();
    await full?.close();
    mock?.stop();
  });

  const tricky = `第一行 "双引号" 'single' $HOME \`id\` \\ 反斜杠\nEOF\n\tindented\n`;

  test('write_file create → read_file：内容原样往返，带行号', async () => {
    const written = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: tricky, mode: 'create' });
    assert.equal(written.isError, false, written.text);
    assert.match(written.text, /已新建 srv-\d+ JP-A 东京:\/root\/mcp\/sub\/a\.txt/);
    const read = await mcp.callTool('read_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt' });
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /共 3 行，第 1–3 行/);
    assert.ok(read.text.includes(`1\t第一行 "双引号" 'single' $HOME \`id\` \\ 反斜杠`), read.text);
    assert.ok(read.text.includes('2\tEOF'));
    assert.ok(read.text.includes('3\t\tindented'));
    const again = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'x', mode: 'create' });
    assert.equal(again.isError, true);
    assert.match(again.text, /已有.*mode: create/);
  });

  test('改已有文件：默认要 confirm，带上才改；完全权限时不用', async () => {
    const refused = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'new\n' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /没有改动.*confirm: true/);
    const editRefused = await mcp.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'EOF', new_string: 'END' });
    assert.equal(editRefused.isError, true);
    assert.match(editRefused.text, /confirm: true/);
    const confirmed = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'one\ntwo\none\n', confirm: true });
    assert.equal(confirmed.isError, false, confirmed.text);
    assert.match(confirmed.text, /已覆盖/);
    const fullWrite = await full.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'alpha\nbeta\nalpha\ngamma\n' });
    assert.equal(fullWrite.isError, false, fullWrite.text);
    // 新文件不用确认
    const fresh = await mcp.callTool('write_file', { target: 'JP-A', path: '~/mcp/new.txt', content: 'hi\n' });
    assert.equal(fresh.isError, false, fresh.text);
    assert.match(fresh.text, /\/root\/mcp\/new\.txt/);
  });

  test('edit_file：唯一替换、$& 原样、多处要 replace_all、找不到时说明', async () => {
    const ambiguous = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'alpha', new_string: 'A' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /有 2 处 old_string/);
    const unique = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'beta\nalpha', new_string: 'BETA $& $1\nalpha' });
    assert.equal(unique.isError, false, unique.text);
    assert.match(unique.text, /替换 1 处/);
    assert.ok(unique.text.includes('2\tBETA $& $1'), unique.text);
    const all = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'alpha', new_string: 'A', replace_all: true });
    assert.match(all.text, /替换 2 处/);
    const missing = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'nope', new_string: 'x' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /没有找到 old_string/);
    const same = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'A', new_string: 'A' });
    assert.match(same.text, /一样/);
    const read = await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt' });
    assert.ok(read.text.endsWith('1\tA\n2\tBETA $& $1\n3\tA\n4\tgamma'), read.text);
  });

  test('append 与按行分段读', async () => {
    const appended = await full.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'delta\n', mode: 'append' });
    assert.match(appended.text, /已追加到/);
    const part = await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', offset: 2, limit: 2 });
    assert.match(part.text, /共 5 行，第 2–3 行/);
    assert.match(part.text, /还有第 4–5 行：offset: 4/);
    assert.doesNotMatch(part.text, /gamma/);
  });

  test('read_file：二进制、目录、不存在都说明原因', async () => {
    const binary = path.join(root, 'blob.bin');
    fs.writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));
    await full.callTool('upload', { target: 'JP-A', local_path: binary, remote_path: '/root/mcp/blob.bin' });
    assert.match((await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/blob.bin' })).text, /二进制文件/);
    assert.match((await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp' })).text, /是目录：用 list_dir/);
    assert.match((await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/none.txt' })).text, /没有 \/root\/mcp\/none\.txt/);
  });

  test('list_dir：目录在前，隐藏项要 all；不存在时说明', async () => {
    const plain = await full.callTool('list_dir', { target: 'JP-A', path: '/root' });
    assert.equal(plain.isError, false, plain.text);
    assert.match(plain.text, /^srv-\d+ JP-A 东京:\/root\n/);
    assert.match(plain.text, /drwxr-xr-x .* mcp/);
    assert.doesNotMatch(plain.text, /\.bashrc/);
    const hidden = await full.callTool('list_dir', { target: 'JP-A', path: '/root', all: true });
    assert.match(hidden.text, /\.bashrc/);
    assert.match((await full.callTool('list_dir', { target: 'JP-A', path: '/no/such' })).text, /没有目录/);
  });

  test('exec 的 cwd：在指定目录执行；目录不存在时失败', async () => {
    const here = await full.callTool('exec', { target: 'JP-A', command: 'pwd', cwd: '/root/www' });
    assert.equal(here.isError, false, here.text);
    assert.match(here.text, /\n\/root\/www$/);
    const missing = await full.callTool('exec', { target: 'JP-A', command: 'pwd', cwd: '/no/such' });
    assert.equal(missing.isError, true);
  });

  test('后台任务：启动、查看结果、停止、列出；危险命令同样要确认', async () => {
    const started = await full.callTool('start_job', { target: 'JP-A', command: 'echo building; echo done', cwd: '/root/www' });
    assert.equal(started.isError, false, started.text);
    const id = /任务 (j[a-z0-9]+)/.exec(started.text)?.[1];
    assert.ok(id, started.text);
    const status = await full.callTool('job_status', { target: 'JP-A', job_id: id });
    assert.match(status.text, /状态：已结束，退出码 0/);
    assert.match(status.text, /== 命令\necho building; echo done/);
    assert.match(status.text, /mock job: echo building/);

    const slow = /任务 (j[a-z0-9]+)/.exec((await full.callTool('start_job', { target: 'JP-A', command: 'sleep 600' })).text)?.[1];
    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: slow })).text, /运行中/);
    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: slow, stop: true })).text, /已被 job_status 停止/);
    const list = await full.callTool('job_status', { target: 'JP-A' });
    assert.ok(list.text.includes(id) && list.text.includes(slow), list.text);

    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: 'j000000000' })).text, /没有任务/);
    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: '../etc' })).text, /任务号不对/);
    assert.match((await full.callTool('start_job', { target: 'JP-A', command: 'echo x', cwd: '/no/such' })).text, /没有目录/);
    const risky = await mcp.callTool('start_job', { target: 'JP-A', command: 'rm -rf /tmp/old-logs' });
    assert.equal(risky.isError, true);
    assert.match(risky.text, /危险命令/);
    const blocked = await full.callTool('start_job', { target: 'JP-A', command: 'rm -rf /' });
    assert.match(blocked.text, /拒绝执行/);
  });
});
