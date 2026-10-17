/**
 * 手机端终端标签栏：
 * - 一屏放 3 个标签（宽度见 mobile.css），超出横向滚动，当前标签自动滚到可见
 * - 名称“中间省略”：保留开头和最后一段（通常是区分同类服务器的部分，如 “宁宁云…NoLimit”）
 * - 标签栏右侧的会话按钮打开会话列表：完整名称 + 地址 + 状态，点一下切换
 * - 防误触关闭：只有当前标签显示关闭按钮；关闭仍在连接的会话前先确认
 * 网页版每次状态变化都会整体重建标签栏，所以在每次重建后再加工（MutationObserver）。
 */
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { activeTabId, closeTabById, listTabs, sessionNeedsCloseConfirm, switchToTab, type TabInfo } from '../sidebar/hooks';
import { mt } from './i18n';
import { closeSheet, confirmSheet, el, icon, openSheet } from './sheet';

const TAIL_MAX = 8;

/** 拆成 [开头, 结尾]：结尾取最后一个词（太长就取最后 6 个字符），名称很短时不拆 */
export function splitLabel(label: string): [string, string] {
  const text = label.trim();
  if ([...text].length <= 6) return [text, ''];
  const space = text.lastIndexOf(' ');
  let tail = space > 0 ? text.slice(space) : '';
  if (!tail.trim() || [...tail.trim()].length > TAIL_MAX) tail = [...text].slice(-6).join('');
  // 开头与结尾之间的空格交给 CSS 间距，省宽度
  return [text.slice(0, text.length - tail.length).trimEnd(), tail.trimStart()];
}

function decorate(tabBar: HTMLElement): void {
  for (const tab of tabBar.querySelectorAll<HTMLElement>('.tab-item')) {
    const label = tab.querySelector<HTMLElement>('.tab-label');
    if (!label || label.dataset.csSplit !== undefined) continue;
    const [head, tail] = splitLabel(label.textContent ?? '');
    label.dataset.csSplit = '';
    if (!tail) continue;
    label.replaceChildren(el('span', 'cs-m-tab-head', head), el('span', 'cs-m-tab-tail', tail));
  }
  tabBar.querySelector<HTMLElement>('.tab-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** 已经断开（包括重连失败、等待重连）的会话直接关闭，连接还在的才确认 */
async function confirmClose(id: string): Promise<boolean> {
  const tab = listTabs().find((item) => item.id === id);
  if (!sessionNeedsCloseConfirm(tab)) return true;
  return confirmSheet(mt('closeSessionConfirm', { name: tab?.label ?? '' }), mt('closeSession'), mt('cancel'), true);
}

function hostText(tab: TabInfo): string {
  const info = tab.hostInfo;
  if (!info) return '';
  return `${info.username ? `${info.username}@` : ''}${maskIPAddress(info.host) ?? info.host}`;
}

function stateClass(tab: TabInfo): string {
  if (tab.state === 'connected') return 'is-connected';
  if (tab.state === 'connecting') return 'is-connecting';
  return 'is-disconnected';
}

function stateText(tab: TabInfo): string {
  if (tab.state === 'connected') return mt('sessionConnected');
  if (tab.state === 'connecting') return mt('sessionConnecting');
  return mt('sessionDisconnected');
}

/** 会话列表：完整名称、地址与状态 */
export function openSessionList(): void {
  const body = el('div', 'cs-m-sessions');
  {
    const tabs = listTabs();
    const current = activeTabId();
    const list = el('div', 'cs-m-sort-list');
    for (const tab of tabs) {
      const row = el('div', `cs-m-sort-item cs-m-session${tab.id === current ? ' is-current' : ''}`);
      row.setAttribute('role', 'button');
      const text = el('span', 'cs-m-sort-text');
      text.append(el('span', 'cs-m-sort-name', tab.label ?? ''), el('span', 'cs-m-sort-sub', hostText(tab) || stateText(tab)));
      const close = el('button', 'cs-m-session-close');
      close.type = 'button';
      close.setAttribute('aria-label', mt('closeSession'));
      close.append(icon('close'));
      close.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!(await confirmClose(tab.id))) {
          openSessionList();
          return;
        }
        // 已断开的会话不弹确认，列表还开着：先收起，等标签关闭后按剩下的会话重新打开（没有会话了就不再打开）
        closeSheet();
        closeTabById(tab.id);
        setTimeout(() => listTabs().length && openSessionList(), 250);
      });
      row.append(el('span', `cs-m-session-dot ${stateClass(tab)}`), text, close);
      row.addEventListener('click', () => {
        closeSheet();
        switchToTab(tab.id);
      });
      list.append(row);
    }
    const newSession = el('button', 'cs-m-btn cs-m-sort-reset');
    newSession.type = 'button';
    newSession.append(icon('add'), el('span', '', mt('newSession')));
    newSession.addEventListener('click', () => {
      closeSheet();
      document.getElementById('new-tab-btn')?.click();
    });
    body.replaceChildren(tabs.length ? list : el('div', 'cs-m-empty', mt('noSessions')), newSession);
  }
  openSheet(mt('sessionList'), body, { tall: true });
}

export function mountTabs(): void {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar?.parentElement) return;

  // 标签栏右侧的会话按钮：和标签栏包在一起，标签栏本身照常横向滚动
  const wrap = el('div', 'cs-m-tabbar');
  tabBar.before(wrap);
  const button = el('button', 'cs-m-tabs-btn border-b border-outline-variant bg-background');
  button.type = 'button';
  const count = el('span', 'cs-m-tabs-count', '0');
  button.append(icon('tab'), count);
  button.addEventListener('click', () => openSessionList());
  wrap.append(tabBar, button);

  const refresh = () => {
    decorate(tabBar);
    const n = listTabs().length || tabBar.querySelectorAll('.tab-item').length;
    count.textContent = String(n);
    button.setAttribute('aria-label', mt('sessionList'));
    button.title = mt('sessionList');
  };
  new MutationObserver(refresh).observe(tabBar, { childList: true });
  refresh();

  // 关闭按钮：非当前标签的点击当作切换；当前标签的会话仍在连接时先确认
  tabBar.addEventListener(
    'click',
    (event) => {
      const close = (event.target as Element | null)?.closest('.tab-close');
      const tab = close?.closest<HTMLElement>('.tab-item');
      const id = tab?.dataset.tabId;
      if (!close || !tab || !id) return;
      event.preventDefault();
      event.stopPropagation();
      if (!tab.classList.contains('active')) {
        switchToTab(id);
        return;
      }
      void confirmClose(id).then((ok) => ok && closeTabById(id));
    },
    true
  );
}
