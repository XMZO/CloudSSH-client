/**
 * 命令行的 read / write / edit（对假 Worker）：原样读写（CRLF 换成 LF）、分段读、改已有文件要 --yes、精确替换的各种报错
 * （用命令行的选项名）、二进制与目录；本进程与后台会话进程两条路结果一样，后台进程能收发几 MB 的内容。
 * 先 node build.mjs 打好 dist/cloudssh.mjs。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CLI, isolatedEnv, startMock, tempDir } from './helpers.mjs';

/** 跑一次命令行（可以给 stdin；输出可能有几 MB） */
function cli(args, env, input) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

for (const agent of [false, true]) {
  describe(`read / write / edit（${agent ? '后台会话进程' : '本进程'}）`, { timeout: 180_000 }, () => {
    let mock;
    let env;
    let id;
    let dir;
    let local;

    before(async () => {
      mock = await startMock();
      ({ env } = isolatedEnv(mock.url));
      if (agent) {
        env.CLOUDSSH_AGENT = '1';
        env.CLOUDSSH_AGENT_IDLE = '60';
      }
      id = JSON.parse(cli(['servers', '--json', '-q', 'JP-A'], env).stdout)[0].id;
      dir = `/root/cli-${agent ? 'agent' : 'local'}`;
      local = tempDir('cloudssh-files-');
    });

    after(() => {
      if (agent) cli(['agent', 'stop'], env);
      mock?.stop();
    });

    test('write --stdin 新建、read 原样读回（CRLF 换成 LF）；分段读时 stderr 给出下一段的 --offset', () => {
      const text = 'line 1 "double" \'single\' $HOME `id`\r\nline 2 \\ backslash\r\n中文第三行\r\n';
      const written = cli(['write', '--stdin', id, `${dir}/a.txt`], env, text);
      assert.equal(written.code, 0, written.stderr);
      assert.match(written.stdout, /^Created srv-\d+ JP-A 东京:\/root\/cli-\w+\/a\.txt \(\d+ B written\)/);
      const read = cli(['read', id, `${dir}/a.txt`], env);
      assert.equal(read.code, 0, read.stderr);
      assert.equal(read.stdout, text.replace(/\r\n/g, '\n'));
      assert.equal(read.stderr, '');
      const part = cli(['read', '--offset', '2', '--limit', '1', id, `${dir}/a.txt`], env);
      assert.equal(part.stdout, 'line 2 \\ backslash\n');
      assert.match(part.stderr, /lines 2–2 of 3 \(.*a\.txt\); next: --offset 3/);
      const json = JSON.parse(cli(['read', '--json', id, `${dir}/a.txt`], env).stdout);
      assert.equal(json.lines, 3);
      assert.match(json.sha256, /^[0-9a-f]{64}$/);
      assert.match(cli(['read', '--offset', '9', id, `${dir}/a.txt`], env).stderr, /has only 3 lines/);
    });

    test('改已有文件：没有 --yes 不改（退出码 2，让 AI 先问用户）；--yes 覆盖、--append 追加；--create 不碰已有的', () => {
      const file = `${dir}/b.txt`;
      assert.equal(cli(['write', '--stdin', id, file], env, 'one\n').code, 0);
      const refused = cli(['write', '--stdin', id, file], env, 'two\n');
      assert.equal(refused.code, 2);
      assert.match(refused.stderr, /already exists .*needs --yes\. Ask the user/);
      assert.equal(cli(['read', id, file], env).stdout, 'one\n');
      assert.match(cli(['write', '--stdin', '--yes', id, file], env, 'two\n').stdout, /^Overwrote /);
      assert.match(cli(['write', '--stdin', '--append', '--yes', id, file], env, 'three\n').stdout, /^Appended to /);
      assert.equal(cli(['read', id, file], env).stdout, 'two\nthree\n');
      const create = cli(['write', '--stdin', '--create', id, file], env, 'x');
      assert.equal(create.code, 2);
      assert.match(create.stderr, /--create only creates new files/);
      // 本机文件给内容：去掉 BOM，CRLF 换成 LF
      fs.writeFileSync(path.join(local, 'content.txt'), '﻿from file\r\n');
      assert.equal(cli(['write', '--file', path.join(local, 'content.txt'), id, `${dir}/from-file.txt`], env).code, 0);
      assert.equal(cli(['read', id, `${dir}/from-file.txt`], env).stdout, 'from file\n');
    });

    test('edit：精确替换；找不到、不唯一、没有 --yes 时不改，报错用命令行的选项名', () => {
      const file = `${dir}/c.conf`;
      assert.equal(cli(['write', '--stdin', id, file], env, 'listen 80;\nserver_name a;\nlisten 80;\n').code, 0);
      const missing = cli(['edit', '--yes', id, file, '--old', 'listen 81;', '--new', 'x'], env);
      assert.equal(missing.code, 2);
      assert.match(missing.stderr, /--old not found in .*check the text with cloudssh read/);
      assert.match(cli(['edit', '--yes', id, file, '--old', 'listen 80;', '--new', 'listen 8080;'], env).stderr, /--old occurs 2 times .*pass --all/);
      const noYes = cli(['edit', id, file, '--old', 'server_name a;', '--new', 'server_name b;'], env);
      assert.equal(noYes.code, 2);
      assert.match(noYes.stderr, /editing .*c\.conf on srv-\d+ JP-A 东京 needs --yes/);
      const one = cli(['edit', '--yes', id, file, '--old', 'server_name a;', '--new', 'server_name b;'], env);
      assert.equal(one.code, 0, one.stderr);
      assert.match(one.stdout, /^Edited srv-\d+ JP-A 东京:.*c\.conf \(1 replacement\)\. Around the first change:\n/);
      assert.match(one.stdout, /server_name b;/);
      assert.match(cli(['edit', '--yes', '--all', id, file, '--old', 'listen 80;', '--new', 'listen 8080;'], env).stdout, /\(2 replacements\)/);
      assert.equal(cli(['read', id, file], env).stdout, 'listen 8080;\nserver_name b;\nlisten 8080;\n');
      // 多行、带引号的原文与新文从本机文件读（BOM、CRLF 去掉）
      fs.writeFileSync(path.join(local, 'old.txt'), '﻿listen 8080;\r\nserver_name b;');
      fs.writeFileSync(path.join(local, 'new.txt'), 'listen 9090;\r\nserver_name "c";');
      const fromFiles = cli(['edit', '--yes', id, file, '--old-file', path.join(local, 'old.txt'), '--new-file', path.join(local, 'new.txt')], env);
      assert.equal(fromFiles.code, 0, fromFiles.stderr);
      assert.equal(cli(['read', id, file], env).stdout, 'listen 9090;\nserver_name "c";\nlisten 8080;\n');
      assert.match(cli(['edit', id, file, '--old', 'a'], env).stderr, /exactly one of --new and --new-file/);
    });

    test('二进制文件、不存在的文件、目录：read 不读并说明', () => {
      const blob = path.join(local, 'blob.bin');
      fs.writeFileSync(blob, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 1, 2, 3]));
      assert.equal(cli(['upload', id, blob, `${dir}/blob.bin`], env).code, 0);
      const binary = cli(['read', id, `${dir}/blob.bin`], env);
      assert.equal(binary.code, 2);
      assert.match(binary.stderr, /is binary \(11 bytes\): use cloudssh download/);
      assert.match(cli(['read', id, `${dir}/none.txt`], env).stderr, /none\.txt does not exist on JP-A 东京/);
      assert.match(cli(['read', id, dir], env).stderr, /is a directory\n/);
    });

    if (agent) {
      test('几 MB 的内容经后台进程照样写入、读回；后台进程留着会话', () => {
        const big = `${'0123456789abcdef'.repeat(64)}\n`.repeat(3 * 1024);
        const written = cli(['write', '--stdin', id, `${dir}/big.txt`], env, big);
        assert.equal(written.code, 0, written.stderr);
        const read = cli(['read', '--limit', '100000', id, `${dir}/big.txt`], env);
        assert.equal(read.code, 0, read.stderr);
        assert.equal(read.stdout.length, big.length);
        assert.ok(read.stdout === big, '读回的内容应与写入的一样');
        assert.equal(typeof JSON.parse(cli(['agent', 'status', '--json'], env).stdout).pid, 'number', '后台进程应还在运行');
      });
    }
  });
}
