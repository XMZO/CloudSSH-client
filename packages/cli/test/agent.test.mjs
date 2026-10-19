/**
 * 后台会话进程（cloudssh exec 复用到服务器的会话）：复用、同一台并发不排队、调用方被结束时远端命令随之结束、
 * 空闲退出、CLOUDSSH_AGENT=0 关闭、退出登录时一起退出；输出与退出码和不用后台进程时一样。
 * 对假 Worker 执行，全部在临时目录里（每个用例自己的配置目录，后台进程互不相干，用例结束时停掉）。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { CLI, isolatedEnv, runCli, startMock } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('后台会话进程', { timeout: 180_000 }, () => {
  let mock;
  let env;
  let target;

  const status = (e = env) => JSON.parse(runCli(['agent', 'status', '--json'], e).stdout);
  /** 不等结束的 exec（测并发与中途结束） */
  const execAsync = (command) => {
    const child = spawn(process.execPath, [CLI, 'exec', '--json', target, command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout })));
    return { child, done };
  };
  async function waitFor(check, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await sleep(150);
    }
    return check();
  }

  before(async () => {
    mock = await startMock();
  });
  after(() => mock?.stop());
  beforeEach(() => {
    ({ env } = isolatedEnv(mock.url));
    env.CLOUDSSH_AGENT = '1';
    env.CLOUDSSH_AGENT_IDLE = '60';
    const servers = JSON.parse(runCli(['servers', '--json', '-q', 'JP-A'], env).stdout);
    target = servers[0].id;
  });
  afterEach(() => {
    runCli(['agent', 'stop'], env);
  });

  test('第二次起复用会话；输出、--json、退出码与不用后台进程时一样', () => {
    assert.equal(status().running, false);
    const first = runCli(['exec', target, 'echo hello'], env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, 'hello\n');
    const again = runCli(['exec', '--json', target, 'echo "a b"'], env);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).output, '"a b"');
    const failed = runCli(['exec', target, 'exit 3'], env);
    assert.equal(failed.code, 3);

    const now = status();
    assert.equal(typeof now.pid, 'number');
    assert.deepEqual(now.sessions, [{ server: target, open: 1, busy: 0 }]);

    // 与不用后台进程时逐字一致
    const direct = runCli(['exec', '--json', target, 'echo "a b"'], { ...env, CLOUDSSH_AGENT: '0' });
    const viaAgent = runCli(['exec', '--json', target, 'echo "a b"'], env);
    const strip = (text) => ({ ...JSON.parse(text), durationMs: 0 });
    assert.deepEqual(strip(viaAgent.stdout), strip(direct.stdout));

    // 目标写错照样是用法错误（退出码 2）
    const missing = runCli(['exec', 'srv-99999', 'echo x'], env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /没有主机 ID 为 srv-99999/);
  });

  test('同一台同时跑两条不互相排队（再开一条会话）', async () => {
    runCli(['exec', target, 'echo warm'], env);
    const started = Date.now();
    const [a, b] = [execAsync('sleep 2'), execAsync('sleep 2')];
    const [ra, rb] = await Promise.all([a.done, b.done]);
    const elapsed = Date.now() - started;
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    assert.ok(elapsed < 3800, `两条应同时执行，实际用了 ${elapsed}ms`);
    assert.equal(status().sessions[0].open, 2);
  });

  test('调用方被结束时关掉它用的会话（远端命令随之结束）', async () => {
    runCli(['exec', target, 'echo warm'], env);
    const run = execAsync('sleep 30');
    assert.ok(await waitFor(() => status().sessions.some((item) => item.busy > 0)), '命令应在执行');
    run.child.kill();
    await run.done;
    assert.ok(await waitFor(() => !status().sessions.some((item) => item.server === target)), '会话应被关掉');
  });

  test('同名管道被别的程序占了：应答对不上，命令不发给它，改在本进程执行', async () => {
    // 按 agent.ts 的规则算出这个配置目录、实例、程序对应的地址，抢先占上
    const version = runCli(['--version'], env).stdout.trim().split(/\s/)[0];
    let user = '';
    try {
      user = os.userInfo().username;
    } catch {}
    const key = crypto
      .createHash('sha256')
      .update([user, env.CLOUDSSH_HOME, mock.url, version, CLI, String(fs.statSync(CLI).mtimeMs)].join('\n'))
      .digest('hex')
      .slice(0, 16);
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\cloudssh-agent-${key}` : path.join(env.CLOUDSSH_HOME, `agent-${key}.sock`);
    let received = '';
    // 冒名的服务按协议回话，但它没有用户的登录，算不出正确的应答
    const squatter = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        if (!received) socket.write(`${JSON.stringify({ answer: '0'.repeat(64), challenge: 'f'.repeat(32) })}\n`);
        received += chunk;
      });
      socket.on('error', () => undefined);
    });
    await new Promise((resolve) => squatter.listen(address, resolve));
    try {
      // 异步跑（同步跑会卡住本进程，冒名的服务就答不了话）
      const started = Date.now();
      const { code, stdout } = await execAsync('echo secret-123').done;
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).output, 'secret-123');
      assert.doesNotMatch(received, /secret-123/);
      assert.ok(Date.now() - started < 2500, '认出不是自己的后台进程后应立即改在本进程执行');
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  test('经 Windows 启动器捕获输出时，不会被后台进程拖到它退出', { skip: process.platform !== 'win32' && '只在 Windows 上' }, () => {
    // 启动器若把调用方的输出管道留成可继承，会经 Node 漏给后台进程：管道关不上，捕获输出的一方等到后台进程空闲退出
    const bin = path.join(env.HOME, 'bin');
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    env.CLOUDSSH_AGENT_IDLE = '30';
    // 经启动器跑的是复制到安装目录的那份程序：它有自己的后台进程，状态、停止也要经同一个启动器
    const exe = (args) => spawnSync(path.join(bin, 'cloudssh.exe'), args, { env, encoding: 'utf8', timeout: 25_000 });
    try {
      for (const round of ['启动后台进程', '复用']) {
        const started = Date.now();
        const result = exe(['exec', target, 'echo x']);
        assert.equal(result.status, 0, `${round}：${result.stderr}`);
        assert.equal(result.stdout, 'x\n');
        assert.ok(Date.now() - started < 10_000, `${round}：捕获输出应及时结束，实际 ${Date.now() - started}ms`);
      }
      assert.equal(typeof JSON.parse(exe(['agent', 'status', '--json']).stdout).pid, 'number');
    } finally {
      exe(['agent', 'stop']);
    }
  });

  test('空闲后自动退出；CLOUDSSH_AGENT=0 时不启动；退出登录时一起退出', async () => {
    env.CLOUDSSH_AGENT_IDLE = '2';
    assert.equal(runCli(['exec', target, 'echo x'], env).code, 0);
    assert.equal(status().running, undefined);
    assert.ok(await waitFor(() => status().running === false, 6000), '应在空闲 2 秒后退出');

    const off = { ...env, CLOUDSSH_AGENT: '0' };
    assert.equal(runCli(['exec', target, 'echo x'], off).stdout, 'x\n');
    assert.equal(status(off).running, false);

    env.CLOUDSSH_AGENT_IDLE = '60';
    assert.equal(runCli(['exec', target, 'echo x'], env).code, 0);
    assert.equal(typeof status().pid, 'number');
    assert.equal(runCli(['logout'], env).code, 0);
    assert.equal(status().running, false);
  });
});
