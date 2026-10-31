/**
 * 入口网关的纯逻辑（../sync.js）：双向同步计划、防误删、请求体、主机指纹 ID 换算、新会话放哪边。
 * 运行：node --test tools/gateway/test
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  chooseNode,
  deletesLookSafe,
  needsCredential,
  nextUtcMidnight,
  planServers,
  planSnippets,
  serverBody,
  translateHostIdentity,
} from '../sync.js';

const T1 = '2026-10-30 10:00:00';
const T2 = '2026-10-30 11:00:00';
const T3 = '2026-10-30 12:00:00';

const server = (id, extra = {}) => ({
  id,
  name: `s${id}`,
  host: `10.0.0.${id}`,
  port: 22,
  username: 'root',
  auth_method: 'password',
  tags: [],
  jump_server_id: null,
  updated_at: T1,
  ...extra,
});

const brief = (plan) => ({
  keep: plan.keep.map((e) => [e.a, e.b]),
  copies: plan.copies.map((c) => [c.from, c.src.id, c.a, c.b]),
  deletes: plan.deletes.map((d) => [d.side, d.id]),
});

describe('planServers：还没对照过', () => {
  test('两边从同一份数据恢复（ID、内容、updated_at 都一样）：全部直接对上，不写', () => {
    const a = [server(1), server(2)];
    const b = [server(1), server(2)];
    assert.deepEqual(brief(planServers(a, b, [])), { keep: [[1, 1], [2, 2]], copies: [], deletes: [] });
  });

  test('ID 不同但内容一样：按内容对上；updated_at 新的那边为准', () => {
    const plan = planServers([server(1, { updated_at: T2 })], [server(9, { name: 's1', host: '10.0.0.1', updated_at: T1 })], []);
    assert.deepEqual(brief(plan), { keep: [], copies: [['A', 1, 1, 9]], deletes: [] });
  });

  test('只有一边有：抄过去新建，跳板先建', () => {
    const plan = planServers([], [server(3, { jump_server_id: 1 }), server(1)], []);
    assert.deepEqual(brief(plan).copies, [['B', 1, null, 1], ['B', 3, null, 3]]);
  });
});

describe('planServers：已经对照过', () => {
  const map = [{ a: 1, b: 11, ua: T1, ub: T1 }];

  test('两边都没变：不写', () => {
    assert.deepEqual(brief(planServers([server(1)], [server(11, { name: 's1', host: '10.0.0.1' })], map)), {
      keep: [[1, 11]],
      copies: [],
      deletes: [],
    });
  });

  test('只有 B 变了：B→A；只有 A 变了：A→B', () => {
    assert.deepEqual(brief(planServers([server(1)], [server(11, { updated_at: T2 })], map)).copies, [['B', 11, 1, 11]]);
    assert.deepEqual(brief(planServers([server(1, { updated_at: T2 })], [server(11)], map)).copies, [['A', 1, 1, 11]]);
  });

  test('两边都变了：updated_at 新的那边为准', () => {
    assert.deepEqual(brief(planServers([server(1, { updated_at: T3 })], [server(11, { updated_at: T2 })], map)).copies, [['A', 1, 1, 11]]);
    assert.deepEqual(brief(planServers([server(1, { updated_at: T2 })], [server(11, { updated_at: T3 })], map)).copies, [['B', 11, 1, 11]]);
  });

  test('B 删了、A 没改：A 跟着删；A 删了、B 改过：以 B 为准重新建到 A', () => {
    assert.deepEqual(brief(planServers([server(1)], [], map)).deletes, [['A', 1]]);
    assert.deepEqual(brief(planServers([], [server(11, { updated_at: T2 })], map)).copies, [['B', 11, null, 11]]);
  });

  test('删的时候用别人当跳板的先删', () => {
    const rows = [
      { a: 1, b: 11, ua: T1, ub: T1 },
      { a: 2, b: 12, ua: T1, ub: T1 },
    ];
    const plan = planServers([server(1), server(2, { jump_server_id: 1 })], [], rows);
    assert.deepEqual(brief(plan).deletes, [['A', 2], ['A', 1]]);
  });
});

describe('防误删', () => {
  test('少量删除放行；一下删很多（像读回了空列表）拒绝', () => {
    assert.equal(deletesLookSafe([{ side: 'A', id: 1 }], 87, 87), true);
    const many = Array.from({ length: 30 }, (_, i) => ({ side: 'A', id: i }));
    assert.equal(deletesLookSafe(many, 87, 57), false);
  });
});

describe('planSnippets', () => {
  test('按名称和命令配对，其余抄过去', () => {
    const snippet = (id, name, command, updated_at = T1) => ({ id, name, command, category: '', updated_at });
    const plan = planSnippets([snippet(1, 'a', 'ls')], [snippet(5, 'a', 'ls'), snippet(6, 'b', 'pwd')], []);
    assert.deepEqual(brief(plan), { keep: [[1, 5]], copies: [['B', 6, null, 6]], deletes: [] });
  });
});

describe('serverBody / needsCredential', () => {
  const credential = { authMethod: 'password', password: 'pw', privateKey: 'KEY', cfAccessClientSecret: 'sec' };

  test('密码 / 私钥 / none', () => {
    assert.equal(serverBody(server(1), credential, null).credential, 'pw');
    assert.equal(serverBody(server(1, { auth_method: 'publickey' }), credential, null).credential, 'KEY');
    assert.equal('credential' in serverBody(server(1, { auth_method: 'none' }), undefined, null), false);
    assert.equal(needsCredential(server(1, { auth_method: 'none' })), false);
  });

  test('跳板换成目标那边的 ID；区域：来源指定就带，来源没有、目标有就清掉', () => {
    assert.equal(serverBody(server(2, { jump_server_id: 1 }), credential, 41).jump_server_id, 41);
    assert.equal(serverBody(server(1, { region: 'apac' }), credential, null).region, 'apac');
    assert.equal(serverBody(server(1), credential, null, server(9, { region: 'weur' })).region, '');
    assert.equal('region' in serverBody(server(1), credential, null, server(9)), false);
  });

  test('CF 隧道：只有存了 Access 密钥才读、才带', () => {
    const tunnel = server(1, { auth_method: 'none', transport_type: 'cf_tunnel', cf_tunnel_host: 'ssh.example.com', has_cf_access_client_secret: true });
    assert.equal(needsCredential(tunnel), true);
    assert.equal(serverBody(tunnel, credential, null).cf_access_client_secret, 'sec');
    assert.equal(serverBody({ ...tunnel, has_cf_access_client_secret: false }, credential, null).cf_access_client_secret, '');
  });
});

describe('translateHostIdentity', () => {
  const toA = (id) => ({ 11: 1, 12: 2 })[id];
  test('直连地址不变；经过跳板时把路径里的服务器 ID 换掉', () => {
    assert.equal(translateHostIdentity('10.0.0.5', toA), '10.0.0.5');
    assert.equal(translateHostIdentity('jump:11@1.2.3.4:22>12@10.0.0.2:2222|10.0.0.3', toA), 'jump:1@1.2.3.4:22>2@10.0.0.2:2222|10.0.0.3');
  });
  test('路径里有还没同步过去的服务器：不抄', () => {
    assert.equal(translateHostIdentity('jump:11@1.2.3.4:22>99@10.0.0.2:22|10.0.0.3', toA), null);
  });
});

describe('chooseNode', () => {
  const node = (name, ratio, extra = {}) => ({ name, ratio, limit: 0.9, down: false, ...extra });
  test('fill：按顺序用第一个没暂停、没到上限的；拿不到用量时照样能用', () => {
    assert.equal(chooseNode([node('A', 0.5), node('B', 0.1)]), 'A');
    assert.equal(chooseNode([node('A', 0.95), node('B', 0.1)]), 'B');
    assert.equal(chooseNode([node('A', 0.2, { down: true }), node('B', 0.1)]), 'B');
    assert.equal(chooseNode([node('A', null), node('B', 0.1)]), 'A');
    assert.equal(chooseNode([node('C', 0.95), node('A', 0.5, { limit: 0.4 }), node('B', 0.1)]), 'B');
  });
  test('even：没到上限的里面挑用得最少的', () => {
    assert.equal(chooseNode([node('A', 0.5), node('B', 0.1)], 'even'), 'B');
    assert.equal(chooseNode([node('A', 0.2), node('B', 0.3)], 'even'), 'A');
  });
  test('都到上限：挑第一个没暂停的；全暂停：第一个', () => {
    assert.equal(chooseNode([node('A', 1.1, { down: true }), node('B', 0.95)]), 'B');
    assert.equal(chooseNode([node('A', 0.2, { down: true }), node('B', 0.1, { down: true })]), 'A');
  });
  test('下一个 UTC 0 点', () => {
    assert.equal(nextUtcMidnight(Date.UTC(2026, 9, 30, 13, 5)), Date.UTC(2026, 9, 31));
  });
});
