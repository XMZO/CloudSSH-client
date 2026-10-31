/**
 * 入口网关背后的 SFTP 附加地址（../../ui-web/overrides/shared/gateway-attach.ts，命令行经 ai-remote/session.ts 用它）：
 * 别的节点的域名换回网关的、带上 via；网关自己的、普通实例的、不是 SFTP 附加的地址原样不动。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { localizeAttachUrl } from '../../ui-web/overrides/shared/gateway-attach.ts';

describe('localizeAttachUrl', () => {
  const gateway = 'wss://gw.example.com/api/ssh?token=t&node=A';

  test('别的节点的附加地址：换成网关的，记下原主机', () => {
    const out = new URL(localizeAttachUrl('wss://node-a.example.com/api/ssh/sftp?session=s1&token=x', gateway));
    assert.equal(out.origin, 'wss://gw.example.com');
    assert.equal(out.pathname, '/api/ssh/sftp');
    assert.equal(out.searchParams.get('session'), 's1');
    assert.equal(out.searchParams.get('token'), 'x');
    assert.equal(out.searchParams.get('via'), 'node-a.example.com');
  });

  test('本来就是网关 / 实例自己的、不是 SFTP 附加的：原样', () => {
    const own = 'wss://gw.example.com/api/ssh/sftp?session=s1&token=x';
    assert.equal(localizeAttachUrl(own, gateway), own);
    assert.equal(localizeAttachUrl('wss://other.example.com/api/ssh?token=x', gateway), 'wss://other.example.com/api/ssh?token=x');
    assert.equal(localizeAttachUrl('not a url', 'also not'), 'not a url');
  });

  test('页面地址是 https / http 时换成 wss / ws', () => {
    assert.match(localizeAttachUrl('wss://a.example.com/api/ssh/sftp?session=s', 'https://gw.example.com/'), /^wss:\/\/gw\.example\.com\//);
    assert.match(localizeAttachUrl('ws://127.0.0.1:8801/api/ssh/sftp?session=s', 'http://127.0.0.1:8810/'), /^ws:\/\/127\.0\.0\.1:8810\/api\/ssh\/sftp\?session=s&via=127\.0\.0\.1%3A8801$/);
  });
});
