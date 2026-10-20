/**
 * 标题栏右侧的“设置”面板（工作台主题）：网页版顶栏收起后，原来顶栏上的东西都在这里——
 * 界面主题（工作台 / 经典）、配色、语言、后台通知、会话，以及 AI 设置、命令行与 Skill、关键词高亮、凭据预设、
 * 同步到手机、实例管理、退出登录。配色与 AI 设置、退出登录直接操作网页版自己的控件，行为与网页版一致。
 *
 * 排版：不折叠、不分页，窄而不高——顶部一行是用户与退出登录；中间一栏，每项的标题与选项同一行（标题对齐成一列，
 * 选项多时在右侧换行），后台通知的分项开关排成一行；底部的功能按钮每行三个。
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
import { closeOnServerEnd, serverEndText, setCloseOnServerEnd } from '../shared/session-end';
import { openHighlightEditor } from '../shared/terminal';
import { ht } from '../shared/terminal/i18n';
import { el, icon } from './dom';
import { dt } from './i18n';
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

export function toggleSettings(anchor: HTMLElement): void {
  if (isPopoverOpenFor(anchor)) {
    closePopover();
    return;
  }
  openPopover(anchor, 'cs-dk-settings', (panel) => {
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

    list.append(
      section(
        dt('language'),
        choiceRow(
          LANGUAGE_CHOICES.map((choice) => ({ value: choice.locale, label: choice.name })),
          getLocale(),
          (locale) => {
            if (locale !== getLocale()) setLocale(locale);
          }
        )
      )
    );

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
      const { title, hint } = noticeKindText(kind);
      const row = el('label', 'cs-dk-check');
      row.title = hint;
      const box = el('input');
      box.type = 'checkbox';
      box.checked = noticeKindEnabled(kind);
      box.addEventListener('change', () => setNoticeKindEnabled(kind, box.checked));
      row.append(box, el('span', '', title));
      kinds.append(row);
    }
    syncKinds();
    const notices = section(dt('notifications'), noticeSwitch, kinds);
    notices.title = dt('notificationsHint');
    list.append(notices);

    // 会话：服务器端断开时自动关闭标签
    const ending = serverEndText();
    const endRow = el('label', 'cs-dk-check');
    endRow.title = ending.hint;
    const endBox = el('input');
    endBox.type = 'checkbox';
    endBox.checked = closeOnServerEnd();
    endBox.addEventListener('change', () => setCloseOnServerEnd(endBox.checked));
    endRow.append(endBox, el('span', '', ending.title));
    list.append(section(dt('sessionSection'), endRow));
    panel.append(list);

    // 功能按钮：排成网格
    const actions = el('div', 'cs-dk-actions');
    const ai = document.getElementById('ai-config-btn');
    if (ai && loggedIn()) actions.append(action('psychology', dt('aiSettings'), () => ai.click()));
    const bridge = window.cloudsshDesktop;
    if (bridge?.openInstanceManager) {
      actions.append(action('terminal', dt('cliSkill'), () => void bridge.openInstanceManager?.('cli'), false, dt('cliSkillHint')));
    }
    actions.append(action('format_color_text', ht('title'), () => openHighlightEditor()));
    actions.append(action('key', presetText('title'), () => void openPresetManager()));
    actions.append(action('qr_code_2', qt('title'), () => void openQrSync()));
    if (bridge?.openInstanceManager) actions.append(action('dns', dt('instanceManager'), () => void bridge.openInstanceManager?.()));
    panel.append(actions);
  });
}
