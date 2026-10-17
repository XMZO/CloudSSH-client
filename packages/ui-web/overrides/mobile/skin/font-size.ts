/** 终端字号调节（“更多”面板与设置页共用）：A− / 当前值 / A+ / 自动 */
import { currentTerminalFontSize } from '../../../upstream/frontend/src/terminal-layout';
import { h, icon } from './dom';
import { skinState, SKIN_CHANGED_EVENT, updateSkin } from './engine';
import { st } from './i18n';
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from './state';

export function fontSizeControl(): HTMLElement {
  const row = h('div', 'cs-ob-font');
  const label = h('span', 'cs-ob-font-label', st('fontSize'));
  const minus = h('button', 'cs-ob-font-btn');
  minus.type = 'button';
  minus.setAttribute('aria-label', st('fontSmaller'));
  minus.append(icon('text_decrease'));
  const value = h('span', 'cs-ob-font-value');
  const plus = h('button', 'cs-ob-font-btn');
  plus.type = 'button';
  plus.setAttribute('aria-label', st('fontLarger'));
  plus.append(icon('text_increase'));
  const auto = h('button', 'cs-ob-font-auto', st('fontAuto'));
  auto.type = 'button';

  const effective = () => skinState().fontSize || currentTerminalFontSize();
  const render = () => {
    const { fontSize } = skinState();
    value.textContent = String(effective());
    auto.classList.toggle('is-on', fontSize === 0);
    auto.setAttribute('aria-pressed', String(fontSize === 0));
    minus.disabled = effective() <= FONT_SIZE_MIN;
    plus.disabled = effective() >= FONT_SIZE_MAX;
  };
  const step = (delta: number) => {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, effective() + delta));
    updateSkin((draft) => {
      draft.fontSize = next;
    });
  };
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));
  auto.addEventListener('click', () =>
    updateSkin((draft) => {
      draft.fontSize = 0;
    })
  );

  // 控件可能被移出页面（面板关闭），用 isConnected 判断后自动解除监听
  const onChange = () => {
    if (!row.isConnected) {
      window.removeEventListener(SKIN_CHANGED_EVENT, onChange);
      return;
    }
    render();
  };
  window.addEventListener(SKIN_CHANGED_EVENT, onChange);

  const stepper = h('div', 'cs-ob-font-stepper');
  stepper.append(minus, value, plus);
  row.append(label, stepper, auto);
  render();
  return row;
}
