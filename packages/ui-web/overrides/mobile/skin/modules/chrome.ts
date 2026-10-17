/**
 * 紧凑终端栏：网页版的顶栏、标签栏、状态栏合并成一行，把高度留给终端。
 *
 *   [←]  ● 会话名                     [📁] [⋮]
 *        root@203.0.*.* · 18 ms · 2/3
 *
 * - ←：回到服务器列表（网页版的“+”）；点标题：会话列表；左右滑动标题：切换上一个/下一个会话
 * - 📁：SFTP；⋮：更多操作（常用命令、AI 助手、搜索、导出、横屏、快捷键、字号、复制地址、界面设置、断开）
 * 所有动作都转给网页版自己的按钮（即使被隐藏也能点），行为与网页版完全一致。
 * 网页版每次状态变化都会重绘标签栏与状态栏，这里据此同步刷新。
 */
import { copyTextToClipboard } from '../../../../upstream/frontend/src/clipboard';
import { maskIPAddress } from '../../../../upstream/frontend/src/host-display';
import { notify } from '../../../../upstream/frontend/src/ui-feedback';
import { activeTab, activeTabId, listTabs, switchToTab, type TabInfo } from '../../../sidebar/hooks';
import { mt } from '../../i18n';
import { openSettings } from '../../settings';
import { closeSheet, confirmSheet, openSheet } from '../../sheet';
import { openSessionList } from '../../tabs';
import { clickById, Disposer, h, icon, iconButton, prefersReducedMotion, rafThrottle, upstreamButtonAvailable } from '../dom';
import { isModuleActive } from '../engine';
import { fontSizeControl } from '../font-size';
import { onLocaleChange, st } from '../i18n';
import type { SkinModule } from '../types';
import './chrome.css';

const SWIPE_SLOP = 10;
const SWIPE_DISTANCE = 56;
const SWIPE_FLICK_SPEED = 0.5;

function stateClass(tab: TabInfo | null): string {
  if (tab?.state === 'connected') return 'is-connected';
  if (tab?.state === 'connecting') return 'is-connecting';
  return tab ? 'is-disconnected' : '';
}

function hostText(tab: TabInfo): string {
  const info = tab.hostInfo;
  if (!info) return '';
  return `${info.username ? `${info.username}@` : ''}${maskIPAddress(info.host) ?? info.host}`;
}

