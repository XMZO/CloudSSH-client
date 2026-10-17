/**
 * 节点首页：大标题 + 底部浮动操作栏（搜索、排序、添加）+ 浮动的“回到终端”胶囊。
 * 列表本身仍是 nodes.ts 渲染的那一份，这里只加几个元素，布局全部在 hosts.css。
 */
import { groupServersByTag } from '@cloudssh/core';
import { getServers, subscribe } from '../../../sidebar/store';
import { openSettings } from '../../settings';
import { Disposer, h, iconButton, clickById } from '../dom';
import { onLocaleChange, st } from '../i18n';
import type { SkinModule } from '../types';
import './hosts.css';

export const hostsModule: SkinModule = {
  id: 'hosts',
  mount() {
    const disposer = new Disposer();
    const root = document.getElementById('cs-mobile-nodes');
    const bar = root?.querySelector<HTMLElement>('.cs-m-nodes-bar');
    if (!root || !bar) return () => disposer.run();

    // 大标题
    const head = disposer.own(h('header', 'cs-ob-hosts-head'));
    const title = h('h1', 'cs-ob-hosts-title');
    const subtitle = h('p', 'cs-ob-hosts-sub');
    head.append(title, subtitle);
    root.prepend(head);

    // 底部栏里的“添加服务器”
    const add = disposer.own(iconButton('add', st('addServer'), 'cs-m-iconbtn cs-ob-add'));
    add.addEventListener('click', () => clickById('add-server-btn'));
    bar.append(add);

    // 顶栏右侧的设置入口（底部栏只留搜索、排序、添加）
    const header = document.querySelector<HTMLElement>('#user-space-section .user-space-header');
    const more = document.getElementById('user-space-more-btn');
    const settings = disposer.own(iconButton('tune', st('settings'), 'cs-ob-header-btn'));
    settings.addEventListener('click', () => void openSettings());
    if (more?.parentElement) more.before(settings);
    else header?.append(settings);

    const render = () => {
      title.textContent = st('hosts');
      add.setAttribute('aria-label', st('addServer'));
      add.title = st('addServer');
      settings.setAttribute('aria-label', st('settings'));
      settings.title = st('settings');
      const servers = getServers() ?? [];
      if (!servers.length) {
        subtitle.textContent = st('hostsSubtitleEmpty');
        return;
      }
      // 没有标签的服务器不算分组；一个分组都没有时只显示台数
      const { groups } = groupServersByTag(servers, { sort: 'name' });
      const parts = [servers.length === 1 ? st('hostsCountOne') : st('hostsCount', { n: servers.length })];
      if (groups.length) parts.push(groups.length === 1 ? st('groupsCountOne') : st('groupsCount', { n: groups.length }));
      subtitle.textContent = parts.join(' · ');
    };
    disposer.add(subscribe(render));
    disposer.add(onLocaleChange(render));
    render();

    return () => disposer.run();
  },
};
