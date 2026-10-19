/**
 * Windows 启动器（cloudssh.exe + cloudssh.shim，见 packages/cli/shim）：安装、传参、拒绝被 PowerShell 拆坏的引号、
 * 从旧版 .cmd 升级、经启动器运行时重新安装与卸载。只在 Windows 上跑；pwsh、Windows PowerShell 没装的用例跳过。
 * 全部在临时目录里做（命令目录、家目录、LOCALAPPDATA 都指到临时目录），对假 Worker 执行。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CLI, isolatedEnv, runCli, startMock } from './helpers.mjs';

const windows = process.platform === 'win32';
const LAUNCHER = path.join(path.dirname(CLI), 'cloudssh-shim.exe');

function has(shell) {
  return windows && spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30_000 }).status === 0;
}

/** 经 PowerShell 运行一段脚本（脚本里用 '...' 写参数，与用户在 PowerShell 里敲的一样），退出码取最后那个程序的 */
function powershell(shell, script, env) {
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `${script}; exit $LASTEXITCODE`], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 直接运行装好的启动器（Node 按标准规则转义参数，相当于 pwsh 7.3+、Git Bash 调它） */
function runExe(exe, args, env, input) {
  const result = spawnSync(exe, args, { env, encoding: 'utf8', timeout: 60_000, input });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function waitGone(file, ms = 8000) {
  const end = Date.now() + ms;
  while (fs.existsSync(file) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 200));
  return !fs.existsSync(file);
}

