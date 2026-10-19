/**
 * 登录（非交互：AI 代为执行或脚本里）：login 打印授权地址，login --callback 完成；登录写进 ~/.cloudssh 后，
 * 其他进程（别的终端、正在运行的 AI）的下一条命令马上能用；连不上实例时说清原因。
 * 终端里的交互式登录（自动开浏览器、在终端里粘贴网址）需要真实控制台，不在这里测。
 * 对假 Worker（--anon：未登录，带模拟的 GitHub 授权页）执行，全部在临时目录里。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { isolatedEnv, runCli, startMock } from './helpers.mjs';

describe('login', { timeout: 120_000 }, () => {
  let mock;
  let env;

  before(async () => {
    mock = await startMock(['--anon']);
  });
  after(() => mock?.stop());
  beforeEach(() => {
    ({ env } = isolatedEnv());
  });

  /** 模拟用户在浏览器里授权：打开授权页，拿到跳回回调的网址（含 code 与 state） */
  async function authorizeInBrowser(stdout) {
    const authorize = /https?:\/\/\S+\/mock-github\/authorize\?\S+/.exec(stdout)?.[0];
    assert.ok(authorize, `应打印授权地址：${stdout}`);
    const page = await (await fetch(authorize)).text();
    return /href="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
  }

  test('非交互时打印授权地址与 --callback 用法；完成后别的进程马上能用', async () => {
    const start = runCli(['login', mock.url, '--no-browser'], env);
    assert.equal(start.code, 0, start.stderr);
    assert.match(start.stderr, /cloudssh login --callback/);
    // AI 代为登录时：用户把跳回的网址发给 AI，由它完成
    assert.match(start.stderr, /由 AI 代为登录时/);
    const callback = await authorizeInBrowser(start.stderr);

    const done = runCli(['login', '--callback', callback], env);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stderr, /已登录/);

    // 另一个进程（相当于别的终端、已经在运行的 AI）不用重启就能用
    const status = JSON.parse(runCli(['status', '--json'], env).stdout);
    assert.equal(status.signedIn, true);
    const servers = runCli(['servers', '--json'], env);
    assert.equal(servers.code, 0, servers.stderr);
    assert.ok(JSON.parse(servers.stdout).length > 0);
  });

  test('粘贴的不是网址或缺 code / state 时报用法错误', () => {
    assert.equal(runCli(['login', mock.url, '--no-browser'], env).code, 0);
    const bad = runCli(['login', '--callback', 'not a url'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /请粘贴浏览器地址栏里完整的网址/);
    const noCode = runCli(['login', '--callback', `${mock.url}/api/auth/callback?state=x`], env);
    assert.equal(noCode.code, 2);
    assert.match(noCode.stderr, /网址里没有 code 或 state/);
  });

  test('没登录时立即报错，不联网', () => {
    const config = path.join(env.CLOUDSSH_HOME, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ instances: [{ name: 'mock', url: mock.url }], defaultInstance: mock.url }));
    const started = Date.now();
    const result = runCli(['servers', '--json'], env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /还没有登录/);
    assert.ok(Date.now() - started < 5000);
  });

  test('连不上实例时说清原因（不是 “fetch failed”）', () => {
    const result = runCli(['login', 'https://cloudssh-test.invalid', '--no-browser'], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /连不上 https:\/\/cloudssh-test\.invalid：/);
    assert.doesNotMatch(result.stderr, /fetch failed/);
  });
});
