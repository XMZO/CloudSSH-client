// Node 24 直接执行 TS 源文件，不编译/打包客户端，也不接触用户日志。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendRotatingLog, MAX_LOG_BYTES, LOG_BACKUPS } from '../src/main/rotating-log.ts';
import { connectionLogData, connectionEndpoint } from '../src/main/connection-log-data.ts';
import { CONNECTION_DIAGNOSTIC_HOOKS } from '../../../packages/ui-web/connection-diagnostic-hooks.ts';
import { connectionDiagnostic } from '../../../packages/ui-web/overrides/shared/terminal/connection-diagnostics.ts';
import ts from 'typescript';

test('持续写入时轮转，总量有界，最新记录保留，旧版超大文件收敛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-log-test-'));
  try {
    const file = path.join(dir, 'main.log');
    fs.writeFileSync(file, 'old\n'.repeat(MAX_LOG_BYTES));
    fs.writeFileSync(`${file}.1`, 'older\n'.repeat(MAX_LOG_BYTES));
    for (let cycle = 0; cycle < 8; cycle++) {
      fs.appendFileSync(file, Buffer.alloc(MAX_LOG_BYTES, 120));
      appendRotatingLog(file, `cycle-${cycle}`);
    }
    appendRotatingLog(file, 'x'.repeat(100_000));
    appendRotatingLog(file, 'latest\ninjected');
    const files = fs.readdirSync(dir);
    assert.ok(files.length <= LOG_BACKUPS + 1);
    const sizes = files.map((name) => fs.statSync(path.join(dir, name)).size);
    assert.ok(sizes.every((size) => size <= MAX_LOG_BYTES));
    assert.ok(sizes.reduce((a, b) => a + b, 0) <= MAX_LOG_BYTES * (LOG_BACKUPS + 1));
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.endsWith('latest injected\n'));
    assert.ok(content.includes('[truncated]'));
    assert.ok(Buffer.byteLength(content.split('\n')[0]) <= 16 * 1024);
  } finally {
    // mkdtemp 返回的单次测试目录，不使用用户路径或拼接 shell 删除。
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同一次运行持续追加会淘汰最旧归档；轮转失败时不继续增长', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-log-rotation-'));
  try {
    const file = path.join(dir, 'main.log');
    for (let i = 0; i < 1400; i++) appendRotatingLog(file, `record-${i} ${'x'.repeat(10_000)}`);
    assert.equal(fs.readdirSync(dir).length, LOG_BACKUPS + 1);
    assert.ok(fs.readFileSync(file, 'utf8').includes('record-1399 '));
    assert.ok(!fs.readFileSync(`${file}.4`, 'utf8').includes('record-0 '));
    for (const name of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, name)).size <= MAX_LOG_BYTES);
    fs.writeFileSync(file, Buffer.alloc(MAX_LOG_BYTES));
    fs.rmSync(`${file}.4`);
    fs.mkdirSync(`${file}.4`); // 模拟归档路径不可删除，禁止失败后无界追加
    assert.throws(() => appendRotatingLog(file, 'must not append'));
    assert.equal(fs.statSync(file).size, MAX_LOG_BYTES);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('诊断边界过滤凭据、正文、无效字段和完整 URL', () => {
  const data = connectionLogData({ event: 'socket-close', code: 1006, wasClean: false,
    password: 'secret', resumeToken: 'token', url: 'wss://example.com/?token=secret',
    reason: 'token=secret', serverEvent: 'remote_closed', messageType: { nested: 'secret' },
    durationMs: Infinity, cause: 'bad\nline', terminalId: 3 });
  assert.deepEqual(data, { event: 'socket-close', terminalId: 3, code: 1006, wasClean: false, serverEvent: 'remote_closed' });
  assert.equal(connectionLogData({ event: 'arbitrary' }), null);
  assert.deepEqual(connectionEndpoint('wss://user:password@example.com/api/ssh?session=secret&resume_token=secret'),
    { endpoint: 'wss://example.com/api/ssh', resume: true });
  assert.deepEqual(connectionEndpoint('https://example.com/api/share/secret?token=secret'),
    { endpoint: 'https://example.com/api/[other]', resume: false });
});

test('所有诊断钩子在当前 upstream 中唯一匹配', () => {
  let source = fs.readFileSync(new URL('../../../packages/ui-web/upstream/frontend/src/terminal.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const hook of CONNECTION_DIAGNOSTIC_HOOKS) {
    assert.equal(source.split(hook.anchor).length - 1, 1, hook.anchor);
    source = source.replace(hook.anchor, hook.anchor + hook.inject);
  }
  const parsed = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true);
  assert.deepEqual(parsed.parseDiagnostics, [], '注入后的源码语法有效（只解析，不编译）');
});

test('连接关联、迟到关闭、心跳采样与凭据隔离', () => {
  const saved = new Map(['document', 'cloudsshDesktop', 'WebSocket'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const entries = [];
  class Socket extends EventTarget { static OPEN = 1; readyState = 1; }
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
    Object.defineProperty(globalThis, 'cloudsshDesktop', { configurable: true, value: { connectionLog: (entry) => entries.push(entry) } });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    const first = new Socket();
    const term = { ws: first, sessionReady: true, activeSessionId: 'SECRET_ID', activeResumeToken: 'SECRET_TOKEN' };
    connectionDiagnostic(term, 'socket-attached');
    first.dispatchEvent(new MessageEvent('message', { data: 'SECRET_OUTPUT' }));
    connectionDiagnostic(term, 'heartbeat-summary');
    connectionDiagnostic(term, 'heartbeat-summary');
    const oldId = entries[0].connectionId;
    term.ws = new Socket();
    connectionDiagnostic(term, 'socket-attached');
    const close = new Event('close');
    Object.assign(close, { code: 1006, wasClean: false, reason: 'SECRET_REASON' });
    first.dispatchEvent(close);
    const last = entries.at(-1);
    assert.equal(last.connectionId, oldId);
    assert.equal(last.current, false);
    assert.equal(last.receivedMessages, 1);
    assert.equal(last.reasonLength, 13);
    assert.equal(entries.filter((entry) => entry.event === 'heartbeat-summary').length, 1);
    assert.ok(!JSON.stringify(entries).includes('SECRET'));
    assert.ok(entries.every((entry) => connectionLogData(entry)));
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
