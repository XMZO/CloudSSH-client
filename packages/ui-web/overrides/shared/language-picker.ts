/**
 * 语言按钮：网页版的按钮显示“下一个语言”、点一下轮换到下一个，看不出现在是什么语言。
 * 客户端改为显示当前语言，点开后从全部语言里直接选（当前语言打勾）。
 *
 * - 按钮文字：vite.config.ts 的扩展钩子在网页版刷新按钮时调用 __cloudsshLanguageLabel，这里改成当前语言
 * - 点击：在捕获阶段接管，网页版自己的轮换逻辑不会执行；菜单由各端提供（电脑端下拉菜单，手机端底部面板）
 */
import { getLocale, setLocale, t, type Locale } from '../../upstream/frontend/src/i18n';

export interface LanguageChoice {
  locale: Locale;
  /** 语言自身的名称（与网页版一致，不随界面语言变化） */
  name: string;
}

export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  { locale: 'zh-CN', name: '简体中文' },
  { locale: 'zh-TW', name: '繁體中文' },
  { locale: 'en-US', name: 'English' },
];

export type LanguageMenu = (anchor: HTMLElement, choices: readonly LanguageChoice[], current: Locale, pick: (locale: Locale) => void) => void;

const nameOf = (locale: Locale) => LANGUAGE_CHOICES.find((choice) => choice.locale === locale)?.name ?? locale;

/** “语言：简体中文” */
function describe(locale: Locale): string {
  return `${t('language.label')}${locale.startsWith('zh') ? '：' : ': '}${nameOf(locale)}`;
}

function syncButton(button: HTMLElement): void {
  const current = getLocale();
  const label = button.querySelector<HTMLElement>('[data-language-toggle-label]');
  if (label && label.textContent !== nameOf(current)) label.textContent = nameOf(current);
  button.title = describe(current);
  button.setAttribute('aria-label', describe(current));
  button.setAttribute('aria-haspopup', 'menu');
  delete button.dataset.targetLocale;
}

export function installLanguagePicker(openMenu: LanguageMenu): void {
  (globalThis as { __cloudsshLanguageLabel?: (button: HTMLElement) => void }).__cloudsshLanguageLabel = syncButton;
  // 网页版先于这里挂好了按钮，补刷一次
  document.querySelectorAll<HTMLElement>('[data-language-toggle]').forEach(syncButton);

  document.addEventListener(
    'click',
    (event) => {
      const button = (event.target as Element | null)?.closest<HTMLElement>('[data-language-toggle]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      // 手机上按钮在网页版的“更多”下拉菜单里：上面拦下了点击，菜单不会自己收起，这里替它收起
      const dropdown = button.closest('#user-space-header-actions');
      if (dropdown?.classList.contains('is-open')) {
        dropdown.classList.remove('is-open');
        document.getElementById('user-space-more-btn')?.setAttribute('aria-expanded', 'false');
      }
      openMenu(button, LANGUAGE_CHOICES, getLocale(), (locale) => {
        if (locale !== getLocale()) setLocale(locale);
      });
    },
    true
  );
}

// ---------- 电脑端：按钮下方的下拉菜单 ----------

let openPopover: { menu: HTMLElement; anchor: HTMLElement; cleanup: () => void } | null = null;

function closePopover(focusAnchor = false): void {
  if (!openPopover) return;
  const { menu, anchor, cleanup } = openPopover;
  openPopover = null;
  cleanup();
  menu.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (focusAnchor) anchor.focus();
}

export const popoverLanguageMenu: LanguageMenu = (anchor, choices, current, pick) => {
  const reopen = openPopover?.anchor === anchor;
  closePopover();
  if (reopen) return; // 再点一次按钮 = 收起

  const menu = document.createElement('div');
  menu.className = 'cs-lang-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('language.label'));
  for (const choice of choices) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cs-lang-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(choice.locale === current));
    item.lang = choice.locale;
    const mark = document.createElement('span');
    mark.className = 'material-symbols-outlined';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = choice.locale === current ? 'check' : '';
    item.append(mark, document.createTextNode(choice.name));
    item.addEventListener('click', () => {
      closePopover(true);
      pick(choice.locale);
    });
    menu.append(item);
  }
  document.body.append(menu);

  // 默认贴着按钮下沿右对齐，放不下时往上弹
  const rect = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right - size.width, innerWidth - size.width - 8));
  const top = rect.bottom + 6 + size.height <= innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - 6 - size.height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const items = [...menu.querySelectorAll<HTMLElement>('.cs-lang-item')];
  (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (menu.contains(target) || anchor.contains(target))) return;
    closePopover();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePopover(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
    }
  };
  const onClose = () => closePopover();
  document.addEventListener('pointerdown', onPointerDown, true);
  menu.addEventListener('keydown', onKeyDown);
  window.addEventListener('blur', onClose);
  window.addEventListener('resize', onClose);
  openPopover = {
    menu,
    anchor,
    cleanup: () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    },
  };
};