describe('Windows 启动器', { skip: !windows && '只在 Windows 上', timeout: 180_000 }, () => {
  let mock;
  let env;
  let bin;
  let exe;
  const pwsh = has('pwsh');
  const legacy = has('powershell.exe');

  before(async () => {
    mock = await startMock();
  });
  after(() => mock?.stop());

  beforeEach(() => {
    let home;
    ({ env, home } = isolatedEnv(mock.url));
    bin = path.join(home, 'bin');
    exe = path.join(bin, 'cloudssh.exe');
    // 命令目录放在 PATH 最前面：PowerShell 里直接敲 cloudssh 找到的是这里的
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? env.Path ?? ''}`;
    delete env.Path;
    // 临时文件（Set-Content 写的命令文件）也放进临时目录
    env.TEMP = env.TMP = path.join(home, 'tmp');
    fs.mkdirSync(env.TEMP, { recursive: true });
  });

  test('构建产物带着启动器；安装成 .exe + .shim（以及 Git Bash 用的 sh 脚本），不再写 .cmd', () => {
    assert.ok(fs.existsSync(LAUNCHER), `${LAUNCHER} 应由 build.mjs 从 shim/ 复制过来`);
    const result = runCli(['install', '--bin-dir', bin, '--no-skill'], env);
    assert.equal(result.code, 0, result.stderr);
    for (const name of ['cloudssh', 'cssh']) {
      assert.ok(fs.existsSync(path.join(bin, `${name}.exe`)), `${name}.exe`);
      assert.ok(fs.existsSync(path.join(bin, name)), `${name}（sh 脚本）`);
      assert.ok(!fs.existsSync(path.join(bin, `${name}.cmd`)), `${name}.cmd 不应再写`);
      const shim = fs.readFileSync(path.join(bin, `${name}.shim`), 'utf8');
      assert.match(shim, /^# cloudssh-shim /);
      assert.ok(shim.includes(`runtime=${process.execPath}\r\n`));
      assert.match(shim, /^program=.*cloudssh\.mjs\r$/m);
    }
    const status = JSON.parse(runCli(['install', '--status', '--json', '--bin-dir', bin], env).stdout);
    assert.equal(status.installed, true);
    assert.equal(status.launcher, 'exe');
    assert.equal(status.exists, true);
    // 程序复制到了安装目录，启动器也跟着放了一份
    assert.ok(fs.existsSync(path.join(path.dirname(status.program), 'cloudssh-shim.exe')));
  });

  test('参数原样传到命令行：带引号的命令后面的 --json 照常认；退出码原样返回；--stdin 去掉 BOM', () => {
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    const result = runExe(exe, ['exec', 'JP-A', 'echo "a b" ok', '--json'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).output, '"a b" ok');

    const failed = runExe(exe, ['exec', 'JP-B', 'exit 3'], env);
    assert.equal(failed.code, 3);

    const stdin = runExe(exe, ['exec', '--json', '--stdin', 'JP-A'], env, '﻿echo 中文 ok\r\n');
    assert.equal(stdin.code, 0, stdin.stderr);
    assert.equal(JSON.parse(stdin.stdout).output, '中文 ok');

    const version = runExe(path.join(bin, 'cssh.exe'), ['--version'], env);
    assert.equal(version.code, 0, version.stderr);
  });

  test('PowerShell 7 里写在带引号的命令后面的 --json 照常认', { skip: !pwsh && '没装 pwsh' }, () => {
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    const result = powershell('pwsh', `cloudssh exec JP-A 'echo "$(hostname) ok"' --json`, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).output, '"$(hostname) ok"');
  });

  test('PowerShell 按旧规则拆坏了引号时拒绝运行（退出码 2），不带引号的照常', { skip: !legacy && !pwsh && '没装 PowerShell' }, () => {
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    if (legacy) {
      const refused = powershell('powershell.exe', `cloudssh exec JP-A 'echo "a b"' --json`, env);
      assert.equal(refused.code, 2, refused.stdout + refused.stderr);
      assert.match(refused.stderr, /Windows PowerShell 5\.1/);
      assert.match(refused.stderr, /--file/);
      const plain = powershell('powershell.exe', `cloudssh exec --json JP-A 'echo a b'`, env);
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(JSON.parse(plain.stdout).output, 'a b');
    }
    if (pwsh) {
      const refused = powershell('pwsh', `$PSNativeCommandArgumentPassing = 'Legacy'; cloudssh exec JP-A 'echo "a b"'`, env);
      assert.equal(refused.code, 2, refused.stdout + refused.stderr);
      assert.match(refused.stderr, /Legacy/);
    }
  });

  test('只有 Windows PowerShell 5.1 也能用：Set-Content 写文件再 --file（引号、中文原样），--stdin 传 ASCII', { skip: !legacy && '没装 Windows PowerShell' }, () => {
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    const viaFile = powershell(
      'powershell.exe',
      [
        `Set-Content -Encoding UTF8 -Path "$env:TEMP\\cloudssh-command.sh" -Value @'`,
        'echo "a b" 中文',
        `'@`,
        `cloudssh exec --json --file "$env:TEMP\\cloudssh-command.sh" JP-A`,
      ].join('\n'),
      env
    );
    assert.equal(viaFile.code, 0, viaFile.stderr);
    assert.equal(JSON.parse(viaFile.stdout).output, '"a b" 中文');

    const viaStdin = powershell('powershell.exe', [`@'`, 'echo "a b"', `'@ | cloudssh exec --json --stdin JP-A`].join('\n'), env);
    assert.equal(viaStdin.code, 0, viaStdin.stderr);
    assert.equal(JSON.parse(viaStdin.stdout).output, '"a b"');
  });

  test('cmd 里简单命令与 \\" 转义的引号照常', () => {
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    const result = spawnSync('cmd.exe', ['/d', '/c', 'cloudssh exec --json JP-A "echo \\"a b\\" ok"'], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
      windowsVerbatimArguments: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).output, '"a b" ok');
  });

  test('从旧版 .cmd 升级：重新安装换成 .exe 并删掉 .cmd', () => {
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['cloudssh', 'cssh']) {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nrem cloudssh-shim 0.3.24\r\n"${process.execPath}" "${CLI}" %*\r\n`);
    }
    assert.equal(JSON.parse(runCli(['install', '--status', '--json', '--bin-dir', bin], env).stdout).launcher, 'cmd');
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    assert.ok(!fs.existsSync(path.join(bin, 'cloudssh.cmd')));
    assert.ok(!fs.existsSync(path.join(bin, 'cssh.cmd')));
    assert.equal(JSON.parse(runCli(['install', '--status', '--json', '--bin-dir', bin], env).stdout).launcher, 'exe');
  });

  test('经启动器重新安装（启动器被锁着）与卸载（退出后再删）', async () => {
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    // 让装着的启动器与新的不一样（PE 末尾多一个字节照样能运行），逼它走“挪开再写”
    fs.appendFileSync(exe, Buffer.from([0]));
    const reinstall = runExe(exe, ['install', '--bin-dir', bin, '--no-skill'], env);
    assert.equal(reinstall.code, 0, reinstall.stderr);
    assert.ok(fs.readFileSync(exe).equals(fs.readFileSync(LAUNCHER)), '启动器应换成新的');
    const stale = () => fs.readdirSync(bin).filter((name) => /^cloudssh\.exe\.old-\d+$/.test(name));
    assert.equal(stale().length, 1, '被锁着的旧启动器应挪开');
    // 下次安装时删掉挪开的
    assert.equal(runCli(['install', '--bin-dir', bin, '--no-skill'], env).code, 0);
    assert.equal(stale().length, 0);

    const removed = runExe(exe, ['uninstall', '--bin-dir', bin, '--keep-skill'], env);
    assert.equal(removed.code, 0, removed.stderr);
    assert.ok(!fs.existsSync(path.join(bin, 'cloudssh.shim')));
    // 经启动器运行时 .exe 都在它退出后由脱离作业的 cmd 删掉（命令本身不等它：启动器不把输出管道漏给它）
    assert.ok(await waitGone(path.join(bin, 'cssh.exe')), 'cssh.exe 应在退出后被删掉');
    assert.ok(await waitGone(exe), 'cloudssh.exe 应在退出后被删掉');
  });
});
