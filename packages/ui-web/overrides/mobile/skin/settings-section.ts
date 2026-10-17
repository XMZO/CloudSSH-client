/** 设置页的“界面主题”分区：主题选择、强调色、终端字号、布局模块开关、恢复默认 */
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import { h, icon } from './dom';
import { resetSkin, skinState, SKIN_CHANGED_EVENT, updateSkin } from './engine';
import { fontSizeControl } from './font-size';
import { st, type SkinKey } from './i18n';
import { ACCENT_COLORS } from './palette-data';
import { ACCENT_IDS, MODULE_IDS, type SkinId } from './state';
import './settings-section.css';

function themeCard(id: SkinId, current: SkinId): HTMLButtonElement {
  const card = h('button', `cs-ob-theme-card is-${id}`);
  card.type = 'button';
  card.setAttribute('aria-pressed', String(id === current));
  card.classList.toggle('is-selected', id === current);
  const preview = h('span', 'cs-ob-theme-preview');
  preview.setAttribute('aria-hidden', 'true');
  preview.append(h('span', 'cs-ob-theme-preview-bar'), h('span', 'cs-ob-theme-preview-line'), h('span', 'cs-ob-theme-preview-line is-short'), h('span', 'cs-ob-theme-preview-key'));
  const name = h('span', 'cs-ob-theme-name', st(id));
  if (id === 'obsidian') name.append(h('span', 'cs-ob-theme-badge', st('newBadge')));
  card.append(preview, name, h('span', 'cs-ob-theme-desc', st(id === 'obsidian' ? 'obsidianDesc' : 'classicDesc')));
  card.addEventListener('click', () => {
    if (skinState().skin === id) return;
    updateSkin((draft) => {
      draft.skin = id;
    });
  });
  return card;
}

function moduleSwitch(id: (typeof MODULE_IDS)[number], on: boolean): HTMLElement {
  const row = h('label', 'cs-ob-module');
  const text = h('span', 'cs-ob-module-text');
  text.append(h('span', 'cs-ob-module-title', st(`mod_${id}` as SkinKey)), h('span', 'cs-ob-module-desc', st(`mod_${id}_desc` as SkinKey)));
  const input = h('input', 'cs-ob-switch');
  input.type = 'checkbox';
  input.checked = on;
  input.setAttribute('role', 'switch');
  input.addEventListener('change', () =>
    updateSkin((draft) => {
      draft.modules[id] = input.checked;
    })
  );
  row.append(text, input);
  return row;
}

function render(section: HTMLElement): void {
  const state = skinState();
  const cards = h('div', 'cs-ob-theme-cards');
  cards.append(themeCard('obsidian', state.skin), themeCard('classic', state.skin));
  const parts: HTMLElement[] = [h('h3', 'cs-m-section-title', st('section')), cards];

  if (state.skin === 'obsidian') {
    const accents = h('div', 'cs-ob-accents');
    accents.setAttribute('role', 'radiogroup');
    accents.setAttribute('aria-label', st('accent'));
    for (const id of ACCENT_IDS) {
      const swatch = h('button', 'cs-ob-accent');
      swatch.type = 'button';
      swatch.style.setProperty('--swatch', ACCENT_COLORS[id]);
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-checked', String(state.accent === id));
      swatch.setAttribute('aria-label', st(`accent_${id}` as SkinKey));
      swatch.title = st(`accent_${id}` as SkinKey);
      if (state.accent === id) swatch.append(icon('check'));
      swatch.addEventListener('click', () =>
        updateSkin((draft) => {
          draft.accent = id;
        })
      );
      accents.append(swatch);
    }
    const accentRow = h('div', 'cs-ob-setting-row');
    accentRow.append(h('span', 'cs-ob-setting-label', st('accent')), accents);

    const modules = h('div', 'cs-ob-modules');
    for (const id of MODULE_IDS) modules.append(moduleSwitch(id, state.modules[id]));

    const reset = h('button', 'cs-m-btn cs-ob-reset', st('reset'));
    reset.type = 'button';
    reset.addEventListener('click', () => {
      resetSkin();
      notify(st('resetDone'), { variant: 'success', duration: 1500 });
    });

    parts.push(
      accentRow,
      fontSizeControl(),
      h('h3', 'cs-m-section-title cs-ob-modules-title', st('modules')),
      h('p', 'cs-m-hint', st('modulesHint')),
      modules,
      reset
    );
  }
  section.replaceChildren(...parts);
}

export function skinSettingsSection(): HTMLElement {
  const section = h('section', 'cs-m-section cs-ob-skin-section');
  render(section);
  const onChange = () => {
    if (!section.isConnected) {
      window.removeEventListener(SKIN_CHANGED_EVENT, onChange);
      return;
    }
    render(section);
  };
  window.addEventListener(SKIN_CHANGED_EVENT, onChange);
  return section;
}
