import { describe, expect, it } from 'vitest';
import {
  buildWebSocketUrl,
  extractSessionFromSetCookie,
  githubLoginUrl,
  isApiPath,
  isGitHubLoginStart,
  isPostLoginLanding,
  isSameInstanceOrigin,
  parseOAuthRedirectUri,
  webSocketHandshakeHeaders,
} from '../src';

const BASE = 'https://cloudssh.example.workers.dev';

describe('routes', () => {
  it('识别 API 路径', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/servers')).toBe(true);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/assets/index.js')).toBe(false);
  });

  it('ws/wss 与 http/https 视为同一实例 origin（与网页版 wsUrl 校验一致）', () => {
    expect(isSameInstanceOrigin(`wss://cloudssh.example.workers.dev/api/ssh?token=x`, BASE)).toBe(true);
    expect(isSameInstanceOrigin(`${BASE}/api/config`, BASE)).toBe(true);
    expect(isSameInstanceOrigin('wss://evil.example.com/api/ssh', BASE)).toBe(false);
    expect(isSameInstanceOrigin('ws://cloudssh.example.workers.dev/api/ssh', BASE)).toBe(false);
  });

  it('拼接 WebSocket 地址', () => {
    expect(buildWebSocketUrl(BASE, '/api/ssh/sftp', { session: 's', token: 't' })).toBe(
      'wss://cloudssh.example.workers.dev/api/ssh/sftp?session=s&token=t'
    );
    expect(buildWebSocketUrl('http://localhost:8787', '/api/ssh')).toBe('ws://localhost:8787/api/ssh');
  });

  it('原生平台握手头必须带同源 Origin', () => {
    expect(webSocketHandshakeHeaders(BASE, 'abc')).toEqual({ Origin: BASE, Cookie: 'session=abc' });
  });
});

describe('oauth', () => {
  it('识别登录入口与回调后的落地页', () => {
    expect(githubLoginUrl(BASE)).toBe(`${BASE}/api/auth/github`);
    expect(isGitHubLoginStart(`${BASE}/api/auth/github`, BASE)).toBe(true);
    expect(isGitHubLoginStart('https://other.dev/api/auth/github', BASE)).toBe(false);
    expect(isPostLoginLanding(`${BASE}/`, BASE)).toBe(true);
    expect(isPostLoginLanding(`${BASE}/api/auth/callback?code=1`, BASE)).toBe(false);
    expect(isPostLoginLanding('https://github.com/login', BASE)).toBe(false);
  });

  it('解析服务端实际使用的 OAuth 回调地址', () => {
    expect(
      parseOAuthRedirectUri(
        'https://github.com/login/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fbash.al%2Fapi%2Fauth%2Fcallback&state=s'
      )
    ).toBe('https://bash.al/api/auth/callback');
    expect(parseOAuthRedirectUri('not a url')).toBeNull();
  });

  it('从 Set-Cookie 中提取 session', () => {
    expect(
      extractSessionFromSetCookie([
        'session=123:abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800',
        'oauth_state=; Path=/; Max-Age=0',
      ])
    ).toBe('123:abc');
    expect(extractSessionFromSetCookie('session=; Path=/; Max-Age=0')).toBe('');
    expect(extractSessionFromSetCookie('oauth_state=x; Path=/')).toBeNull();
  });
});
