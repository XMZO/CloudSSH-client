/**
 * 匿名连接页（网页版的 #auth-section）右上角的设置入口。
 * 设置原来只能从登录后的节点页或终端“更多”里打开：匿名实例不先连上一个会话，就没法切换实例、
 * 添加实例、设代理或改主题。图标与位置和节点页标题栏的设置按钮一致。
 */
import { mt, onLocaleChange } from './i18n';
import { openSettings } from './settings';
import { el, icon } from './sheet';

export function mountAuthSettings(): void {
  const section = document.getElementById('auth-section');
  if (!section || section.querySelector('.cs-m-auth-settings')) return;
  const button = el('button', 'cs-m-auth-settings');
  button.type = 'button';
  button.append(icon('tune'));
  button.addEventListener('click', () => void openSettings());
  const applyTexts = () => {
    button.setAttribute('aria-label', mt('settings'));
    button.title = mt('settings');
  };
  applyTexts();
  onLocaleChange(applyTexts);
  section.append(button);
}
