import { describe, expect, it } from 'vitest';
import { groupServersByTag, matchesServerQuery, serverInitial, type GroupableServer } from '../src';

const servers: GroupableServer[] = [
  { id: 1, name: '华为云 香港', host: '1.1.1.1', tags: ['中国 🇨🇳'], last_connected_at: 100 },
  { id: 2, name: 'vps.town 6c24', host: 'hk.example.com', username: 'root', tags: ['中国 🇨🇳'], last_connected_at: 300 },
  { id: 3, name: 'BuyVm 瑞士', host: '104.244.0.1', tags: ['瑞士 🇨🇭'], last_connected_at: 500 },
  { id: 4, name: 'Home Router', host: '192.168.1.1', tags: [] },
  { id: 5, name: 'LA 1', host: '2.2.2.2', tags: ['美国 🇺🇸', ' 美国 🇺🇸 ', ''] },
  { id: 6, name: 'LA 10', host: '2.2.2.3', tags: ['美国 🇺🇸'] },
  { id: 7, name: 'LA 2', host: '2.2.2.4', tags: ['美国 🇺🇸'], last_connected_at: 50 },
];

describe('groupServersByTag', () => {
  it('按标签分组，无标签的进 ungrouped，重复/空白标签去重', () => {
    const result = groupServersByTag(servers);
    expect(result.total).toBe(7);
    expect(result.ungrouped.map((s) => s.id)).toEqual([4]);
    const us = result.groups.find((g) => g.key === '美国 🇺🇸')!;
    // 数字自然排序：LA 1 < LA 2 < LA 10
    expect(us.servers.map((s) => s.name)).toEqual(['LA 1', 'LA 2', 'LA 10']);
  });

  it('count 排序：节点多的分组在前', () => {
    const { groups } = groupServersByTag(servers, { sort: 'count' });
    expect(groups.map((g) => g.servers.length)).toEqual([3, 2, 1]);
  });

  it('recent 排序：分组与组内都按最近连接时间', () => {
    const { groups } = groupServersByTag(servers, { sort: 'recent' });
    expect(groups[0].key).toBe('瑞士 🇨🇭');
    const cn = groups.find((g) => g.key === '中国 🇨🇳')!;
    expect(cn.servers.map((s) => s.id)).toEqual([2, 1]);
    expect(cn.lastConnectedAt).toBe(300);
  });

  it('搜索：多个关键词需全部命中，覆盖名称/主机/用户名/标签', () => {
    expect(groupServersByTag(servers, { query: 'la 1' }).total).toBe(2); // LA 1、LA 10
    expect(groupServersByTag(servers, { query: '瑞士' }).groups.map((g) => g.key)).toEqual(['瑞士 🇨🇭']);
    expect(matchesServerQuery(servers[1], 'ROOT hk')).toBe(true);
    expect(matchesServerQuery(servers[1], 'root nothing')).toBe(false);
    expect(groupServersByTag(servers, { query: 'zzz' })).toEqual({ groups: [], ungrouped: [], total: 0 });
  });
});

describe('serverInitial', () => {
  it('取首字符（中文/英文/空名称）', () => {
    expect(serverInitial('华为云 香港')).toBe('华');
    expect(serverInitial('  hytron')).toBe('H');
    expect(serverInitial('')).toBe('?');
  });
});
