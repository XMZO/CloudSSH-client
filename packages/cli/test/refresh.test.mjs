/**
 * exec --file，以及 skill / 命令的版本标记与 install --refresh（桌面客户端启动时按版本自动更新、不留旧版）。
 * 全部在临时家目录里做：默认命令目录（~/.local/bin）、复制安装的目录、各 agent 的 skill 目录都在临时目录里。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CLI, isolatedEnv, runCli, startMock } from './helpers.mjs';

const windows = process.platform === 'win32';
const VERSION = runCli(['--version'], process.env).stdout.trim().split(/\s/)[0];

describe('exec --file', { timeout: 120_000 }, () => {
  let mock;
  let env;
  let root;
  before(async () => {
    mock = await startMock();
  });
  after(() => mock?.stop());
  beforeEach(() => {
    ({ env, root } = isolatedEnv(mock.url));
  });

  test('按 UTF-8 读命令：引号、中文原样，去掉 BOM 与 CRLF', () => {
    const file = path.join(root, 'command.sh');
    fs.writeFileSync(file, '﻿echo "a b" 中文\r\n');
    const result = runCli(['exec', '--json', '--file', file, 'JP-A'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).output, '"a b" 中文');
  });

  test('文件不在、与 --stdin 或参数里的命令同时用时报用法错误', () => {
    const missing = runCli(['exec', '--file', path.join(root, 'nope.sh'), 'JP-A'], env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /读不到命令文件/);
    const file = path.join(root, 'command.sh');
    fs.writeFileSync(file, 'uptime');
    assert.match(runCli(['exec', '--file', file, '--stdin', 'JP-A'], env).stderr, /只能用一个/);
    assert.match(runCli(['exec', '--file', file, 'JP-A', 'uptime'], env).stderr, /不要再在参数里写命令/);
  });
});

describe('版本标记与 install --refresh', { timeout: 120_000 }, () => {
  let env;
  let home;
  let bin;

  const status = () => JSON.parse(runCli(['install', '--status', '--json'], env).stdout);
  const refresh = () => {
    const result = runCli(['install', '--refresh', '--json'], env);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const skillFile = (agent) => path.join(home, agent, 'skills', 'cloudssh', 'SKILL.md');
  /** 把装着的命令改成某个版本装的（改启动脚本、启动器配置里的版本标记） */
  const pretendCommandVersion = (version) => {
    for (const name of fs.readdirSync(bin)) {
      const file = path.join(bin, name);
      if (name.endsWith('.exe')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('cloudssh-shim')) fs.writeFileSync(file, text.replace(/cloudssh-shim \S+/, `cloudssh-shim ${version}`));
    }
  };
  /** 把装着的 skill 改成某个版本写的；null 是没写版本标记的旧版 */
  const pretendSkillVersion = (file, version) => {
    const text = fs.readFileSync(file, 'utf8').replace(/\n<!-- cloudssh-skill \S+ -->\n$/, '\n');
    fs.writeFileSync(file, version ? `${text}\n<!-- cloudssh-skill ${version} -->\n` : `${text}\n## 旧版写的段落\n`);
  };

  beforeEach(() => {
    ({ env, home } = isolatedEnv());
    bin = path.join(home, '.local', 'bin');
  });

  test('skill 末尾与命令启动脚本里都有版本；状态里报告', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
    assert.equal(runCli(['install'], env).code, 0);
    assert.ok(fs.readFileSync(skillFile('.claude'), 'utf8').endsWith(`\n<!-- cloudssh-skill ${VERSION} -->\n`));
    const current = status();
    assert.equal(current.commandVersion, VERSION);
    assert.equal(current.skills.find((item) => item.id === 'claude').version, VERSION);
    assert.equal(current.skillCurrent, true);
  });

  test('别处装的旧版：改指这份程序，旧 skill 更新，复制安装的旧程序删掉', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    assert.equal(runCli(['install'], env).code, 0);
    const copy = status().program;
    assert.notEqual(path.resolve(copy), path.resolve(CLI));
    pretendCommandVersion('0.0.1');
    pretendSkillVersion(skillFile('.claude'), '0.0.1');
    pretendSkillVersion(skillFile('.codex'), null);

    const result = refresh();
    assert.equal(result.action, 'install');
    assert.equal(path.resolve(result.status.program), path.resolve(CLI));
    assert.equal(result.status.commandVersion, VERSION);
    assert.equal(result.status.skillCurrent, true);
    assert.ok(!fs.existsSync(copy), '复制安装的旧程序应删掉');
    assert.ok(result.lines.some((line) => line.includes('已删除不再使用的旧程序')));
    assert.doesNotMatch(fs.readFileSync(skillFile('.codex'), 'utf8'), /旧版写的段落/);
    if (windows) assert.ok(!fs.readdirSync(bin).some((name) => name.endsWith('.cmd')));

    // 都是最新的：再跑不改动
    assert.equal(refresh().action, 'none');
  });

  test('别处装的一样新或更新的不动（skill 也不动）', () => {
    assert.equal(runCli(['install'], env).code, 0);
    const before = status();
    pretendCommandVersion('99.0.0');
    pretendSkillVersion(skillFile('.claude'), '99.0.0');
    const skill = fs.readFileSync(skillFile('.claude'), 'utf8');
    const result = refresh();
    assert.equal(result.action, 'none');
    assert.equal(result.status.program, before.program);
    assert.equal(fs.readFileSync(skillFile('.claude'), 'utf8'), skill);
  });

  test('命令指向这份程序时，skill 旧了就重装；关掉的 agent 的 skill 删掉', () => {
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    assert.equal(runCli(['install', '--in-place'], env).code, 0);
    assert.equal(refresh().action, 'none');
    pretendSkillVersion(skillFile('.claude'), '0.0.1');
    // 关掉通用目录的 skill，但文件还留着（比如旧版装的）
    const config = path.join(env.CLOUDSSH_HOME, 'config.json');
    const saved = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : {};
    fs.writeFileSync(config, JSON.stringify({ ...saved, skills: { agents: false } }));
    assert.ok(fs.existsSync(skillFile('.agents')));

    const result = refresh();
    assert.equal(result.action, 'install');
    assert.equal(result.status.skills.find((item) => item.id === 'claude').version, VERSION);
    assert.ok(!fs.existsSync(skillFile('.agents')), '关掉的 skill 应删掉');
  });

  test('没装命令：只更新装着的旧 skill，不主动装新的；有更新的版本就不动', () => {
    fs.mkdirSync(path.join(home, '.codex', 'skills', 'cloudssh'), { recursive: true });
    fs.writeFileSync(skillFile('.codex'), '---\nname: cloudssh\ndescription: 旧版\n---\n\n旧版的说明\n');
    const result = refresh();
    assert.equal(result.action, 'skills');
    assert.equal(fs.readFileSync(skillFile('.codex'), 'utf8').endsWith(`<!-- cloudssh-skill ${VERSION} -->\n`), true);
    assert.ok(!fs.existsSync(skillFile('.claude')), '没装过的不主动装');
    assert.equal(result.status.installed, false);

    pretendSkillVersion(skillFile('.codex'), '99.0.0');
    const newer = fs.readFileSync(skillFile('.codex'), 'utf8');
    assert.equal(refresh().action, 'none');
    assert.equal(fs.readFileSync(skillFile('.codex'), 'utf8'), newer);
  });
});
