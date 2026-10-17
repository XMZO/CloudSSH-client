/** 设置页的“外观”分组：界面主题、强调色、布局模块开关、恢复默认（后三项只在黑曜主题下显示） */
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import { segmented, settingsGroup, settingsRow, toggleRow } from '../settings-ui';
import { h, icon } from './dom';
import { resetSkin, skinState, SKIN_CHANGED_EVENT, updateSkin } from './engine';
import { st, type SkinKey } from './i18n';
import { ACCENT_COLORS } from './palette-data';
import { ACCENT_IDS, MODULE_IDS, type SkinId, type SkinState } from './state';
import './settings-section.css';

function themeArt(id: SkinId): HTMLElement {
  const art = h('span', `cs-set-theme-art is-${id}`);
  art.setAttribute('aria-hidden', 'true');
  art.append(h('span'), h('span'));
  return art;
}

function accentSwatches(current: SkinState['accent']): HTMLElement {
  const accents = h('div', 'cs-ob-accents cs-set-end');
  accents.setAttribute('role', 'radiogroup');
  accents.setAttribute('aria-label', st('accent'));
  for (const id of ACCENT_IDS) {
    const swatch = h('button', 'cs-ob-accent');
    swatch.type = 'button';
    swatch.style.setProperty('--swatch', ACCENT_COLORS[id]);
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-checked', String(current === id));
    swatch.setAttribute('aria-label', st(`accent_${id}` as SkinKey));
    swatch.title = st(`accent_${id}` as SkinKey);
    if (current === id) swatch.append(icon('check'));
    swatch.addEventListener('click', () =>
      updateSkin((draft) => {
        draft.accent = id;
      })
    );
    accents.append(swatch);
  }
  return accents;
}

function rows(state: SkinState): HTMLElement[] {
  const theme = segmented<SkinId>(
    st('section'),
    [
      { value: 'obsidian', label: st('obsidian'), art: themeArt('obsidian') },
      { value: 'classic', label: st('classic'), art: themeArt('classic') },
    ],
    state.skin,
    (id) => {
      if (skinState().skin === id) return;
      updateSkin((draft) => {
        draft.skin = id;
      });
    }
  );
  const out = [settingsRow({ title: st('section'), end: theme })];
  if (state.skin !== 'obsidian') return out;

  const accentRow = settingsRow({ title: st('accent'), end: accentSwatches(state.accent) });
  accentRow.classList.add('is-accent');
  out.push(accentRow);
  for (const id of MODULE_IDS) {
    const row = toggleRow({
      title: st(`mod_${id}` as SkinKey),
      sub: st(`mod_${id}_desc` as SkinKey),
      checked: state.modules[id],
      onChange: (on) =>
        updateSkin((draft) => {
          draft.modules[id] = on;
        }),
    });
    row.dataset.module = id;
    out.push(row);
  }
  const reset = h('button', 'cs-set-link', st('reset'));
  reset.type = 'button';
  reset.addEventListener('click', () => {
    resetSkin();
    notify(st('resetDone'), { variant: 'success', duration: 1500 });
  });
  out.push(reset);
  return out;
}

export function appearanceGroup(title: string): HTMLElement {
  let rendered = skinState();
  const group = settingsGroup('appearance', title, rows(rendered));
  const card = group.querySelector<HTMLElement>('.cs-set-card')!;

  // 换主题时整组重建；其余变化只同步控件，不打断开关的动画
  const onChange = () => {
    if (!group.isConnected) {
      window.removeEventListener(SKIN_CHANGED_EVENT, onChange);
      return;
    }
    const state = skinState();
    if (state.skin !== rendered.skin) {
      card.replaceChildren(...rows(state));
    } else if (state.skin === 'obsidian') {
      card.querySelectorAll<HTMLElement>('[data-module]').forEach((row) => {
        const input = row.querySelector<HTMLInputElement>('input');
        const id = row.dataset.module as (typeof MODULE_IDS)[number];
        if (input && input.checked !== state.modules[id]) input.checked = state.modules[id];
      });
      if (state.accent !== rendered.accent) card.querySelector('.cs-ob-accents')?.replaceWith(accentSwatches(state.accent));
    }
    rendered = state;
  };
  window.addEventListener(SKIN_CHANGED_EVENT, onChange);
  return group;
}
