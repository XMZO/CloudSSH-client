/**
 * 标题栏右侧的“设置”面板（工作台主题）：网页版顶栏收起后，原来顶栏上的东西都在这里——
 * 界面主题（工作台 / 经典）、配色、语言、AI 设置、关键词高亮、实例管理、退出登录。
 * 配色与 AI 设置、退出登录直接操作网页版自己的控件，行为与网页版一致。
 */
import { getLocale, setLocale } from '../../upstream/frontend/src/i18n';
import { LANGUAGE_CHOICES } from '../shared/language-picker';
import { notificationsEnabled, setNotificationsEnabled } from '../shared/session-notify';
import { openPresetManager, presetText } from '../shared/credential-presets';
import { openHighlightEditor } from '../shared/terminal';
import { ht } from '../shared/terminal/i18n';
import { el, icon } from './dom';
import { dt } from './i18n';
import { closePopover, isPopoverOpenFor, openPopover } from './popover';
import { clickById, desktopSkin, setDesktopSkin, type DesktopSkin } from './state';

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

function action(iconName: string, label: string, run: () => void, danger = false): HTMLButtonElement {
  const button = el('button', danger ? 'cs-dk-action is-danger' : 'cs-dk-action');
  button.type = 'button';
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
    const user = userCard();
    if (user) panel.append(user);

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
    panel.append(skin);

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
      panel.append(colors);
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
    panel.append(language);

    const notices = section(dt('notifications'));
    notices.title = dt('notificationsHint');
    notices.append(
      choiceRow(
        [
          { value: 'on', label: dt('notificationsOn'), hint: dt('notificationsHint') },
          { value: 'off', label: dt('notificationsOff') },
        ],
        notificationsEnabled() ? 'on' : 'off',
        (value) => setNotificationsEnabled(value === 'on')
      )
    );
    panel.append(notices);

    const actions = el('div', 'cs-dk-actions');
    const ai = document.getElementById('ai-config-btn');
    if (ai && loggedIn()) actions.append(action('psychology', dt('aiSettings'), () => ai.click()));
    actions.append(action('format_color_text', ht('title'), () => openHighlightEditor()));
    actions.append(action('key', presetText('title'), () => void openPresetManager()));
    const bridge = window.cloudsshDesktop;
    if (bridge?.openInstanceManager) actions.append(action('dns', dt('instanceManager'), () => void bridge.openInstanceManager?.()));
    if (loggedIn() && document.getElementById('logout-btn')) actions.append(action('logout', dt('logout'), () => clickById('logout-btn'), true));
    panel.append(actions);
  });
}
