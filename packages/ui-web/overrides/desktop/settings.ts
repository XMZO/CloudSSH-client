/**
 * 标题栏右侧的“设置”面板（工作台主题）：网页版顶栏收起后，原来顶栏上的东西都在这里——
 * 界面主题（工作台 / 经典）、配色、语言、后台通知、会话，以及 AI 设置、命令行与 Skill、关键词高亮、凭据预设、
 * 同步到手机、实例管理、退出登录。配色与 AI 设置、退出登录直接操作网页版自己的控件，行为与网页版一致。
 *
 * 排版：不折叠、不分页，靠横向摆放压低高度——顶部一行是用户与退出登录；中间两栏（左：界面、配色、语言；
 * 右：后台通知、会话），每项的标题与选项同一行；底部的功能按钮排成网格。窗口窄时两栏自动叠成一栏。
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

/** 一项设置：标题在左、选项在右（同一行，选项多时在右侧换行） */
function section(title: string): HTMLElement {
  const box = el('div', 'cs-dk-set-section');
  box.append(el('div', 'cs-dk-set-title', title));
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
    const columns = el('div', 'cs-dk-set-columns');
    const left = el('div', 'cs-dk-set-column');
    const right = el('div', 'cs-dk-set-column');
    columns.append(left, right);

    const skin = section(dt('skin'));
    skin.append(
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
    );
    left.append(skin);

    const select = themeSelect();
    if (select) {
      const colors = section(dt('colors'));
      colors.append(
        choiceRow(
          [...select.options].map((option) => ({ value: option.value, label: option.textContent?.trim() || option.value })),
          select.value,
          (value) => {
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        )
      );
      left.append(colors);
    }

    const language = section(dt('language'));
    language.append(
      choiceRow(
        LANGUAGE_CHOICES.map((choice) => ({ value: choice.locale, label: choice.name })),
        getLocale(),
        (locale) => {
          if (locale !== getLocale()) setLocale(locale);
        }
      )
    );
    left.append(language);

    // 后台通知：总开关 + 三个分项（总开关关掉时分项变灰）
    const notices = section(dt('notifications'));
    notices.title = dt('notificationsHint');
    const kinds = el('div', 'cs-dk-checks');
    const syncKinds = () => {
      const off = !notificationsEnabled();
      kinds.classList.toggle('is-off', off);
      kinds.querySelectorAll('input').forEach((box) => (box.disabled = off));
    };
    notices.append(
      choiceRow(
        [
          { value: 'on', label: dt('notificationsOn'), hint: dt('notificationsHint') },
          { value: 'off', label: dt('notificationsOff') },
        ],
        notificationsEnabled() ? 'on' : 'off',
        (value) => {
          setNotificationsEnabled(value === 'on');
          syncKinds();
        }
      )
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
    right.append(notices, kinds);

    // 会话：服务器端断开时自动关闭标签
    const sessions = section(dt('sessionSection'));
    const ending = serverEndText();
    const endRow = el('label', 'cs-dk-check');
    endRow.title = ending.hint;
    const endBox = el('input');
    endBox.type = 'checkbox';
    endBox.checked = closeOnServerEnd();
    endBox.addEventListener('change', () => setCloseOnServerEnd(endBox.checked));
    endRow.append(endBox, el('span', '', ending.title));
    // 只有一个选项：放在标题同一行
    endRow.classList.add('is-inline');
    sessions.append(endRow);
    right.append(sessions);
    panel.append(columns);

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
