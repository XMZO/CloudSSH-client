/**
 * 从别的实例导入本地数据的纯函数部分（src/main/platform/instance-import-plan.ts）：编号对应、本地存储改写、
 * AI 对话历史换范围、凭据预设关联合并。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudssh-instance-import-'));
const bundle = path.join(temp, 'plan.mjs');
await build({
  entryPoints: [path.join(here, '..', 'src', 'main', 'platform', 'instance-import-plan.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'silent',
});
const { matchIds, mergePresetLinks, serverKey, translateConversations, translateLocalStorage } = await import(pathToFileURL(bundle).href);

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const server = (id, name, extra = {}) => ({ id, name, host: `${name}.example`, port: 22, username: 'root', ...extra });

describe('matchIds', () => {
  test('同内容同编号优先，其余按内容配；对不上的不配', () => {
    const source = [server(1, 'a'), server(2, 'b'), server(3, 'dup'), server(4, 'dup'), server(5, 'only-source')];
    const target = [server(1, 'a'), server(9, 'b'), server(4, 'dup'), server(8, 'dup')];
    const map = matchIds(source, target, serverKey);
    assert.deepEqual([...map.entries()].sort((x, y) => x[0] - y[0]), [
      [1, 1],
      [2, 9],
      [3, 8],
      [4, 4],
    ]);
  });
});

describe('translateLocalStorage', () => {
  const servers = new Map([[1, 11], [2, 12]]);
  const snippets = new Map([[5, 50]]);
  test('节点排序与命令片段顺序换编号，草稿不搬，其他原样，不是 cloudssh_ 开头的不搬', () => {
    const result = translateLocalStorage(
      {
        cloudssh_desktop_node_order: JSON.stringify({ groups: ['prod', 'dev'], servers: { prod: [2, 1, 99] } }),
        cloudssh_snippet_order: JSON.stringify(['5', '6']),
        cloudssh_agent_draft_1: '{"text":"x"}',
        cloudssh_terminal_highlight: '{"rules":[]}',
        other_app_key: '1',
      },
      servers,
      snippets
    );
    assert.deepEqual(JSON.parse(result.cloudssh_desktop_node_order), { groups: ['prod', 'dev'], servers: { prod: [12, 11] } });
    assert.deepEqual(JSON.parse(result.cloudssh_snippet_order), ['50']);
    assert.equal('cloudssh_agent_draft_1' in result, false);
    assert.equal(result.cloudssh_terminal_highlight, '{"rules":[]}');
    assert.equal('other_app_key' in result, false);
  });
});

describe('translateConversations', () => {
  test('范围换成目标主机名和编号；别的实例的、对不上的不搬', () => {
    const list = [
      { id: 'c1', scope: 'bash.al#1', title: 't1' },
      { id: 'c2', scope: 'bash.al#99', title: 't2' },
      { id: 'c3', scope: 'other.host#1', title: 't3' },
    ];
    assert.deepEqual(translateConversations(list, 'bash.al', 'ssh.example.de', new Map([[1, 11]])), [{ id: 'c1', scope: 'ssh.example.de#11', title: 't1' }]);
  });
});

describe('mergePresetLinks', () => {
  test('源实例的关联换编号后并进目标实例，目标原有的保留', () => {
    const file = { version: 1, presets: [], links: { 'instance:default': { p1: [1, 2, 99] }, 'instance:gw': { p1: [11], p2: [30] } } };
    const { file: next, links } = mergePresetLinks(file, 'instance:default', 'instance:gw', new Map([[1, 11], [2, 12]]));
    assert.equal(links, 2);
    assert.deepEqual(next.links['instance:gw'], { p1: [11, 12], p2: [30] });
    assert.deepEqual(next.links['instance:default'], { p1: [1, 2, 99] });
  });
});
