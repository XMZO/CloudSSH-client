/**
 * 手机端终端标签栏：
 * - 一屏放 3 个标签（宽度见 mobile.css），超出横向滚动，当前标签自动滚到可见
 * - 名称“中间省略”：保留开头和最后一段（通常是区分同类服务器的部分，如 “宁宁云…NoLimit”）
 * - 标签栏右侧的会话按钮打开会话列表：完整名称 + 地址 + 状态，点一下切换；× 关闭后列表留着、原地刷新，
 *   有已断开的会话时底部可一键全部关闭
 * - 防误触关闭：只有当前标签显示关闭按钮；要确认的会话（“设置 → 关闭会话前确认”，默认只有仍连着的）不弹确认面板，
 *   第一次点把 × 变成红色的“关闭”，3 秒内再点一次才关，过时自动复原
 * 网页版每次状态变化都会整体重建标签栏，所以在每次重建后再加工（MutationObserver）。
 */
import { maskIPAddress } from '../../upstream/frontend/src/host-display';
import { activeTabId, closeTabById, listTabs, switchToTab, type TabInfo } from '../sidebar/hooks';
import { shouldConfirmClose } from './close-confirm';
import { mt } from './i18n';
import { closeSheet, el, icon, openSheet } from './sheet';

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

// ---------- 两步关闭：第一次点变成红色的“关闭”，再点才关 ----------

const ARM_MS = 3000;
/** 一键关闭已断开的会话那个按钮用的 id（不会和标签 id 撞上） */
const ALL_DISCONNECTED = '\0disconnected';
/** 正在等第二次点的那个（标签 id）；标签栏与会话列表共用，标签栏重建后照它重新标上 */
let armed: { id: string; until: number } | null = null;
let armTimer = 0;

function isArmed(id: string): boolean {
  return armed !== null && armed.id === id && Date.now() < armed.until;
}

/** 按当前状态更新页面上所有关闭按钮（带 data-cs-close-id 的） */
function paintArmed(): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-cs-close-id]')) {
    const on = isArmed(button.dataset.csCloseId ?? '');
    button.classList.toggle('is-armed', on);
    let label = button.querySelector<HTMLElement>('.cs-m-close-armed');
    if (on && !label) {
      label = el('span', 'cs-m-close-armed', button.dataset.csArmedLabel ?? mt('closeArmed'));
      button.append(label);
    }
    if (!on) label?.remove();
  }
}

function arm(id: string | null): void {
  window.clearTimeout(armTimer);
  armed = id ? { id, until: Date.now() + ARM_MS } : null;
  if (id) {
    armTimer = window.setTimeout(() => {
      armed = null;
      paintArmed();
    }, ARM_MS);
  }
  paintArmed();
}

/** 点了 ×：要确认且这是第一次点就先变成红色的“关闭”；不用确认或 3 秒内第二次点就关 */
function requestClose(id: string, needsConfirm: boolean, close: () => void): void {
  if (needsConfirm && !isArmed(id)) {
    arm(id);
    return;
  }
  arm(null);
  close();
}

function needsConfirm(id: string): boolean {
  return shouldConfirmClose(listTabs().find((item) => item.id === id));
}

// ---------- 标签栏 ----------

function decorate(tabBar: HTMLElement): void {
  for (const tab of tabBar.querySelectorAll<HTMLElement>('.tab-item')) {
    const close = tab.querySelector<HTMLElement>('.tab-close');
    if (close && tab.dataset.tabId) close.dataset.csCloseId = tab.dataset.tabId;
    const label = tab.querySelector<HTMLElement>('.tab-label');
    if (!label || label.dataset.csSplit !== undefined) continue;
    const [head, tail] = splitLabel(label.textContent ?? '');
    label.dataset.csSplit = '';
    if (!tail) continue;
    label.replaceChildren(el('span', 'cs-m-tab-head', head), el('span', 'cs-m-tab-tail', tail));
  }
  paintArmed();
  tabBar.querySelector<HTMLElement>('.tab-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- 会话列表 ----------

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

/** 已断开（不在连接中、也没在重连）的会话 */
function disconnectedTabs(): TabInfo[] {
  return listTabs().filter((tab) => tab.state !== 'connected' && tab.state !== 'connecting');
}

/** 会话列表：完整名称、地址与状态；关闭后列表原地刷新，关完最后一个才收起 */
export function openSessionList(): void {
  const body = el('div', 'cs-m-sessions');
  const afterClose = () => {
    if (listTabs().length) render();
    else closeSheet();
  };
  const render = () => {
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
      close.dataset.csCloseId = tab.id;
      close.setAttribute('aria-label', mt('closeSession'));
      close.append(icon('close'));
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        requestClose(tab.id, needsConfirm(tab.id), () => {
          closeTabById(tab.id);
          afterClose();
        });
      });
      row.append(el('span', `cs-m-session-dot ${stateClass(tab)}`), text, close);
      row.addEventListener('click', () => {
        closeSheet();
        switchToTab(tab.id);
      });
      list.append(row);
    }
    const actions: HTMLElement[] = [];
    const dead = disconnectedTabs();
    if (dead.length) {
      const closeDead = el('button', 'cs-m-btn cs-m-sort-reset cs-m-close-dead');
      closeDead.type = 'button';
      closeDead.dataset.csCloseId = ALL_DISCONNECTED;
      closeDead.dataset.csArmedLabel = mt('closeDisconnectedAgain', { n: dead.length });
      closeDead.append(icon('link_off'), el('span', '', mt('closeDisconnected', { n: dead.length })));
      closeDead.addEventListener('click', () => {
        // 已断开的默认不用确认；“总是确认”时同样两步
        const confirm = disconnectedTabs().some((tab) => shouldConfirmClose(tab));
        requestClose(ALL_DISCONNECTED, confirm, () => {
          for (const tab of disconnectedTabs()) closeTabById(tab.id);
          afterClose();
        });
      });
      actions.push(closeDead);
    }
    const newSession = el('button', 'cs-m-btn cs-m-sort-reset');
    newSession.type = 'button';
    newSession.append(icon('add'), el('span', '', mt('newSession')));
    newSession.addEventListener('click', () => {
      closeSheet();
      document.getElementById('new-tab-btn')?.click();
    });
    actions.push(newSession);
    body.replaceChildren(tabs.length ? list : el('div', 'cs-m-empty', mt('noSessions')), ...actions);
    paintArmed();
  };
  render();
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

  // 关闭按钮：非当前标签的点击当作切换；当前标签要确认时先变成红色的“关闭”，再点才关
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
      requestClose(id, needsConfirm(id), () => closeTabById(id));
    },
    true
  );
}
