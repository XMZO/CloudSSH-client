/**
 * 终端字号调节（“更多”面板与设置页共用）：A− / 当前值 / A+ / 自动。
 * withLabel 为 false 时只返回控件本身（设置页的行自己带标题）。
 * 连点 A− / A+ 时画面先按比例预览，停手后才应用（只重排一次，见 ./font-apply.ts）。
 */
import { currentTerminalFontSize } from '../../../upstream/frontend/src/terminal-layout';
import { h, icon } from './dom';
import { skinState, SKIN_CHANGED_EVENT } from './engine';
import { cancelScheduledFontSize, clearFontPreview, commitFontSize, scheduleFontSize } from './font-apply';
import { st } from './i18n';
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from './state';

export function fontSizeControl(withLabel = true): HTMLElement {
  const row = h('div', withLabel ? 'cs-ob-font' : 'cs-set-font');
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

  /** 点了还没应用的字号 */
  let pending: number | null = null;
  const effective = () => pending ?? (skinState().fontSize || currentTerminalFontSize());
  const render = () => {
    const { fontSize } = skinState();
    value.textContent = String(effective());
    const isAuto = pending === null && fontSize === 0;
    auto.classList.toggle('is-on', isAuto);
    auto.setAttribute('aria-pressed', String(isAuto));
    minus.disabled = effective() <= FONT_SIZE_MIN;
    plus.disabled = effective() >= FONT_SIZE_MAX;
  };
  const step = (delta: number) => {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, effective() + delta));
    pending = next;
    render();
    scheduleFontSize(next, () => {
      pending = null;
      if (row.isConnected) render();
    });
  };
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));
  auto.addEventListener('click', () => {
    pending = null;
    cancelScheduledFontSize();
    clearFontPreview();
    commitFontSize(0);
    render();
  });

  // 控件可能被移出页面（面板关闭），用 isConnected 判断后自动解除监听
  const onChange = () => {
    if (!row.isConnected) {
      window.removeEventListener(SKIN_CHANGED_EVENT, onChange);
      return;
    }
    // 已应用（保存）：不再有待应用的字号
    pending = null;
    render();
  };
  window.addEventListener(SKIN_CHANGED_EVENT, onChange);

  const stepper = h('div', 'cs-ob-font-stepper');
  stepper.append(minus, value, plus);
  if (withLabel) row.append(label);
  row.append(stepper, auto);
  render();
  return row;
}
