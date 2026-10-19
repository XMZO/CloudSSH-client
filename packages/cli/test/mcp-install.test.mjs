/**
 * MCP 登记：cloudssh install --mcp、cloudssh mcp add / remove / status、cloudssh uninstall 对各应用配置文件的改动。
 * 全部在临时家目录里做（HOME、USERPROFILE、APPDATA 等指到临时目录），不碰这台电脑上真实的配置。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { CLI, isolatedEnv, runCli } from './helpers.mjs';

const windows = process.platform === 'win32';

function appConfig(env) {
  if (windows) return env.APPDATA;
  if (process.platform === 'darwin') return path.join(env.HOME, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME;
}

const backups = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.cloudssh-backup-`));

describe('MCP 登记', { timeout: 120_000 }, () => {
  let env;
  let home;
  let bin;
  let claude;
  let codex;
  let vscode;

  beforeEach(() => {
    ({ env, home } = isolatedEnv());
    bin = path.join(home, 'bin');
    claude = path.join(appConfig(env), 'Claude', 'claude_desktop_config.json');
    codex = path.join(home, '.codex', 'config.toml');
    vscode = path.join(appConfig(env), 'Code', 'User', 'mcp.json');
    // 已有的配置：其他设置与其他 MCP 服务器要原样保留
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, JSON.stringify({ globalShortcut: 'Ctrl+Space', mcpServers: { other: { command: 'other-mcp', args: [] } } }, null, 2));
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    fs.writeFileSync(codex, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other-mcp"\nargs = []\n');
    fs.mkdirSync(path.dirname(vscode), { recursive: true });
    fs.writeFileSync(vscode, '{\n  // 用户的注释\n  "servers": {\n    "other": { "type": "stdio", "command": "other-mcp", },\n  },\n}\n');
  });

  test('install --mcp 登记到指定应用，先备份，保留其他内容；重复安装不再改动', () => {
    const result = runCli(['install', '--bin-dir', bin, '--mcp', 'claude-desktop,codex,vscode'], env);
    assert.equal(result.code, 0, result.stderr);

    const claudeConfig = JSON.parse(fs.readFileSync(claude, 'utf8'));
    assert.equal(claudeConfig.globalShortcut, 'Ctrl+Space');
    assert.deepEqual(claudeConfig.mcpServers.other, { command: 'other-mcp', args: [] });
    const entry = claudeConfig.mcpServers.cloudssh;
    assert.equal(entry.command, process.execPath);
    assert.equal(entry.args.length, 2);
    assert.match(entry.args[0], /cloudssh\.mjs$/);
    assert.equal(entry.args[1], 'mcp');
    // 程序复制到了安装目录，登记的是那一份，不是测试用的 dist
    assert.notEqual(path.resolve(entry.args[0]), path.resolve(CLI));
    assert.ok(fs.existsSync(entry.args[0]));
    assert.equal(backups(claude).length, 1);

    const toml = fs.readFileSync(codex, 'utf8');
    assert.match(toml, /^model = "gpt-5"$/m);
    assert.match(toml, /^\[mcp_servers\.other\]$/m);
    assert.match(toml, /^\[mcp_servers\.cloudssh\]$/m);
    assert.match(toml, /^args = \[".*cloudssh\.mjs", "mcp"\]$/m);
    assert.equal(backups(codex).length, 1);

    const code = JSON.parse(fs.readFileSync(vscode, 'utf8'));
    assert.equal(code.servers.other.command, 'other-mcp');
    assert.equal(code.servers.cloudssh.type, 'stdio');
    assert.deepEqual(code.servers.cloudssh.args.slice(1), ['mcp']);
    assert.match(result.stderr, /注释没能保留/);

    const status = JSON.parse(runCli(['mcp', 'status', '--json', '--bin-dir', bin], env).stdout);
    for (const id of ['claude-desktop', 'codex', 'vscode']) {
      const item = status.find((target) => target.id === id);
      assert.ok(item.registered && item.current, `${id} 应已登记且是最新的`);
    }
    assert.equal(status.find((target) => target.id === 'cursor').registered, false);

    // 再装一次：都是最新的，不再改文件、不再备份
    const again = runCli(['install', '--bin-dir', bin, '--mcp', 'claude-desktop,codex'], env);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(backups(claude).length, 1);
    assert.equal(backups(codex).length, 1);
  });

  test('用户加的参数与环境变量在更新时保留；指向旧程序的登记重新安装时更新', () => {
    assert.equal(runCli(['mcp', 'add', 'claude-desktop', '--bin-dir', bin], env).code, 0);
    const config = JSON.parse(fs.readFileSync(claude, 'utf8'));
    config.mcpServers.cloudssh.args = ['/old/place/cloudssh.mjs', 'mcp', '--instance', 'work'];
    config.mcpServers.cloudssh.env = { CLOUDSSH_INSTANCE: 'work' };
    fs.writeFileSync(claude, JSON.stringify(config, null, 2));
    let status = JSON.parse(runCli(['mcp', 'status', '--json', '--bin-dir', bin], env).stdout);
    assert.equal(status.find((target) => target.id === 'claude-desktop').current, false);

    const result = runCli(['install', '--bin-dir', bin], env);
    assert.equal(result.code, 0, result.stderr);
    const entry = JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers.cloudssh;
    assert.match(entry.args[0], /cloudssh\.mjs$/);
    assert.notEqual(entry.args[0], '/old/place/cloudssh.mjs');
    assert.deepEqual(entry.args.slice(1), ['mcp', '--instance', 'work']);
    assert.equal(entry.env.CLOUDSSH_INSTANCE, 'work');
    status = JSON.parse(runCli(['mcp', 'status', '--json', '--bin-dir', bin], env).stdout);
    assert.equal(status.find((target) => target.id === 'claude-desktop').current, true);
    // 没要求的应用不碰
    assert.doesNotMatch(fs.readFileSync(codex, 'utf8'), /cloudssh/);
  });

  test('mcp remove 只删我们的那一项；uninstall 移除全部登记', () => {
    assert.equal(runCli(['install', '--bin-dir', bin, '--mcp', 'claude-desktop,codex'], env).code, 0);
    const removed = runCli(['mcp', 'remove', 'codex'], env);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(fs.readFileSync(codex, 'utf8'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other-mcp"\nargs = []\n');
    assert.ok(JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers.cloudssh);

    const result = runCli(['uninstall', '--bin-dir', bin], env);
    assert.equal(result.code, 0, result.stderr);
    const claudeConfig = JSON.parse(fs.readFileSync(claude, 'utf8'));
    assert.equal(claudeConfig.mcpServers.cloudssh, undefined);
    assert.deepEqual(claudeConfig.mcpServers.other, { command: 'other-mcp', args: [] });
    assert.equal(claudeConfig.globalShortcut, 'Ctrl+Space');
    assert.match(result.stderr, /Claude Desktop：已移除 MCP 服务器 cloudssh/);
    assert.ok(!fs.existsSync(path.join(bin, windows ? 'cloudssh.cmd' : 'cloudssh')));
  });

  test('别人的同名项不删；客户端名写错或配置坏了报错且不改文件', () => {
    const foreign = { mcpServers: { cloudssh: { command: 'someone-else', args: ['serve'] } } };
    fs.writeFileSync(claude, JSON.stringify(foreign));
    const removed = runCli(['mcp', 'remove', 'claude-desktop'], env);
    assert.equal(removed.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(claude, 'utf8')), foreign);

    const typo = runCli(['install', '--bin-dir', bin, '--mcp', 'claude-desk'], env);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /不认识的 MCP 客户端 claude-desk/);
    assert.ok(!fs.existsSync(path.join(bin, windows ? 'cloudssh.cmd' : 'cloudssh')), '名字写错时什么都不装');

    fs.writeFileSync(claude, '{ broken');
    const broken = runCli(['mcp', 'add', 'claude-desktop', '--bin-dir', bin], env);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /不是有效的 JSON，没有改动/);
    assert.equal(fs.readFileSync(claude, 'utf8'), '{ broken');
  });

  test('没有配置文件时新建；install --status 显示登记', () => {
    fs.rmSync(codex);
    assert.equal(runCli(['install', '--bin-dir', bin, '--mcp', 'codex'], env).code, 0);
    const toml = fs.readFileSync(codex, 'utf8');
    assert.match(toml, /^# cloudssh-mcp/);
    assert.equal(backups(codex).length, 0);
    const status = runCli(['install', '--status', '--bin-dir', bin], env);
    assert.match(status.stdout, /Codex MCP：已登记/);
  });
});
