/**
 * 标题栏右侧的“设置”面板（工作台主题）：网页版顶栏收起后，原来顶栏上的东西都在这里——
 * 界面主题（工作台 / 经典）、配色、语言、后台通知、自动关闭标签，以及 AI 设置、命令行与 Skill、关键词高亮、凭据预设、
 * 同步到手机、实例管理、退出登录。配色与 AI 设置、退出登录直接操作网页版自己的控件，行为与网页版一致。
 *
 * 排版：不折叠、不分页，窄而不高——顶部一行是用户与退出登录；中间一栏，每项的标题与选项同一行（标题对齐成一列，
 * 选项多时在右侧换行），后台通知的分项开关排成一行；底部的功能按钮每行三个。
 * 各语言同一个宽度、同样的行数（较长的名字用短名，全名悬停可见），切换语言时面板原地换上新文字、布局不动。
 */
import { getLocale, setLocale } from '../../upstream/frontend/src/i18n';
import { LANGUAGE_CHOICES } from '../shared/language-picker';
import {
  NOTICE_KINDS,
  noticeKindEnabled,
  noticeKindText,
  notificationsEnabled,
  setNoticeKindEnabled,
  setNotificationsEnabled,
} from '../shared/session-notify';
import { openPresetManager, presetText } from '../shared/credential-presets';
import { qt } from '../shared/qr-sync/i18n';
import { openQrSync } from './qr-sync';
import { closeOnEnd, END_KINDS, serverEndText, setCloseOnEnd } from '../shared/session-end';
import { DRAWERS, drawerLabel, keepDrawer, setKeepDrawer } from './drawer-follow';
import { openHighlightEditor } from '../shared/terminal';
import { ht } from '../shared/terminal/i18n';
import { el, icon } from './dom';
import { dt, onLocaleChange } from './i18n';
import { closePopover, isPopoverOpenFor, openPopover } from './popover';
import { clickById, desktopSkin, setDesktopSkin, type DesktopSkin } from './state';

/** 一项设置：标题在左、内容在右（同一行，内容多时在右侧换行）；所有标题对齐成一列（见 .cs-dk-set-list） */
function section(title: string, ...content: HTMLElement[]): HTMLElement {
  const box = el('div', 'cs-dk-set-section');
  const body = el('div', 'cs-dk-set-body');
  body.append(...content);
  box.append(el('div', 'cs-dk-set-title', title), body);
  return box;
}

function choiceRow<T extends string>(items: { value: T; label: string; hint?: string }[], current: T, pick: (value: T) => void): HTMLElement {
  const row = el('div', 'cs-dk-choices');
  row.setAttribute('role', 'radiogroup');
  for (const item of items) {
    const button = el('button', 'cs-dk-choice', item.label);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(item.value === current));
    if (item.hint) button.title = item.hint;
    button.classList.toggle('is-on', item.value === current);
    button.addEventListener('click', () => {
      row.querySelectorAll<HTMLElement>('.cs-dk-choice').forEach((node) => {
        const on = node === button;
        node.classList.toggle('is-on', on);
        node.setAttribute('aria-checked', String(on));
      });
      pick(item.value);
    });
    row.append(button);
  }
  return row;
}

function action(iconName: string, label: string, run: () => void, danger = false, hint = ''): HTMLButtonElement {
  const button = el('button', danger ? 'cs-dk-action is-danger' : 'cs-dk-action');
  button.type = 'button';
  if (hint) button.title = hint;
  button.append(icon(iconName), el('span', '', label));
  // 每行三个，英文等较长的名字可能被省略：悬停能看到全名
  if (!hint) button.title = label;
  button.addEventListener('click', () => {
    closePopover();
    run();
  });
  return button;
}

/** 网页版的配色选择框（顶栏里那个，收起后仍在页面上） */
function themeSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>('#user-theme-selector, #theme-selector');
}

function loggedIn(): boolean {
  return !!document.getElementById('user-info')?.textContent?.trim();
}

function userCard(): HTMLElement | null {
  const info = document.getElementById('user-info');
  // 网页版的结构：头像（图片或首字母）+ 用户名
  const name = (info?.querySelector('.user-avatar ~ span, img ~ span') ?? info?.lastElementChild)?.textContent?.trim();
  if (!info || !name) return null;
  const card = el('div', 'cs-dk-user');
  const avatarSrc = info.querySelector('img')?.getAttribute('src');
  if (avatarSrc) {
    const img = el('img', 'cs-dk-avatar');
    img.src = avatarSrc;
    img.alt = '';
    card.append(img);
  } else {
    card.append(el('span', 'cs-dk-avatar is-initial', name.slice(0, 1).toUpperCase()));
  }
  card.append(el('span', 'cs-dk-user-name', name));
  return card;
}

