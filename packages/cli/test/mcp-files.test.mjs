/**
 * MCP 的文件与后台任务工具（read_file、list_dir、write_file、edit_file、start_job、job_status）与 exec 的 cwd，对假 Worker 端到端：
 * 内容原样往返（引号、$、反斜杠、中文）、按行分段读、二进制与目录、create / append / overwrite、精确替换的唯一性与 $& 原样、
 * 默认（危险命令要确认）时改已有文件要 confirm、完全权限时不用，以及后台任务的启动、查看、停止与列表。
 * 先 node build.mjs 打好 dist/cloudssh.mjs。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    assert.match(written.text, /Created srv-\d+ JP-A 东京:\/root\/mcp\/sub\/a\.txt/);
    const read = await mcp.callTool('read_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt' });
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /3 lines, showing 1–3/);
    assert.ok(read.text.includes(`1\t第一行 "双引号" 'single' $HOME \`id\` \\ 反斜杠`), read.text);
    assert.ok(read.text.includes('2\tEOF'));
    assert.ok(read.text.includes('3\t\tindented'));
    const again = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'x', mode: 'create' });
    assert.equal(again.isError, true);
    assert.match(again.text, /already exists.*mode: create/);
  });

  test('改已有文件：默认要 confirm，带上才改；完全权限时不用', async () => {
    const refused = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'new\n' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not changed.*confirm: true/);
    const editRefused = await mcp.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'EOF', new_string: 'END' });
    assert.equal(editRefused.isError, true);
    assert.match(editRefused.text, /confirm: true/);
    const confirmed = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'one\ntwo\none\n', confirm: true });
    assert.equal(confirmed.isError, false, confirmed.text);
    assert.match(confirmed.text, /Overwrote/);
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
    assert.match(ambiguous.text, /old_string occurs 2 times/);
    const unique = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'beta\nalpha', new_string: 'BETA $& $1\nalpha' });
    assert.equal(unique.isError, false, unique.text);
    assert.match(unique.text, /\(1 replacement\)/);
    assert.ok(unique.text.includes('2\tBETA $& $1'), unique.text);
    const all = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'alpha', new_string: 'A', replace_all: true });
    assert.match(all.text, /\(2 replacements\)/);
    const missing = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'nope', new_string: 'x' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /old_string not found/);
    const same = await full.callTool('edit_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', old_string: 'A', new_string: 'A' });
    assert.match(same.text, /identical/);
    const read = await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt' });
    assert.ok(read.text.endsWith('1\tA\n2\tBETA $& $1\n3\tA\n4\tgamma'), read.text);
  });

  test('append 与按行分段读', async () => {
    const appended = await full.callTool('write_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', content: 'delta\n', mode: 'append' });
    assert.match(appended.text, /Appended to/);
    const part = await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/sub/a.txt', offset: 2, limit: 2 });
    assert.match(part.text, /5 lines, showing 2–3/);
    assert.match(part.text, /Lines 4–5 not shown; next offset: 4/);
    assert.doesNotMatch(part.text, /gamma/);
  });

  test('分段写：按顺序收齐才写进文件，中途原文件不动，顺序不对要重来，确认只在第 1 段', async () => {
    const pieces = [`#!/bin/sh\n# 大脚本 ${tricky}`, 'echo "第二段 $HOME"\n', 'exit 0\n'];
    // 新文件：三段
    const first = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: pieces[0], part: 1, parts: 3, mode: 'create' });
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /part 1\/3 .*Send part 2/);
    const missing = await mcp.callTool('read_file', { target: 'JP-A', path: '/root/mcp/big.sh' });
    assert.equal(missing.isError, true, '没收齐之前不应出现目标文件');
    const wrong = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: pieces[2], part: 3, parts: 3, mode: 'create' });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /expects part 2\/3/);
    const second = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: pieces[1], part: 2, parts: 3, mode: 'create' });
    assert.equal(second.isError, false, second.text);
    const last = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: pieces[2], part: 3, parts: 3, mode: 'create' });
    assert.equal(last.isError, false, last.text);
    assert.match(last.text, /Created .*big\.sh \(3 parts/);
    const read = await mcp.callTool('read_file', { target: 'JP-A', path: '/root/mcp/big.sh' });
    for (const line of pieces.join('').split('\n').filter(Boolean)) assert.ok(read.text.includes(line), `少了一行：${line}`);

    // 改已有文件：第 1 段要 confirm，之后的段不用；写完前原文件不变
    const refused = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: 'new 1\n', part: 1, parts: 2 });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /confirm: true/);
    await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: 'new 1\n', part: 1, parts: 2, confirm: true });
    const during = await mcp.callTool('read_file', { target: 'JP-A', path: '/root/mcp/big.sh' });
    assert.match(during.text, /第二段/, '最后一段到之前原文件不变');
    const done = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: 'new 2\n', part: 2, parts: 2 });
    assert.match(done.text, /Overwrote/);
    const after = await mcp.callTool('read_file', { target: 'JP-A', path: '/root/mcp/big.sh' });
    assert.match(after.text, /new 1\n.*new 2/s);
    assert.doesNotMatch(after.text, /第二段/);

    // create 遇到已有文件：第 1 段就拒绝
    const exists = await mcp.callTool('write_file', { target: 'JP-A', path: '/root/mcp/big.sh', content: 'x', part: 1, parts: 2, mode: 'create' });
    assert.equal(exists.isError, true);
    assert.match(exists.text, /already exists/);
  });

  test('read_file：二进制、目录、不存在都说明原因', async () => {
    const binary = path.join(root, 'blob.bin');
    fs.writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));
    await full.callTool('upload', { target: 'JP-A', local_path: binary, remote_path: '/root/mcp/blob.bin' });
    assert.match((await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/blob.bin' })).text, /is binary/);
    assert.match((await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp' })).text, /is a directory; use list_dir/);
    assert.match((await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/none.txt' })).text, /\/root\/mcp\/none\.txt does not exist/);
  });

  test('二进制：base64 写入（一次、任意位置切开的分段）与按字节分段读出原样往返，SHA-256 对得上；没带 encoding 时提示用 base64', async () => {
    const bytes = Buffer.alloc(50_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const sha = createHash('sha256').update(bytes).digest('hex');
    const b64 = bytes.toString('base64');

    const once = await full.callTool('write_file', { target: 'JP-A', path: '/root/mcp/bin/once.bin', content: b64, encoding: 'base64' });
    assert.equal(once.isError, false, once.text);
    // 分段：切在不是 4 的倍数的位置（base64 的尾巴要接到下一段）
    const cuts = [0, 1001, 30_003, 50_001, b64.length];
    for (let i = 0; i < cuts.length - 1; i++) {
      const piece = await full.callTool('write_file', {
        target: 'JP-A',
        path: '/root/mcp/bin/parts.bin',
        content: b64.slice(cuts[i], cuts[i + 1]),
        encoding: 'base64',
        part: i + 1,
        parts: cuts.length - 1,
      });
      assert.equal(piece.isError, false, piece.text);
    }

    for (const file of ['/root/mcp/bin/once.bin', '/root/mcp/bin/parts.bin']) {
      const chunks = [];
      let offset = 0;
      for (let round = 0; round < 20; round++) {
        const read = await full.callTool('read_file', { target: 'JP-A', path: file, encoding: 'base64', offset });
        assert.equal(read.isError, false, read.text);
        assert.ok(read.text.includes(sha), read.text.slice(0, 300));
        const [head, data] = read.text.split('\n');
        chunks.push(Buffer.from(data, 'base64'));
        const next = /offset: (\d+)/.exec(head);
        if (!next) break;
        offset = Number(next[1]);
      }
      assert.ok(chunks.length > 1, '应该分了几段读');
      assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), sha);
    }

    const plain = await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/bin/once.bin' });
    assert.equal(plain.isError, true);
    assert.match(plain.text, /is binary.*encoding: base64/);
    const bad = await full.callTool('write_file', { target: 'JP-A', path: '/root/mcp/bin/bad.bin', content: '不是 base64!', encoding: 'base64' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not valid base64/);
  });

  test('read_file 读到图片时把图片交给模型（image 内容）', async () => {
    // 1×1 的 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await full.callTool('write_file', { target: 'JP-A', path: '/root/mcp/bin/dot.png', content: png.toString('base64'), encoding: 'base64' });
    const read = await full.callTool('read_file', { target: 'JP-A', path: '/root/mcp/bin/dot.png' });
    assert.equal(read.isError, false, read.text);
    assert.match(read.raw.content[0].text, /PNG image/);
    assert.deepEqual(read.raw.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  });

  test('同一台服务器同时读好几个文件：SFTP 排队，不再互相顶掉（SFTP 已经打开 / 连接已关闭）', async () => {
    const names = ['c1', 'c2', 'c3', 'c4'];
    for (const name of names) await full.callTool('write_file', { target: 'JP-A', path: `/root/mcp/con/${name}.txt`, content: `内容 ${name}\n` });
    const reads = await Promise.all(names.map((name) => full.callTool('read_file', { target: 'JP-A', path: `/root/mcp/con/${name}.txt` })));
    reads.forEach((read, index) => {
      assert.equal(read.isError, false, read.text);
      assert.ok(read.text.includes(`内容 ${names[index]}`), read.text);
    });
  });

  test('list_dir：目录在前，隐藏项要 all；不存在时说明', async () => {
    const plain = await full.callTool('list_dir', { target: 'JP-A', path: '/root' });
    assert.equal(plain.isError, false, plain.text);
    assert.match(plain.text, /^srv-\d+ JP-A 东京:\/root\n/);
    assert.match(plain.text, /drwxr-xr-x .* mcp/);
    assert.doesNotMatch(plain.text, /\.bashrc/);
    const hidden = await full.callTool('list_dir', { target: 'JP-A', path: '/root', all: true });
    assert.match(hidden.text, /\.bashrc/);
    assert.match((await full.callTool('list_dir', { target: 'JP-A', path: '/no/such' })).text, /Directory .* does not exist/);
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
    const id = /job (j[a-z0-9]+)/.exec(started.text)?.[1];
    assert.ok(id, started.text);
    const status = await full.callTool('job_status', { target: 'JP-A', job_id: id });
    assert.match(status.text, /state: finished, exit 0/);
    assert.match(status.text, /== command\necho building; echo done/);
    assert.match(status.text, /mock job: echo building/);

    const slow = /job (j[a-z0-9]+)/.exec((await full.callTool('start_job', { target: 'JP-A', command: 'sleep 600' })).text)?.[1];
    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: slow })).text, /state: running/);
    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: slow, stop: true })).text, /stopped by job_status/);
    const list = await full.callTool('job_status', { target: 'JP-A' });
    assert.ok(list.text.includes(id) && list.text.includes(slow), list.text);

    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: 'j000000000' })).text, /No job/);
    assert.match((await full.callTool('job_status', { target: 'JP-A', job_id: '../etc' })).text, /Invalid job_id/);
    assert.match((await full.callTool('start_job', { target: 'JP-A', command: 'echo x', cwd: '/no/such' })).text, /Directory .* does not exist/);
    const risky = await mcp.callTool('start_job', { target: 'JP-A', command: 'rm -rf /tmp/old-logs' });
    assert.equal(risky.isError, true);
    assert.match(risky.text, /Risky command/);
    const blocked = await full.callTool('start_job', { target: 'JP-A', command: 'rm -rf /' });
    assert.match(blocked.text, /Refused/);
  });
});