function animate(target: Element, keyframes: Keyframe[], duration: number): void {
  if (!isModuleActive('motion') || prefersReducedMotion() || typeof target.animate !== 'function') return;
  target.animate(keyframes, { duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
}

/** 切换会话后让新出现的终端从滑动方向淡入 */
function animateTerminalEnter(direction: 1 | -1): void {
  const area = document.getElementById('terminal-area');
  const visible = area
    ? [...area.children].find((child) => child instanceof HTMLElement && child.style.display !== 'none')
    : null;
  if (visible) {
    animate(
      visible,
      [
        { transform: `translateX(${direction * 28}px)`, opacity: 0.2 },
        { transform: 'translateX(0)', opacity: 1 },
      ],
      220
    );
  }
}

function openMoreSheet(): void {
  const tab = activeTab();
  const body = h('div', 'cs-ob-more');
  const grid = h('div', 'cs-ob-more-grid');
  const items: { icon: string; label: string; visible: boolean; run: () => void }[] = [
    {
      icon: 'terminal',
      label: st('actCommands'),
      visible: upstreamButtonAvailable('mobile-snippets-btn'),
      run: () => clickById('mobile-snippets-btn'),
    },
    {
      icon: 'psychology',
      label: st('actAgent'),
      visible: upstreamButtonAvailable('mobile-agent-btn'),
      run: () => {
        if (!activeTab()?.agentPanel) notify(st('agentUnavailable'), { variant: 'warning' });
        else clickById('mobile-agent-btn');
      },
    },
    { icon: 'search', label: st('actSearch'), visible: !!tab, run: () => clickById('mobile-search-btn') },
    { icon: 'download', label: st('actExport'), visible: !!tab, run: () => clickById('mobile-export-btn') },
    { icon: 'screen_rotation', label: st('actLandscape'), visible: true, run: () => clickById('mobile-landscape-btn') },
    {
      icon: 'keyboard',
      label: st('actShortcuts'),
      visible: upstreamButtonAvailable('mobile-shortcuts-terminal-btn'),
      run: () => clickById('mobile-shortcuts-terminal-btn'),
    },
    {
      icon: 'content_copy',
      label: mt('copyHost'),
      visible: !!tab?.hostInfo,
      run: () => {
        const host = activeTab()?.hostInfo?.host;
        if (host) void copyTextToClipboard(host).then((ok) => ok && notify(mt('copied'), { variant: 'success', duration: 1500 }));
      },
    },
    { icon: 'add', label: st('actNew'), visible: true, run: () => clickById('new-tab-btn') },
    { icon: 'tune', label: st('actSettings'), visible: true, run: () => void openSettings() },
  ];
  for (const item of items.filter((entry) => entry.visible)) {
    const button = h('button', 'cs-ob-more-item');
    button.type = 'button';
    button.append(icon(item.icon), h('span', 'cs-ob-more-label', item.label));
    button.addEventListener('click', () => {
      closeSheet();
      item.run();
    });
    grid.append(button);
  }
  body.append(grid, fontSizeControl());

  if (tab) {
    const disconnect = h('button', 'cs-ob-more-danger');
    disconnect.type = 'button';
    disconnect.append(icon('power_settings_new'), h('span', '', st('actDisconnect')));
    disconnect.addEventListener('click', async () => {
      const current = activeTab();
      if (!current) {
        closeSheet();
        return;
      }
      const ok = await confirmSheet(mt('closeSessionConfirm', { name: current.label ?? '' }), mt('closeSession'), mt('cancel'), true);
      // 确认期间可能已切换会话：只断开发起时的那个
      if (ok && activeTabId() === current.id) clickById('disconnect-btn');
    });
    body.append(disconnect);
  }
  openSheet(st('more'), body);
}

export const chromeModule: SkinModule = {
  id: 'chrome',
  mount() {
    const disposer = new Disposer();
    const section = document.getElementById('terminal-section');
    if (!section) return () => disposer.run();

    const bar = disposer.own(h('header', 'cs-ob-bar'));
    const back = iconButton('arrow_back', st('back'));
    back.addEventListener('click', () => clickById('new-tab-btn'));

    const title = h('button', 'cs-ob-title');
    title.type = 'button';
    const dot = h('span', 'cs-ob-dot');
    const text = h('span', 'cs-ob-title-text');
    const name = h('span', 'cs-ob-name');
    const sub = h('span', 'cs-ob-sub');
    text.append(name, sub);
    title.append(dot, text, icon('expand_more', 'cs-ob-chevron'));

    const sftp = iconButton('folder_open', st('actSftp'));
    sftp.addEventListener('click', () => {
      if (!activeTab()?.sftpPanel) {
        notify(st('sftpNotReady'), { variant: 'warning' });
        return;
      }
      clickById('mobile-sftp-btn');
    });
    const more = iconButton('more_vert', st('more'));
    more.addEventListener('click', openMoreSheet);

    bar.append(back, title, sftp, more);
    section.prepend(bar);

    const refresh = rafThrottle(() => {
      const tabs = listTabs();
      const currentId = activeTabId();
      const index = tabs.findIndex((tab) => tab.id === currentId);
      const tab = index >= 0 ? tabs[index] : null;
      name.textContent = tab?.label ?? st('noSession');
      dot.className = `cs-ob-dot ${stateClass(tab)}`.trim();
      const parts: string[] = [];
      if (tab) {
        const host = hostText(tab);
        if (host) parts.push(host);
        if (tab.state === 'connected' && typeof tab.wsLatency === 'number') parts.push(st('latency', { ms: tab.wsLatency }));
        if (tabs.length > 1) parts.push(st('sessionIndex', { i: index + 1, n: tabs.length }));
      }
      sub.textContent = parts.join(' · ');
      sub.hidden = !parts.length;
      title.setAttribute('aria-label', `${name.textContent} ${sub.textContent}`.trim());
      sftp.classList.toggle('is-unavailable', !tab?.sftpPanel);
      back.setAttribute('aria-label', st('back'));
      back.title = st('back');
      sftp.setAttribute('aria-label', st('actSftp'));
      more.setAttribute('aria-label', st('more'));
      more.title = st('more');
    });

    const tabBar = document.getElementById('tab-bar');
    if (tabBar) disposer.observe(tabBar, refresh, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    const statusBar = section.querySelector('.terminal-status-bar');
    if (statusBar) disposer.observe(statusBar, refresh, { childList: true, subtree: true, characterData: true });
    disposer.listen(document, 'cloudssh:active-terminal-change', refresh);
    disposer.add(onLocaleChange(refresh));
    refresh();

    // ---- 标题：点按看全部会话，左右滑动切换会话 ----
    let swipe: { x: number; y: number; time: number; dragging: boolean } | null = null;
    let suppressClick = false;

    const switchBy = (step: 1 | -1) => {
      const tabs = listTabs();
      const index = tabs.findIndex((tab) => tab.id === activeTabId());
      const target = tabs[index + step];
      if (!target) {
        // 已经是第一个/最后一个：轻轻回弹
        animate(text, [{ transform: `translateX(${-step * 14}px)` }, { transform: 'translateX(0)' }], 220);
        return;
      }
      switchToTab(target.id);
      animate(
        text,
        [
          { transform: `translateX(${step * 36}px)`, opacity: 0 },
          { transform: 'translateX(0)', opacity: 1 },
        ],
        220
      );
      animateTerminalEnter(step);
    };

    const resetDrag = () => {
      text.style.transform = '';
      text.style.opacity = '';
    };

    disposer.listen(
      title,
      'touchstart',
      (event) => {
        const touches = (event as TouchEvent).touches;
        if (touches.length !== 1) {
          swipe = null;
          return;
        }
        swipe = { x: touches[0].clientX, y: touches[0].clientY, time: event.timeStamp, dragging: false };
      },
      { passive: true }
    );
    disposer.listen(
      title,
      'touchmove',
      (event) => {
        if (!swipe) return;
        const touch = (event as TouchEvent).touches[0];
        if (!touch) return;
        const dx = touch.clientX - swipe.x;
        const dy = touch.clientY - swipe.y;
        if (!swipe.dragging) {
          if (Math.abs(dx) > SWIPE_SLOP && Math.abs(dx) > Math.abs(dy) * 1.3) swipe.dragging = true;
          else if (Math.abs(dy) > SWIPE_SLOP) {
            swipe = null;
            return;
          } else return;
        }
        event.preventDefault();
        text.style.transform = `translateX(${dx * 0.55}px)`;
        text.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 220));
      },
      { passive: false }
    );
    const endSwipe = (event: Event) => {
      if (!swipe) return;
      const touch = (event as TouchEvent).changedTouches[0];
      const dragging = swipe.dragging;
      const dx = touch ? touch.clientX - swipe.x : 0;
      const speed = Math.abs(dx) / Math.max(1, event.timeStamp - swipe.time);
      swipe = null;
      resetDrag();
      if (!dragging) return;
      suppressClick = true;
      if (event.type === 'touchcancel') return;
      if (Math.abs(dx) > SWIPE_DISTANCE || (speed > SWIPE_FLICK_SPEED && Math.abs(dx) > 24)) switchBy(dx < 0 ? 1 : -1);
      else animate(text, [{ transform: `translateX(${dx * 0.55}px)` }, { transform: 'translateX(0)' }], 180);
    };
    disposer.listen(title, 'touchend', endSwipe);
    disposer.listen(title, 'touchcancel', endSwipe);
    disposer.listen(title, 'click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (listTabs().length) openSessionList();
    });
    // 新的一次按下时清掉“吞点击”标记（滑动后浏览器不一定会派发 click）
    disposer.listen(title, 'pointerdown', () => (suppressClick = false), { capture: true });

    return () => {
      resetDrag();
      disposer.run();
    };
  },
};