function buildSettings(panel: HTMLElement): void {
  // 顶部：用户 + 退出登录（同一行）
  const user = userCard();
  const canLogout = loggedIn() && !!document.getElementById('logout-btn');
  if (user || canLogout) {
    const head = el('div', 'cs-dk-set-head');
    if (user) head.append(user);
    if (canLogout) head.append(action('logout', dt('logout'), () => clickById('logout-btn'), true));
    panel.append(head);
  }
  const list = el('div', 'cs-dk-set-list');

  list.append(
    section(
      dt('skin'),
      choiceRow<DesktopSkin>(
        [
          { value: 'workbench', label: dt('skinWorkbench'), hint: dt('skinWorkbenchDesc') },
          { value: 'classic', label: dt('skinClassic'), hint: dt('skinClassicDesc') },
        ],
        desktopSkin(),
        (value) => {
          closePopover();
          setDesktopSkin(value);
        }
      )
    )
  );

  const select = themeSelect();
  if (select) {
    list.append(
      section(
        dt('colors'),
        choiceRow(
          [...select.options].map((option) => ({ value: option.value, label: option.textContent?.trim() || option.value })),
          select.value,
          (value) => {
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        )
      )
    );
  }

  const languages = choiceRow(
    LANGUAGE_CHOICES.map((choice) => ({ value: choice.locale, label: choice.name })),
    getLocale(),
    (locale) => {
      if (locale !== getLocale()) setLocale(locale);
    }
  );
  languages.classList.add('cs-dk-languages');
  list.append(section(dt('language'), languages));

  // 后台通知：总开关 + 三个分项（分项排成一行，总开关关掉时变灰）
  const kinds = el('div', 'cs-dk-checks');
  const syncKinds = () => {
    const off = !notificationsEnabled();
    kinds.classList.toggle('is-off', off);
    kinds.querySelectorAll('input').forEach((box) => (box.disabled = off));
  };
  const noticeSwitch = choiceRow(
    [
      { value: 'on', label: dt('notificationsOn'), hint: dt('notificationsHint') },
      { value: 'off', label: dt('notificationsOff') },
    ],
    notificationsEnabled() ? 'on' : 'off',
    (value) => {
      setNotificationsEnabled(value === 'on');
      syncKinds();
    }
  );
  for (const kind of NOTICE_KINDS) {
    const { title, short, hint } = noticeKindText(kind);
    const row = el('label', 'cs-dk-check');
    row.title = `${title}\n${hint}`;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = noticeKindEnabled(kind);
    box.addEventListener('change', () => setNoticeKindEnabled(kind, box.checked));
    row.append(box, el('span', '', short));
    kinds.append(row);
  }
  syncKinds();
  const notices = section(dt('notifications'), noticeSwitch, kinds);
  notices.title = dt('notificationsHint');
  list.append(notices);

  // 关闭标签：退出会话时、服务器重启或关机时自动关闭（两个开关排成一行）
  const endings = el('div', 'cs-dk-checks');
  for (const kind of END_KINDS) {
    const { title, short, hint } = serverEndText(kind);
    const row = el('label', 'cs-dk-check');
    row.title = `${title}\n${hint}`;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = closeOnEnd(kind);
    box.addEventListener('change', () => setCloseOnEnd(kind, box.checked));
    row.append(box, el('span', '', short));
    endings.append(row);
  }
  list.append(section(dt('sessionSection'), endings));

  // 保持面板：SFTP、自定义命令、AI 助手各一个开关（默认关），切换会话、连接新服务器时保持打开
  const keeps = el('div', 'cs-dk-checks');
  for (const drawer of DRAWERS) {
    const row = el('label', 'cs-dk-check');
    row.title = dt('keepHint');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = keepDrawer(drawer);
    box.addEventListener('change', () => setKeepDrawer(drawer, box.checked));
    row.append(box, el('span', '', drawerLabel(drawer)));
    keeps.append(row);
  }
  const keepSection = section(dt('keepSection'), keeps);
  keepSection.title = dt('keepHint');
  list.append(keepSection);
  panel.append(list);

  // 功能按钮：排成网格
  const actions = el('div', 'cs-dk-actions');
  const ai = document.getElementById('ai-config-btn');
  if (ai && loggedIn()) actions.append(action('psychology', dt('aiSettings'), () => ai.click()));
  const bridge = window.cloudsshDesktop;
  if (bridge?.openInstanceManager) {
    actions.append(action('terminal', dt('cliSkill'), () => void bridge.openInstanceManager?.('cli'), false, dt('cliSkillHint')));
  }
  actions.append(action('format_color_text', dt('actHighlight'), () => openHighlightEditor(), false, ht('title')));
  actions.append(action('key', dt('actPresets'), () => void openPresetManager(), false, presetText('title')));
  actions.append(action('qr_code_2', qt('title'), () => void openQrSync()));
  if (bridge?.openInstanceManager) actions.append(action('dns', dt('instanceManager'), () => void bridge.openInstanceManager?.()));
  panel.append(actions);
}

let localeHooked = false;

/** 开着时换了语言：原地换上新文字（宽度各语言一样，位置不动），焦点留在语言选项上 */
function rebuildOnLocaleChange(): void {
  const panel = document.querySelector<HTMLElement>('.cs-dk-popover.cs-dk-settings');
  if (!panel) return;
  const focused = panel.contains(document.activeElement);
  panel.replaceChildren();
  buildSettings(panel);
  if (focused) panel.querySelector<HTMLElement>('.cs-dk-languages .is-on')?.focus();
}

export function toggleSettings(anchor: HTMLElement): void {
  if (isPopoverOpenFor(anchor)) {
    closePopover();
    return;
  }
  if (!localeHooked) {
    localeHooked = true;
    onLocaleChange(rebuildOnLocaleChange);
  }
  openPopover(anchor, 'cs-dk-settings', buildSettings);
}
