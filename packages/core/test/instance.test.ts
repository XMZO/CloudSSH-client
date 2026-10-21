import { describe, expect, it } from 'vitest';
import {
  createInstanceId,
  DEFAULT_WORKER_URL,
  InstanceConfigError,
  normalizeInstance,
  normalizeUiSource,
  normalizeWorkerUrl,
} from '../src';

describe('normalizeWorkerUrl', () => {
  it('只保留 origin 并补全 https', () => {
    expect(normalizeWorkerUrl('bash.al')).toBe(DEFAULT_WORKER_URL);
    expect(normalizeWorkerUrl('cloudssh.example.workers.dev')).toBe('https://cloudssh.example.workers.dev');
    expect(normalizeWorkerUrl(' https://Example.Workers.dev/ ')).toBe('https://example.workers.dev');
  });

  it('允许本地 http 开发地址', () => {
    expect(normalizeWorkerUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeWorkerUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
  });

  it('拒绝非本地 http、路径、凭据与其他协议', () => {
    expect(() => normalizeWorkerUrl('http://example.com')).toThrow(InstanceConfigError);
    expect(() => normalizeWorkerUrl('https://example.com/app')).toThrow(InstanceConfigError);
    expect(() => normalizeWorkerUrl('https://user:pass@example.com')).toThrow(InstanceConfigError);
    expect(() => normalizeWorkerUrl('ftp://example.com')).toThrow(InstanceConfigError);
    expect(() => normalizeWorkerUrl('')).toThrow(InstanceConfigError);
  });
});

describe('createInstanceId', () => {
  it('由名称生成唯一且合法的 ID', () => {
    expect(createInstanceId('My Server', [])).toBe('my-server');
    expect(createInstanceId('My Server', ['my-server'])).toBe('my-server-2');
    expect(createInstanceId('生产环境', [])).toBe('instance');
  });
});

describe('normalizeUiSource / normalizeInstance', () => {
  it('未知或缺失的 UI 来源回退到内置 web', () => {
    expect(normalizeUiSource(undefined)).toEqual({ kind: 'bundled', id: 'web' });
    expect(normalizeUiSource({ kind: 'weird' })).toEqual({ kind: 'bundled', id: 'web' });
  });

  it('dev-server 只保留 origin', () => {
    expect(normalizeUiSource({ kind: 'dev-server', url: 'http://127.0.0.1:5173/x' })).toEqual({
      kind: 'dev-server',
      url: 'http://127.0.0.1:5173',
    });
  });

  it('directory 必须提供路径', () => {
    expect(() => normalizeUiSource({ kind: 'directory', path: ' ' })).toThrow(InstanceConfigError);
  });

  it('校验实例 ID 并规范化地址', () => {
    expect(
      normalizeInstance({ id: 'prod', name: ' 生产 ', baseUrl: 'prod.workers.dev', ui: { kind: 'remote' } })
    ).toEqual({ id: 'prod', name: '生产', baseUrl: 'https://prod.workers.dev', ui: { kind: 'remote' } });
    expect(() => normalizeInstance({ id: 'Bad ID', baseUrl: DEFAULT_WORKER_URL })).toThrow(InstanceConfigError);
  });

  it('网络路线只认 direct，其余都跟随系统代理（不写这个字段）', () => {
    expect(normalizeInstance({ id: 'a', baseUrl: DEFAULT_WORKER_URL, proxy: 'direct' }).proxy).toBe('direct');
    for (const proxy of [undefined, 'system', 'socks5://x', 1]) {
      expect(normalizeInstance({ id: 'a', baseUrl: DEFAULT_WORKER_URL, proxy })).not.toHaveProperty('proxy');
    }
  });
});
